'use strict'

const test = require('node:test')
const assert = require('node:assert')
const net = require('net')
const tls = require('tls')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const { createRelay, tokenFor } = require('../relay/server')
const { connectTunnel } = require('../relay/client')

/**
 * The Hive relay end to end on loopback with REAL TLS (#188585).
 * Zone `t.test`, relay control host `relay.t.test`, one tunnel `demo.t.test`.
 * Every assertion here is about a property a person relies on: it works, the relay cannot read it,
 * and nothing anyone sends from outside can wedge it.
 */

const ZONE = 't.test'
const RELAY_HOST = 'relay.t.test'
const SECRET = 'test-secret-' + crypto.randomBytes(8).toString('hex')

function cert (cn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaycert-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
    '-subj', `/CN=${cn}`, '-addext', `subjectAltName=DNS:${cn}`, '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' })
  return { cert: fs.readFileSync(path.join(dir, 'c.pem')), key: fs.readFileSync(path.join(dir, 'k.pem')) }
}
const RELAY_CERT = cert(RELAY_HOST)
const NODE_CERT = cert('demo.' + ZONE)

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))

async function world (opts = {}) {
  const app = http.createServer((req, res) => {
    if (req.url.startsWith('/big')) {
      const n = Number(new URL(req.url, 'http://x').searchParams.get('mb') || 1) * 1024 * 1024
      const chunk = crypto.createHash('sha256').update('seed').digest() // deterministic 32-byte block
      res.writeHead(200, { 'content-length': n })
      let sent = 0
      const pump = () => { while (sent < n) { const c = chunk.subarray(0, Math.min(32, n - sent)); sent += c.length; if (!res.write(Buffer.from(c))) return res.once('drain', pump) } res.end() }
      return pump()
    }
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`SECRET-PAGE ${req.method} ${req.url} ${body}`) })
  })
  const appPort = await listen(app)
  const tapped = []
  const relay = createRelay({
    zone: ZONE, relayHost: RELAY_HOST, cert: RELAY_CERT.cert, key: RELAY_CERT.key, secret: SECRET,
    helloTimeoutMs: opts.helloTimeoutMs ?? 400, dataTimeoutMs: opts.dataTimeoutMs ?? 2000, heartbeatMs: opts.heartbeatMs ?? 10000,
    onForward: (chunk) => tapped.push(chunk), ...(opts.relay || {})
  })
  const relayPort = await listen(relay.server)
  const tunnel = opts.noTunnel ? null : await connectTunnel({
    relay: { host: '127.0.0.1', port: relayPort }, relayHost: RELAY_HOST, relayCa: RELAY_CERT.cert,
    name: 'demo', token: tokenFor(SECRET, 'demo'), cert: NODE_CERT.cert, key: NODE_CERT.key,
    target: { host: '127.0.0.1', port: appPort }, reconnect: opts.reconnect ?? false
  })
  const close = async () => { tunnel && tunnel.close(); await relay.close(); app.closeAllConnections(); app.close() }
  return { app, appPort, relay, relayPort, tunnel, tapped, close }
}

/** A visitor: HTTPS to demo.t.test through the relay, trusting the NODE's certificate. */
function visit (relayPort, { pathName = '/hello', method = 'GET', body = '', host = 'demo.' + ZONE, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: relayPort, path: pathName, method,
      createConnection: () => tls.connect({ host: '127.0.0.1', port: relayPort, servername: host, ca: NODE_CERT.cert })
    }, (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => { const buf = Buffer.concat(chunks); resolve(raw ? { status: res.statusCode, buf } : { status: res.statusCode, text: buf.toString() }) })
    })
    req.on('error', reject)
    req.setTimeout(30000, () => req.destroy(new Error('timeout')))
    req.end(body)
  })
}

