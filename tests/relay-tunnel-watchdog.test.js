'use strict'

const test = require('node:test')
const assert = require('node:assert')
const tls = require('tls')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { connectTunnel } = require('../relay/client')

/**
 * #192146: a tunnel process that is alive but not registered, and stays that way. Measured on
 * iris-hive-001: control connection ESTABLISHED for 35 hours with nothing received, relay reporting
 * zero tunnels. These drive the real client over real TLS against a scripted relay, because the
 * point is what the client does when the relay goes quiet, or refuses it.
 */

function relayCert () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
    '-subj', '/CN=relay.t.test', '-addext', 'subjectAltName=DNS:relay.t.test', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' })
  return { cert: fs.readFileSync(path.join(dir, 'c.pem')), key: fs.readFileSync(path.join(dir, 'k.pem')) }
}
const CERT = relayCert()

/** A relay that follows `onHello(n, msg, sock)` and never pings: the silence of a dead connection. */
async function scriptedRelay (onHello) {
  const seen = { hellos: [], idle: [], sockets: new Set() }
  const server = tls.createServer({ cert: CERT.cert, key: CERT.key }, (s) => {
    seen.sockets.add(s)
    s.on('error', () => {})
    s.on('close', () => seen.sockets.delete(s))
    let buf = ''
    s.on('data', (d) => {
      buf += d
      const i = buf.indexOf('\n')
      if (i < 0) return
      const msg = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      if (msg.op === 'hello') { seen.hellos.push(msg); onHello(seen.hellos.length, msg, s) }
      if (msg.op === 'idle') seen.idle.push({ session: msg.session, sock: s })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { seen, port: server.address().port, close () { for (const s of seen.sockets) s.destroy(); server.close() } }
}

const ok = (s, session) => s.write(JSON.stringify({ op: 'ok', host: 'demo.t.test', session }) + '\n')
const refuse = (s, error) => { s.write(JSON.stringify({ op: 'err', error }) + '\n'); s.end() }

const waitFor = async (cond, ms = 4000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 20)) }
  return false
}

const open = (relay, extra = {}) => connectTunnel({
  relay: { host: '127.0.0.1', port: relay.port },
  relayHost: 'relay.t.test',
  relayCa: CERT.cert,
  name: 'demo',
  target: { host: '127.0.0.1', port: 9 },
  reconnect: true,
  poolSize: 0,
  ...extra
})

test('a control connection that goes silent is dropped and registered again', async (t) => {
  const relay = await scriptedRelay((n, _m, s) => ok(s, `s${n}`))
  t.after(() => relay.close())
  const tun = await open(relay, { token: 'x', silenceMs: 150 })
  t.after(() => tun.close())
  assert.ok(await waitFor(() => relay.seen.hellos.length >= 2), 'it should have reconnected after going unheard')
})

test('pings keep a quiet tunnel up: silence is the trigger, not age', async (t) => {
  const relay = await scriptedRelay((n, _m, s) => {
    ok(s, `s${n}`)
    const beat = setInterval(() => { if (!s.destroyed) s.write('{"op":"ping"}\n') }, 40)
    s.on('close', () => clearInterval(beat))
  })
  t.after(() => relay.close())
  const tun = await open(relay, { token: 'x', silenceMs: 200 })
  t.after(() => tun.close())
  await new Promise((r) => setTimeout(r, 700))
  assert.strictEqual(relay.seen.hellos.length, 1)
})

test('a new session gets a fresh warm pool: the old one\'s parked connections are let go', async (t) => {
  const relay = await scriptedRelay((n, _m, s) => {
    ok(s, `s${n}`)
    if (n === 1) setTimeout(() => s.destroy(), 150)
  })
  t.after(() => relay.close())
  const tun = await open(relay, { token: 'x', poolSize: 2 })
  t.after(() => tun.close())
  assert.ok(await waitFor(() => relay.seen.idle.filter((i) => i.session === 's2').length === 2), 'the second session should have its own pool')
  assert.ok(await waitFor(() => relay.seen.idle.filter((i) => i.session === 's1').every((i) => i.sock.destroyed)), 'the first session\'s pool should be closed')
})

test('"name in use" on a reconnect is the relay catching up, not a final answer', async (t) => {
  const relay = await scriptedRelay((n, _m, s) => {
    if (n === 2) return refuse(s, 'name in use')
    ok(s, `s${n}`)
    if (n === 1) setTimeout(() => s.destroy(), 50)
  })
  t.after(() => relay.close())
  const tun = await open(relay, { getToken: async () => 'x' })
  t.after(() => tun.close())
  assert.ok(await waitFor(() => relay.seen.hellos.length >= 3), 'it should keep trying after the refusal')
})

test('a token the API could not supply is retried, never sent as an empty hello', async (t) => {
  let calls = 0
  const relay = await scriptedRelay((n, m, s) => {
    if (!m.token) return refuse(s, 'bad token')
    ok(s, `s${n}`)
    if (n === 1) setTimeout(() => s.destroy(), 50)
  })
  t.after(() => relay.close())
  const tun = await open(relay, { getToken: async () => { if (++calls === 2) throw new Error('HTTP 502'); return 'x' } })
  t.after(() => tun.close())
  assert.ok(await waitFor(() => relay.seen.hellos.length >= 2), 'it should register again once the API answers')
  assert.ok(relay.seen.hellos.every((h) => h.token), 'no hello goes out without a token')
})

test('still final: a refused first registration, a suspended name, and a final answer from IRIS', async (t) => {
  const first = await scriptedRelay((_n, _m, s) => refuse(s, 'name in use'))
  t.after(() => first.close())
  await assert.rejects(open(first, { getToken: async () => 'x' }), /name in use/)
  await new Promise((r) => setTimeout(r, 400))
  assert.strictEqual(first.seen.hellos.length, 1)

  const suspended = await scriptedRelay((n, _m, s) => {
    if (n === 2) return refuse(s, 'name in use: suspended by the operator')
    ok(s, `s${n}`)
    if (n === 1) setTimeout(() => s.destroy(), 30)
  })
  t.after(() => suspended.close())
  const tun = await open(suspended, { getToken: async () => 'x' })
  t.after(() => tun.close())
  await waitFor(() => suspended.seen.hellos.length >= 2)
  await new Promise((r) => setTimeout(r, 500))
  assert.strictEqual(suspended.seen.hellos.length, 2)

  let calls = 0
  const revoked = await scriptedRelay((n, _m, s) => { ok(s, `s${n}`); if (n === 1) setTimeout(() => s.destroy(), 30) })
  t.after(() => revoked.close())
  const tun2 = await open(revoked, { getToken: async () => { if (++calls === 2) throw Object.assign(new Error('name belongs to someone else'), { final: true }); return 'x' } })
  t.after(() => tun2.close())
  await new Promise((r) => setTimeout(r, 1200)) // past two rounds of backoff
  assert.strictEqual(revoked.seen.hellos.length, 1)
  assert.strictEqual(calls, 2)
})
