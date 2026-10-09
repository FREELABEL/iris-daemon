'use strict'

/**
 * The Hive relay — public URLs for Hive nodes, end to end, relay BLIND (#188585).
 *
 *   visitor ──TLS for demo.t.<zone>──▶ relay :443 ──(same bytes, still encrypted)──▶ node
 *                                       │ reads only the ClientHello hostname (relay/sni.js)
 *   node ──outbound TLS to relay.<zone> (control: hello / open / ping)──▶ relay
 *   node ──one more outbound TLS per visitor (data: {op:"data",id})──▶ relay, spliced to visitor
 *
 * One public port. Connections whose hostname IS the relay's own control host are terminated here
 * (the control/data protocol); every other `<label>.<zone>` connection is forwarded byte for byte
 * to the node registered under that label, which terminates TLS with its own certificate. The
 * relay never holds a tunnel's key, so it cannot read or impersonate one (tests/relay-e2e.test.js).
 *
 * Nothing from outside can wedge it: a hello must arrive within helloTimeoutMs, a matched data
 * connection within dataTimeoutMs, pending visitors per tunnel are capped, and a tunnel that stops
 * answering pings is dropped with its waiting visitors.
 */

const net = require('net')
const tls = require('tls')
const crypto = require('crypto')
const { readClientHello, MAX_HELLO } = require('./sni')

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const MAX_LINE = 4096

/**
 * A registration token for ONE name until ONE time: `<expUnixSeconds>.<hmac>`. Issued by the IRIS
 * API to the account that owns the name (fl-iris-api HiveTunnelController mirrors this exactly);
 * the relay only checks it. Expiry is what makes revoking a name take effect without a revocation
 * list. A live tunnel is not cut at expiry — its data connections use the per-registration session.
 */
function tokenFor (secret, name, expSec) {
  const exp = Number.isInteger(expSec) ? expSec : Math.floor(Date.now() / 1000) + 86400
  const mac = crypto.createHmac('sha256', String(secret)).update(`hive-relay:v2:${String(name)}:${exp}`).digest('hex')
  return `${exp}.${mac}`
}

function tokenOk (secret, name, token, nowMs = Date.now()) {
  const m = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(String(token || ''))
  if (!m) return false
  const exp = Number(m[1])
  if (exp * 1000 <= nowMs) return false
  const want = Buffer.from(tokenFor(secret, name, exp))
  const got = Buffer.from(String(token))
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

const sessionOk = (tun, s) => {
  const got = Buffer.from(String(s || ''))
  const want = Buffer.from(tun.session)
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

/** Read one newline-terminated JSON line from a stream; resolves {msg, rest} or null. */
function readLine (sock, timeoutMs) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0)
    const done = (v) => { clearTimeout(t); sock.removeListener('data', onData); sock.removeListener('close', onClose); resolve(v) }
    const onClose = () => done(null)
    const onData = (d) => {
      buf = Buffer.concat([buf, d])
      const i = buf.indexOf(0x0a)
      if (i < 0) { if (buf.length > MAX_LINE) done(null); return }
      sock.pause()
      let msg = null
      try { msg = JSON.parse(buf.subarray(0, i).toString('utf8')) } catch { msg = null }
      done(msg && typeof msg === 'object' ? { msg, rest: buf.subarray(i + 1) } : null)
    }
    const t = setTimeout(() => done(null), timeoutMs)
    sock.on('data', onData)
    sock.on('close', onClose)
  })
}

/** Pump bytes both ways with backpressure; optional tap sees every forwarded chunk. */
function splice (a, b, tap) {
  const pump = (from, to) => {
    from.on('data', (d) => { if (tap) tap(d); if (!to.write(d)) from.pause() })
    to.on('drain', () => from.resume())
  }
  pump(a, b); pump(b, a)
  const kill = () => { a.destroy(); b.destroy() }
  a.on('close', kill); b.on('close', kill)
  a.on('error', kill); b.on('error', kill)
  a.resume(); b.resume()
}