test('a visitor reaches the local app through the relay, over TLS that ends on the node', async () => {
  const w = await world()
  try {
    const r = await visit(w.relayPort, { pathName: '/hello?x=1', method: 'POST', body: 'ping' })
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.text, 'SECRET-PAGE POST /hello?x=1 ping')
  } finally { await w.close() }
})

test('BLIND: nothing the relay forwards contains the request or the page in plaintext', async () => {
  const w = await world()
  try {
    await visit(w.relayPort, { pathName: '/private-path', method: 'POST', body: 'card=4242' })
    const all = Buffer.concat(w.tapped)
    assert.ok(all.length > 0, 'the tap saw the forwarded bytes')
    for (const needle of ['SECRET-PAGE', '/private-path', 'card=4242', 'HTTP/1.1']) {
      assert.strictEqual(all.includes(Buffer.from(needle)), false, `relay saw plaintext: ${needle}`)
    }
  } finally { await w.close() }
})

test('the visitor verifies the NODE certificate — the relay cannot impersonate the tunnel', async () => {
  const w = await world()
  try {
    // A visitor that trusts only the RELAY's certificate must fail: the relay never terminates it.
    await assert.rejects(new Promise((resolve, reject) => {
      const s = tls.connect({ host: '127.0.0.1', port: w.relayPort, servername: 'demo.' + ZONE, ca: RELAY_CERT.cert })
      s.on('secureConnect', () => { s.destroy(); resolve() })
      s.on('error', reject)
    }))
  } finally { await w.close() }
})