function createRelay (opts) {
  // Several public zones may point at one relay (t.heyiris.io, hivemesh.net, irishive.net): a
  // tunnel NAME is the identity, reachable under every zone. Longest suffix wins, so a zone that
  // sits inside another can never be shadowed by it.
  const zones = (Array.isArray(opts.zones) && opts.zones.length ? opts.zones : [opts.zone])
    .map((z) => String(z).toLowerCase()).filter(Boolean).sort((a, b) => b.length - a.length)
  const primary = String((Array.isArray(opts.zones) && opts.zones.length ? opts.zones[0] : opts.zone)).toLowerCase()
  const relayHost = String(opts.relayHost).toLowerCase()
  const helloTimeoutMs = opts.helloTimeoutMs ?? 5000
  // 30 s: under load the node, not the relay, is slow — measured 230/500 refused at 10 s on a
  // starved machine. A visitor would rather wait than fail; browsers wait about this long anyway.
  const dataTimeoutMs = opts.dataTimeoutMs ?? 30000
  const heartbeatMs = opts.heartbeatMs ?? 15000
  // A memory guard, not a throttle: measured, a cap of 256 turned a 500-visitor burst into 244
  // refusals while the node was still answering. Bursts are absorbed by the warm pool instead.
  const maxPending = opts.maxPendingPerTunnel ?? 1024
  const maxIdle = opts.maxIdlePerTunnel ?? 64
  const tap = typeof opts.onForward === 'function' ? opts.onForward : null
  // Operator takedown (#188585): a name on this list cannot register, and is cut if it is live.
  const isDenied = typeof opts.isDenied === 'function' ? opts.isDenied : () => false
  const log = typeof opts.log === 'function' ? opts.log : () => {}

  const tunnels = new Map() // name -> { control, pending: Map(id -> {sock, hello, timer}), alive }
  const sockets = new Set()
  const beats = new Set() // heartbeat intervals — cleared by close() directly, not via 'close' events
  const counters = { accepted: 0, routed: 0, pooled: 0, refused: 0, registered: 0 }

  const send = (s, obj) => { if (!s.destroyed) s.write(JSON.stringify(obj) + '\n') }
  const refuse = (s, why) => { counters.refused++; log('refuse', why); s.destroy() }

  async function onRelayHost (raw, hello) {
    // The ClientHello was already read to route by hostname, so it is pushed back and the TLS
    // session is built over the JS stream (a tls.Server would read the NATIVE handle and miss it).
    // Over a JS stream, the wrapper and the socket must tear each other down explicitly — measured:
    // without this, a TLSWRAP outlived close() and kept the process alive.
    raw.unshift(hello)
    const t = new tls.TLSSocket(raw, { isServer: true, cert: opts.cert, key: opts.key })
    sockets.add(t)
    const down = () => { t.destroy(); raw.destroy() }
    t.on('close', () => { sockets.delete(t); raw.destroy() })
    raw.on('close', down)
    raw.on('end', down)
    t.on('error', down)
    const first = await readLine(t, helloTimeoutMs)
    if (!first) return t.destroy()
    const { msg, rest } = first
    const name = String(msg.name || '').toLowerCase()

    if (msg.op === 'hello') {
      if (!LABEL.test(name) || !tokenOk(opts.secret, name, msg.token)) { send(t, { op: 'err', error: 'bad token' }); return t.end() }
      if (isDenied(name)) { log('refuse', `denied ${name}`); send(t, { op: 'err', error: 'name in use: suspended by the operator' }); return t.end() }
      const cur = tunnels.get(name)
      if (cur && !cur.control.destroyed) { send(t, { op: 'err', error: 'name in use' }); return t.end() }
      const tun = { control: t, pending: new Map(), idle: [], alive: Date.now(), session: crypto.randomBytes(24).toString('hex') }
      tunnels.set(name, tun)
      counters.registered++
      send(t, { op: 'ok', host: `${name}.${primary}`, hosts: zones.map((z) => `${name}.${z}`), session: tun.session })
      let lines = rest
      t.on('data', (d) => {
        lines = Buffer.concat([lines, d]); tun.alive = Date.now()
        if (lines.length > MAX_LINE) lines = lines.subarray(lines.lastIndexOf(0x0a) + 1)
      })
      t.resume()
      const beat = setInterval(() => {
        if (Date.now() - tun.alive > heartbeatMs * 2) return t.destroy()
        send(t, { op: 'ping' })
      }, heartbeatMs)
      beats.add(beat)
      t.on('close', () => {
        clearInterval(beat); beats.delete(beat)
        if (tunnels.get(name) === tun) tunnels.delete(name)
        for (const p of tun.pending.values()) { clearTimeout(p.timer); p.sock.destroy() }
        tun.pending.clear()
        for (const i of tun.idle) i.destroy()
        tun.idle.length = 0
      })
      return
    }

    if (msg.op === 'idle') {
      // WARM POOL: a pre-handshaked connection from the node, parked until a visitor arrives. Saves
      // the visitor a node↔relay TLS handshake (measured: 1000-burst went 15 s → see tests).
      const tun = tunnels.get(name)
      if (!tun || !sessionOk(tun, msg.session) || tun.idle.length >= maxIdle) return t.destroy()
      tun.idle.push(t)
      t.on('close', () => { const i = tun.idle.indexOf(t); if (i >= 0) tun.idle.splice(i, 1) })
      return
    }

    if (msg.op === 'data') {
      const tun = tunnels.get(name)
      if (!tun || !sessionOk(tun, msg.session)) { send(t, { op: 'err', error: 'unknown tunnel' }); return t.end() }
      const p = tun.pending.get(String(msg.id || ''))
      if (!p) { send(t, { op: 'err', error: 'unknown id' }); return t.end() }
      tun.pending.delete(String(msg.id))
      clearTimeout(p.timer)
      counters.routed++
      if (tap) tap(p.hello)
      t.write(p.hello) // the visitor's ClientHello, still encrypted end to end
      if (rest.length) { if (tap) tap(rest); p.sock.write(rest) }
      return splice(p.sock, t, tap)
    }

    send(t, { op: 'err', error: 'unknown op' })
    t.end()
  }

  function onVisitor (sock, hello, name) {
    const tun = tunnels.get(name)
    if (!tun || tun.control.destroyed) return refuse(sock, `no tunnel ${name}`)
    if (isDenied(name)) { tun.control.destroy(); return refuse(sock, `denied ${name}`) }
    while (tun.idle.length) {
      const idle = tun.idle.shift()
      if (idle.destroyed) continue
      counters.routed++; counters.pooled++
      if (tap) tap(hello)
      idle.write(hello)
      return splice(sock, idle, tap)
    }
    if (tun.pending.size >= maxPending) return refuse(sock, `pending cap ${name}`)
    const id = crypto.randomBytes(16).toString('hex')
    const timer = setTimeout(() => { tun.pending.delete(id); refuse(sock, 'data timeout') }, dataTimeoutMs)
    tun.pending.set(id, { sock, hello, timer })
    sock.on('close', () => { clearTimeout(timer); tun.pending.delete(id) })
    send(tun.control, { op: 'open', id })
  }

  const server = net.createServer((sock) => {
    counters.accepted++
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    sock.on('error', () => sock.destroy())
    let buf = Buffer.alloc(0)
    const timer = setTimeout(() => refuse(sock, 'hello timeout'), helloTimeoutMs)
    const onData = (d) => {
      buf = Buffer.concat([buf, d])
      if (buf.length > MAX_HELLO) { clearTimeout(timer); return refuse(sock, 'hello too big') }
      const r = readClientHello(buf)
      if (r.status === 'need_more') return
      clearTimeout(timer)
      sock.removeListener('data', onData)
      sock.pause()
      if (r.status !== 'ok') return refuse(sock, r.status)
      if (r.sni === relayHost) return onRelayHost(sock, buf)
      for (const z of zones) {
        if (!r.sni.endsWith('.' + z)) continue
        const name = r.sni.slice(0, -(z.length + 1))
        if (LABEL.test(name)) return onVisitor(sock, buf, name)
        break
      }
      refuse(sock, `outside zone: ${r.sni}`)
    }
    sock.on('data', onData)
  })

  return {
    server,
    tunnels,
    _sockets: sockets,
    /** Re-check every live tunnel against the deny-list now (call after the list changes). */
    enforceDenyList: () => {
      let cut = 0
      for (const [name, tun] of tunnels) if (isDenied(name)) { tun.control.destroy(); cut++ }
      return cut
    },
    stats: () => ({ ...counters, tunnels: tunnels.size, sockets: sockets.size, idle: [...tunnels.values()].reduce((n, t) => n + t.idle.length, 0) }),
    close: () => new Promise((resolve) => {
      server.close(() => resolve())
      // Raw sockets first, then their TLS wrappers: a JS-stream TLS wrapper torn down before its
      // socket stayed 'pending' and kept the process alive at shutdown (measured; it did not
      // accumulate in operation — 300 visits, flat handle count).
      const all = [...sockets]
      for (const s of all) if (!(s instanceof tls.TLSSocket)) s.destroy()
      for (const s of all) if (s instanceof tls.TLSSocket) {
        s.destroy()
        // A JS-stream TLS wrapper can stay 'pending' after destroy() and never emit 'close',
        // holding its native handle (measured on the control connection). Release it explicitly.
        try { if (s._handle && typeof s._handle.close === 'function') s._handle.close() } catch {}
      }
      for (const b of beats) clearInterval(b)
      beats.clear()
      for (const tun of tunnels.values()) tun.control.destroy()
      tunnels.clear()
    })
  }
}

module.exports = { createRelay, tokenFor, tokenOk }