test('an unknown tunnel name is closed promptly, not left hanging', async () => {
  const w = await world()
  try {
    const t0 = Date.now()
    await assert.rejects(visit(w.relayPort, { host: 'nobody.' + ZONE }))
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`)
  } finally { await w.close() }
})

test('a host outside the zone, plain HTTP, and no-SNI connections are refused', async () => {
  const w = await world()
  try {
    await assert.rejects(visit(w.relayPort, { host: 'demo.example.com' }))
    const plain = await new Promise((resolve) => {
      const s = net.connect(w.relayPort, '127.0.0.1', () => s.write('GET / HTTP/1.1\r\nHost: demo.t.test\r\n\r\n'))
      let got = ''
      s.on('data', (d) => { got += d })
      s.on('close', () => resolve(got))
    })
    assert.strictEqual(plain, '', 'plain HTTP gets nothing back')
  } finally { await w.close() }
})

test('slowloris: one byte then silence is cut off at the hello timeout', async () => {
  const w = await world({ helloTimeoutMs: 300 })
  try {
    const t0 = Date.now()
    await new Promise((resolve) => {
      const s = net.connect(w.relayPort, '127.0.0.1', () => s.write(Buffer.from([0x16])))
      s.on('close', resolve)
      s.on('error', () => {})
    })
    const took = Date.now() - t0
    assert.ok(took >= 250 && took < 1500, `closed after ${took}ms`)
  } finally { await w.close() }
})

test('registration needs a token signed for THAT name', async () => {
  const w = await world({ noTunnel: true })
  try {
    const base = { relay: { host: '127.0.0.1', port: w.relayPort }, relayHost: RELAY_HOST, relayCa: RELAY_CERT.cert, cert: NODE_CERT.cert, key: NODE_CERT.key, target: { host: '127.0.0.1', port: w.appPort } }
    await assert.rejects(connectTunnel({ ...base, name: 'demo', token: 'forged' }), /token/)
    await assert.rejects(connectTunnel({ ...base, name: 'demo', token: tokenFor(SECRET, 'other') }), /token/)
    await assert.rejects(connectTunnel({ ...base, name: 'demo', token: tokenFor('wrong-secret', 'demo') }), /token/)
    const ok = await connectTunnel({ ...base, name: 'demo', token: tokenFor(SECRET, 'demo') })
    ok.close()
  } finally { await w.close() }
})

test('a live name cannot be taken over; it is free again once its tunnel is gone', async () => {
  const w = await world()
  try {
    const base = { relay: { host: '127.0.0.1', port: w.relayPort }, relayHost: RELAY_HOST, relayCa: RELAY_CERT.cert, name: 'demo', token: tokenFor(SECRET, 'demo'), cert: NODE_CERT.cert, key: NODE_CERT.key, target: { host: '127.0.0.1', port: w.appPort } }
    await assert.rejects(connectTunnel(base), /in use/)
    w.tunnel.close()
    await new Promise((r) => setTimeout(r, 150))
    const again = await connectTunnel(base)
    assert.strictEqual((await visit(w.relayPort)).status, 200)
    again.close()
  } finally { await w.close() }
})

test('when the tunnel drops, visitors are refused quickly instead of hanging', async () => {
  const w = await world()
  try {
    w.tunnel.close()
    await new Promise((r) => setTimeout(r, 150))
    const t0 = Date.now()
    await assert.rejects(visit(w.relayPort))
    assert.ok(Date.now() - t0 < 1500)
  } finally { await w.close() }
})

test('a client with reconnect on comes back after the relay restarts', async () => {
  const w = await world({ reconnect: true })
  try {
    const port = w.relayPort
    await w.relay.close()
    const relay2 = createRelay({ zone: ZONE, relayHost: RELAY_HOST, cert: RELAY_CERT.cert, key: RELAY_CERT.key, secret: SECRET, helloTimeoutMs: 400, dataTimeoutMs: 2000 })
    await new Promise((r) => relay2.server.listen(port, '127.0.0.1', r))
    let ok = false
    for (let i = 0; i < 40 && !ok; i++) {
      await new Promise((r) => setTimeout(r, 150))
      ok = await visit(port).then((r) => r.status === 200, () => false)
    }
    assert.ok(ok, 'tunnel re-registered after the relay came back')
    w.tunnel.close()
    await relay2.close()
  } finally { w.app.closeAllConnections(); w.app.close() }
})

test('CONCURRENCY: 100 visitors at once each get their OWN correct answer', async () => {
  // Correctness under concurrency, not speed: generous timeouts, because this shares one process
  // (and, on a shared box, the machine) with everything else. Speed is measured by relay/stress.js
  // in separate processes — a load test inside the unit suite measures the neighbours, and flaked.
  const w = await world({ helloTimeoutMs: 15000, dataTimeoutMs: 30000 })
  try {
    const t0 = Date.now()
    const rs = await Promise.all(Array.from({ length: 100 }, (_, i) => visit(w.relayPort, { pathName: `/n${i}` })))
    rs.forEach((r, i) => assert.strictEqual(r.text, `SECRET-PAGE GET /n${i} `))
    console.log(`  100 concurrent visits in ${Date.now() - t0} ms`)
  } finally { await w.close() }
})

test('STRESS: a 50 MB download arrives intact (sha256 end to end)', async () => {
  const w = await world()
  try {
    const t0 = Date.now()
    const r = await visit(w.relayPort, { pathName: '/big?mb=50', raw: true })
    const block = crypto.createHash('sha256').update('seed').digest()
    const expected = crypto.createHash('sha256'); for (let i = 0; i < (50 * 1024 * 1024) / 32; i++) expected.update(block)
    assert.strictEqual(r.buf.length, 50 * 1024 * 1024)
    assert.strictEqual(crypto.createHash('sha256').update(r.buf).digest('hex'), expected.digest('hex'))
    console.log(`  50 MB through the relay in ${Date.now() - t0} ms`)
  } finally { await w.close() }
})

test('a data connection for an id nobody asked for is refused (no splicing into strangers)', async () => {
  const w = await world()
  try {
    const got = await new Promise((resolve) => {
      const s = tls.connect({ host: '127.0.0.1', port: w.relayPort, servername: RELAY_HOST, ca: RELAY_CERT.cert }, () => {
        s.write(JSON.stringify({ op: 'data', id: 'made-up', name: 'demo', token: tokenFor(SECRET, 'demo') }) + '\n')
      })
      let buf = ''
      s.on('data', (d) => { buf += d })
      s.on('close', () => resolve(buf))
      s.on('error', () => resolve(buf))
    })
    assert.match(got, /unknown/)
  } finally { await w.close() }
})

test('WARM POOL: visitors are spliced onto pre-opened connections, and the pool refills', async () => {
  const w = await world()
  try {
    await new Promise((r) => setTimeout(r, 300)) // let the pool fill
    const before = w.relay.stats()
    assert.ok(before.idle >= 4, `pool filled: ${before.idle} idle`)
    const rs = await Promise.all(Array.from({ length: 4 }, (_, i) => visit(w.relayPort, { pathName: `/p${i}` })))
    rs.forEach((r, i) => assert.strictEqual(r.text, `SECRET-PAGE GET /p${i} `))
    const after = w.relay.stats()
    assert.ok(after.pooled - before.pooled >= 1, `pooled routes: ${after.pooled - before.pooled}`)
    await new Promise((r) => setTimeout(r, 300))
    assert.ok(w.relay.stats().idle >= 4, 'pool refilled')
  } finally { await w.close() }
})

test('a host merely as LONG as the zone is not in it (demo.ab.cde must not reach tunnel demo)', async () => {
  const w = await world()
  try {
    assert.strictEqual('.ab.cde'.length, ('.' + ZONE).length) // the case a length-only check would route
    const before = w.relay.stats()
    await assert.rejects(visit(w.relayPort, { host: 'demo.ab.cde' }))
    // Judge the RELAY's decision, not the visitor's: a misrouted connection is still rejected by the
    // visitor's own certificate check (cert is for demo.t.test), which hid this mutation once.
    const after = w.relay.stats()
    assert.strictEqual(after.routed, before.routed, 'relay routed a host outside its zone')
    assert.strictEqual(after.refused, before.refused + 1)
    assert.strictEqual((await visit(w.relayPort)).status, 200, 'the real tunnel still works')
  } finally { await w.close() }
})

test('with a visitor WAITING, a data connection carrying a forged id is refused and the visitor is not handed to it', async () => {
  const w = await world({ noTunnel: true, dataTimeoutMs: 3000 })
  try {
    // A control connection that registers but never answers "open" — so the visitor stays pending.
    const ctl = tls.connect({ host: '127.0.0.1', port: w.relayPort, servername: RELAY_HOST, ca: RELAY_CERT.cert })
    await new Promise((r) => ctl.on('secureConnect', r))
    ctl.write(JSON.stringify({ op: 'hello', name: 'demo', token: tokenFor(SECRET, 'demo') }) + '\n')
    const { session } = JSON.parse(String(await new Promise((r) => ctl.once('data', r))).split('\n')[0])
    assert.ok(session, 'registration returns a session key')
    const visitor = tls.connect({ host: '127.0.0.1', port: w.relayPort, servername: 'demo.' + ZONE, ca: NODE_CERT.cert })
    visitor.on('error', () => {})
    await new Promise((r) => setTimeout(r, 200))
    assert.strictEqual([...w.relay.tunnels.get('demo').pending.keys()].length, 1, 'visitor is pending')
    const forged = await new Promise((resolve) => {
      const s = tls.connect({ host: '127.0.0.1', port: w.relayPort, servername: RELAY_HOST, ca: RELAY_CERT.cert }, () => {
        s.write(JSON.stringify({ op: 'data', id: 'not-the-real-id', name: 'demo', session }) + '\n')
      })
      let buf = ''
      s.on('data', (d) => { buf += d })
      s.on('close', () => resolve(buf)); s.on('error', () => resolve(buf))
    })
    assert.match(forged, /unknown id/)
    assert.strictEqual([...w.relay.tunnels.get('demo').pending.keys()].length, 1, 'visitor was not spliced to the forged connection')
    visitor.destroy(); ctl.destroy()
  } finally { await w.close() }
})

// ── Expiring tokens + per-registration sessions ─────────────────────────────────────────────────

test('an EXPIRED token is refused, and a token is bound to its expiry (editing it breaks the signature)', async () => {
  const w = await world({ noTunnel: true })
  const base = { relay: { host: '127.0.0.1', port: w.relayPort }, relayHost: RELAY_HOST, relayCa: RELAY_CERT.cert, name: 'demo', cert: NODE_CERT.cert, key: NODE_CERT.key, target: { host: '127.0.0.1', port: w.appPort } }
  try {
    const past = Math.floor(Date.now() / 1000) - 5
    await assert.rejects(connectTunnel({ ...base, token: tokenFor(SECRET, 'demo', past) }), /token/)
    const t = tokenFor(SECRET, 'demo', past)
    const pushed = String(past + 86400) + t.slice(t.indexOf('.'))
    await assert.rejects(connectTunnel({ ...base, token: pushed }), /token/)
    const ok = await connectTunnel({ ...base, token: tokenFor(SECRET, 'demo', Math.floor(Date.now() / 1000) + 60) })
    ok.close()
  } finally { await w.close() }
})

test('a valid TOKEN alone does not open a data connection — it needs the live registration\'s session', async () => {
  const w = await world()
  try {
    await new Promise((r) => setTimeout(r, 200))
    const before = w.relay.stats().idle
    const got = await new Promise((resolve) => {
      const s = tls.connect({ host: '127.0.0.1', port: w.relayPort, servername: RELAY_HOST, ca: RELAY_CERT.cert }, () => {
        s.write(JSON.stringify({ op: 'idle', name: 'demo', token: tokenFor(SECRET, 'demo') }) + '\n')
      })
      s.on('close', () => resolve('closed')); s.on('error', () => resolve('closed'))
      s.setTimeout(1500, () => { s.destroy(); resolve('left open') })
    })
    assert.strictEqual(got, 'closed')
    assert.strictEqual(w.relay.stats().idle, before, 'a token-only connection was parked in the pool')
  } finally { await w.close() }
})

test('a live tunnel keeps serving after its registration token expires', async () => {
  const w = await world({ noTunnel: true })
  try {
    const exp = Math.floor(Date.now() / 1000) + 2
    const t = await connectTunnel({ relay: { host: '127.0.0.1', port: w.relayPort }, relayHost: RELAY_HOST, relayCa: RELAY_CERT.cert, name: 'demo', token: tokenFor(SECRET, 'demo', exp), cert: NODE_CERT.cert, key: NODE_CERT.key, target: { host: '127.0.0.1', port: w.appPort }, poolSize: 0 })
    await new Promise((r) => setTimeout(r, 3200))
    assert.strictEqual((await visit(w.relayPort, { pathName: '/after-expiry' })).text, 'SECRET-PAGE GET /after-expiry ')
    t.close()
  } finally { await w.close() }
})

test('getToken() is asked for a fresh token on every (re)connect', async () => {
  const w = await world({ noTunnel: true })
  let asked = 0
  try {
    const t = await connectTunnel({ relay: { host: '127.0.0.1', port: w.relayPort }, relayHost: RELAY_HOST, relayCa: RELAY_CERT.cert, name: 'demo', getToken: async () => { asked++; return tokenFor(SECRET, 'demo') }, cert: NODE_CERT.cert, key: NODE_CERT.key, target: { host: '127.0.0.1', port: w.appPort }, reconnect: true })
    assert.strictEqual(asked, 1)
    w.relay.tunnels.get('demo').control.destroy()
    for (let i = 0; i < 40 && asked < 2; i++) await new Promise((r) => setTimeout(r, 100))
    assert.ok(asked >= 2, 'asked again on reconnect')
    t.close()
  } finally { await w.close() }
})

// ── Certificates through the blind relay (TLS-ALPN-01) ──────────────────────────────────────────

const x509 = require('../relay/x509')
const ACME_ID_OID = Buffer.from([0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x01, 0x1f])

function alpnVisit (port, alpn) {
  return new Promise((resolve) => {
    const s = tls.connect({ host: '127.0.0.1', port, servername: 'demo.' + ZONE, ALPNProtocols: alpn, rejectUnauthorized: false }, () => {
      const peer = s.getPeerCertificate(true)
      resolve({ ok: true, alpn: s.alpnProtocol, raw: peer && peer.raw })
      s.destroy()
    })
    s.on('error', (e) => resolve({ ok: false, err: e.code || e.message }))
    s.setTimeout(3000, () => { s.destroy(); resolve({ ok: false, err: 'timeout' }) })
  })
}

test('TLS-ALPN-01: an acme-tls/1 visitor gets the CHALLENGE certificate; a normal visitor still gets the node\'s', async () => {
  const w = await world()
  try {
    const key = x509.newKey()
    w.tunnel.setChallenge('demo.' + ZONE, { cert: x509.alpnChallengeCert(key, 'demo.' + ZONE, 'tok.thumb'), key })
    const v = await alpnVisit(w.relayPort, ['acme-tls/1'])
    assert.ok(v.ok, `handshake: ${v.err}`)
    assert.strictEqual(v.alpn, 'acme-tls/1')
    const digest = crypto.createHash('sha256').update('tok.thumb').digest()
    assert.ok(v.raw.includes(ACME_ID_OID) && v.raw.includes(digest), 'served the acmeIdentifier for THIS key authorization')
    assert.strictEqual((await visit(w.relayPort, { pathName: '/normal' })).text, 'SECRET-PAGE GET /normal ')
    w.tunnel.setChallenge('demo.' + ZONE, null)
    assert.strictEqual((await alpnVisit(w.relayPort, ['acme-tls/1'])).ok, false, 'no challenge pending → closed, never the real cert')
  } finally { await w.close() }
})

test('a tunnel can come up BEFORE it has a certificate; visitors are closed until setCertificate()', async () => {
  const w = await world({ noTunnel: true })
  try {
    const t = await connectTunnel({ relay: { host: '127.0.0.1', port: w.relayPort }, relayHost: RELAY_HOST, relayCa: RELAY_CERT.cert, name: 'demo', token: tokenFor(SECRET, 'demo'), target: { host: '127.0.0.1', port: w.appPort } })
    assert.strictEqual(t.hasCertificate(), false)
    await assert.rejects(visit(w.relayPort))
    t.setCertificate(NODE_CERT.cert, NODE_CERT.key)
    assert.strictEqual((await visit(w.relayPort, { pathName: '/now' })).text, 'SECRET-PAGE GET /now ')
    t.close()
  } finally { await w.close() }
})

test('the REAL pending id with the wrong session is refused — knowing an id is not enough', async () => {
  const w = await world({ noTunnel: true, dataTimeoutMs: 3000 })
  try {
    const ctl = tls.connect({ host: '127.0.0.1', port: w.relayPort, servername: RELAY_HOST, ca: RELAY_CERT.cert })
    await new Promise((r) => ctl.on('secureConnect', r))
    ctl.write(JSON.stringify({ op: 'hello', name: 'demo', token: tokenFor(SECRET, 'demo') }) + '\n')
    let lines = ''
    ctl.on('data', (d) => { lines += d })
    while (!lines.includes('"ok"')) await new Promise((r) => setTimeout(r, 20))
    const visitor = tls.connect({ host: '127.0.0.1', port: w.relayPort, servername: 'demo.' + ZONE, ca: NODE_CERT.cert })
    visitor.on('error', () => {})
    for (let i = 0; i < 50 && !lines.includes('"open"'); i++) await new Promise((r) => setTimeout(r, 20))
    const id = lines.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.op === 'open').id
    for (const session of ['wrong', undefined]) {
      const got = await new Promise((resolve) => {
        const s = tls.connect({ host: '127.0.0.1', port: w.relayPort, servername: RELAY_HOST, ca: RELAY_CERT.cert }, () => {
          s.write(JSON.stringify({ op: 'data', id, name: 'demo', session, token: tokenFor(SECRET, 'demo') }) + '\n')
        })
        let buf = ''
        s.on('data', (d) => { buf += d })
        s.on('close', () => resolve(buf)); s.on('error', () => resolve(buf))
        s.setTimeout(1500, () => { s.destroy(); resolve(buf || 'left open') })
      })
      assert.match(got, /unknown tunnel/)
    }
    assert.strictEqual(w.relay.tunnels.get('demo').pending.size, 1, 'the visitor was not handed over')
    visitor.destroy(); ctl.destroy()
  } finally { await w.close() }
})

test('TAKEDOWN: a denied name cannot register, and a live one is cut when the list changes', async () => {
  const deny = new Set()
  const w = await world({ relay: { isDenied: (n) => deny.has(n) } })
  try {
    assert.strictEqual((await visit(w.relayPort)).status, 200)
    deny.add('demo')
    assert.strictEqual(w.relay.enforceDenyList(), 1)
    await assert.rejects(visit(w.relayPort))
    await assert.rejects(connectTunnel({ relay: { host: '127.0.0.1', port: w.relayPort }, relayHost: RELAY_HOST, relayCa: RELAY_CERT.cert, name: 'demo', token: tokenFor(SECRET, 'demo'), cert: NODE_CERT.cert, key: NODE_CERT.key, target: { host: '127.0.0.1', port: w.appPort } }), /suspended/)
  } finally { await w.close() }
})

// ── Several public zones on one relay (t.heyiris.io + hivemesh.net + irishive.net) ──────────────

test('MULTI-ZONE: the same tunnel answers under every zone; the longest zone wins; outsiders still refused', async () => {
  const w = await world({ relay: { zones: [ZONE, 'alt.test', 'deep.alt.test'] } })
  try {
    const before = w.relay.stats().routed
    const reach = (host) => new Promise((resolve) => {
      const s = tls.connect({ host: '127.0.0.1', port: w.relayPort, servername: host, rejectUnauthorized: false }, () => { s.destroy(); resolve(true) })
      s.on('error', () => resolve(false))
      s.setTimeout(3000, () => { s.destroy(); resolve(false) })
    })
    assert.strictEqual((await visit(w.relayPort)).status, 200, 'primary zone')
    assert.strictEqual(await reach('demo.alt.test'), true, 'second zone reaches the same node')
    assert.strictEqual(await reach('demo.deep.alt.test'), true, 'a zone inside another zone: routed as name "demo", not "demo.deep"')
    assert.strictEqual(await reach('demo.other.test'), false)
    assert.ok(w.relay.stats().routed >= before + 3)
  } finally { await w.close() }
})

test('MULTI-ZONE: registration tells the node every host it is reachable at; the first zone is the one shown', async () => {
  const w = await world({ noTunnel: true, relay: { zones: ['first.test', ZONE] } })
  try {
    const ctl = tls.connect({ host: '127.0.0.1', port: w.relayPort, servername: RELAY_HOST, ca: RELAY_CERT.cert })
    await new Promise((r) => ctl.on('secureConnect', r))
    ctl.write(JSON.stringify({ op: 'hello', name: 'demo', token: tokenFor(SECRET, 'demo') }) + '\n')
    const ok = JSON.parse(String(await new Promise((r) => ctl.once('data', r))).split('\n')[0])
    assert.strictEqual(ok.host, 'demo.first.test')
    assert.deepStrictEqual(ok.hosts.sort(), ['demo.first.test', 'demo.' + ZONE].sort())
    ctl.destroy()
  } finally { await w.close() }
})
