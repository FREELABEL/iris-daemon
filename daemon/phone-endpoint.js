'use strict'

/**
 * IRIS Desktop on this machine, reached from the owner's IRIS iPhone app (#194511, ADR-03
 * "Sign in with IRIS, choose a machine").
 *
 *   phone ──https──▶ <name>.t.heyiris.io (Hive relay, blind byte pipe) ──▶ this server on 127.0.0.1
 *         ──▶ IRIS Desktop's engine (127.0.0.1:<port> from ~/.iris/desktop-engine.json)
 *
 * The relay has no auth of its own: whatever listens behind a tunnel is on the public internet. So
 * this server passes NOTHING to the engine without a token the platform signed for this node:
 *
 *   hp1.<nodeId>.<expUnix>.<nonce>.<hex hmac-sha256(nodeApiKey, "hp1|nodeId|exp|nonce")>
 *
 * `POST /api/v6/nodes/{id}/phone-token` issues it, to the node's owner only, for 12 h. Unlike hv1
 * (inference-endpoint.js) it is reusable until it expires: a phone makes many requests and holds an
 * event stream. The key is the node's api_key, read live because a healed node rotates it.
 *
 * The phone sends the token as `Authorization: Basic base64("iris:<token>")` (what packages/app
 * sends for a username/password server), as `Bearer <token>`, or as `?iris_token=` where it cannot
 * set a header (WebSocket). Once it checks out, the caller's Authorization and `iris_token` are
 * dropped and the engine's own Basic credentials are added — read from desktop-engine.json on every
 * request, because Desktop picks a new password on every launch. Host becomes 127.0.0.1:<port>: the
 * engine refuses any other Host with 403. HTTP, SSE and WebSocket (the PTY) pass through unbuffered.
 *
 * "Allow access to this computer" OFF (~/.iris/remote-access.json, #192964 W2) refuses everything
 * with 403, valid token or not. Off unless ~/.iris/phone.json says {"enabled": true}. The tunnel is
 * recorded in phone.json the same way inference.json records it, and tunnel-keepalive.js restarts it.
 */

const http = require('http')
const net = require('net')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { desktopEngines } = require('../lib/engine-auth')
const { remoteAccessAllowed, remoteAccessFile } = require('./remote-access')

const PREFIX = 'hp1'
// The platform issues 12 h; an hour of clock skew is tolerated, nothing longer.
const MAX_TTL_S = 13 * 3600
const DEFAULTS = { enabled: false, port: 3291, url: null }
// Where the IRIS app runs: Tauri's webview on iOS/macOS, and on Windows/Android.
const APP_ORIGINS = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'])
const HOP = new Set(['connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'authorization'])
const HEALTH = '/__iris/healthz'
const OFF = { error: 'remote_access_off', message: 'Remote access to this computer is off (IRIS Desktop → Settings → Hive → "Allow access to this computer").' }

const settingsFile = (home = os.homedir()) => path.join(home, '.iris', 'phone.json')

/** The owner's switch. Missing or unreadable = off. `tunnel` and `node` pass through for the keep-alive. */
function readSettings (home) {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(home), 'utf8'))
    const s = { ...DEFAULTS, ...raw }
    s.enabled = raw.enabled === true
    s.port = Number.isInteger(s.port) && s.port > 1024 && s.port < 65536 ? s.port : DEFAULTS.port
    s.url = typeof s.url === 'string' && /^https:\/\//.test(s.url) ? s.url.replace(/\/+$/, '') : null
    return s
  } catch {
    return { ...DEFAULTS }
  }
}

const mac = (key, nodeId, exp, nonce) =>
  crypto.createHmac('sha256', key).update(`${PREFIX}|${nodeId}|${exp}|${nonce}`).digest('hex')

/** What the platform does (mirrored in fl-iris-api). Exported for tests. */
function signToken ({ key, nodeId, ttlS = 12 * 3600, now = Date.now(), nonce = crypto.randomBytes(12).toString('hex') }) {
  const exp = Math.floor(now / 1000) + ttlS
  return `${PREFIX}.${nodeId}.${exp}.${nonce}.${mac(key, nodeId, exp, nonce)}`
}

/** Check a token. Returns {ok:true, exp} or {ok:false, why}. Never throws. Reusable: no nonce book. */
function verifyToken (token, { key, nodeId, now = Date.now() }) {
  if (!key || !nodeId) return { ok: false, why: 'this node has no identity yet' }
  const parts = String(token || '').split('.')
  if (parts.length !== 5 || parts[0] !== PREFIX) return { ok: false, why: 'not an IRIS phone token' }
  const [, tNode, tExp, nonce, sig] = parts
  if (tNode !== String(nodeId)) return { ok: false, why: 'token is for another node' }
  const exp = /^\d+$/.test(tExp) ? Number(tExp) : NaN
  const nowS = Math.floor(now / 1000)
  if (!Number.isSafeInteger(exp) || exp < nowS) return { ok: false, why: 'token expired' }
  if (exp > nowS + MAX_TTL_S) return { ok: false, why: 'token lives too long' }
  if (!/^[a-f0-9]{16,64}$/.test(nonce)) return { ok: false, why: 'bad nonce' }
  const a = Buffer.from(String(sig), 'utf8')
  const b = Buffer.from(mac(key, tNode, exp, nonce), 'utf8')
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, why: 'bad signature' }
  return { ok: true, exp }
}

/**
 * The token a request carries, and its URL with `iris_token` removed. Header first; the query is
 * stripped whatever the header said, so the token never reaches the engine or its logs.
 */
function extractToken (headers, rawUrl) {
  let token = null
  const auth = String(headers.authorization || '')
  if (/^bearer /i.test(auth)) token = auth.slice(7).trim()
  else if (/^basic /i.test(auth)) {
    let decoded = ''
    try { decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8') } catch {}
    const i = decoded.indexOf(':')
    if (i > 0 && decoded.slice(0, i) === 'iris') token = decoded.slice(i + 1)
  }
  const url = String(rawUrl || '/')
  const q = url.indexOf('?')
  if (q === -1) return { token, url }
  const keep = []
  for (const part of url.slice(q + 1).split('&')) {
    const eq = part.indexOf('=')
    let k = eq === -1 ? part : part.slice(0, eq)
    try { k = decodeURIComponent(k.replace(/\+/g, ' ')) } catch {}
    if (k === 'iris_token') {
      if (!token && eq !== -1) { try { token = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' ')) } catch {} }
      continue
    }
    keep.push(part)
  }
  return { token, url: url.slice(0, q) + (keep.length ? '?' + keep.join('&') : '') }
}

const corsFor = (origin) => (origin && APP_ORIGINS.has(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {})

function send (res, status, body, origin) {
  if (res.headersSent) { res.end(); return }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...corsFor(origin) })
  res.end(JSON.stringify(body))
}

function refuseSocket (socket, status, body) {
  const text = JSON.stringify(body)
  const reason = http.STATUS_CODES[status] || 'Error'
  try {
    // destroyed once written: an upgrade socket is half-open by default and would linger otherwise
    socket.end(`HTTP/1.1 ${status} ${reason}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`, () => socket.destroy())
  } catch {}
}

/** The request headers for the engine: the caller's, minus its credentials and hop-by-hop, plus ours. */
function forwardHeaders (headers, engine, port) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) if (!HOP.has(k.toLowerCase())) out[k] = v
  out.host = `127.0.0.1:${port}`
  out.authorization = engine.authorization
  return out
}

/**
 * Handlers for requests and upgrades, with everything they depend on injected so tests drive them
 * with a stand-in engine and no daemon: getKey/getNodeId (live identity), settings() (the switch),
 * allowed() ("Allow access to this computer"), engine() (Desktop's {base, authorization} or null).
 */
function createHandlers ({ getKey, getNodeId, settings, allowed, engine, now = () => Date.now(), log = () => {} }) {
  /** Shared gate for requests and upgrades: {status, body} to refuse, or {engine, port, url}. */
  function gate (req) {
    if (!allowed()) return { status: 403, body: OFF }
    if (!settings().enabled) return { status: 503, body: { error: 'phone_not_enabled' } }
    const { token, url } = extractToken(req.headers, req.url)
    const v = verifyToken(token, { key: getKey(), nodeId: getNodeId(), now: now() })
    if (!v.ok) { log(`refused: ${v.why}`); return { status: 401, body: { error: 'unauthorized', message: v.why } } }
    const e = engine()
    if (!e) return { status: 503, body: { error: 'desktop_not_running' } }
    return { engine: e, port: Number(e.base.split(':').pop()), url }
  }

  function request (req, res) {
    const origin = req.headers.origin
    if (!allowed()) return send(res, 403, OFF, origin)
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      // A preflight carries no credentials, so it is answered here, for the app's origin only.
      if (!APP_ORIGINS.has(origin)) { res.writeHead(403); return res.end() }
      res.writeHead(204, {
        ...corsFor(origin),
        'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': req.headers['access-control-request-headers'] || 'Authorization, Content-Type',
        'access-control-max-age': '600'
      })
      return res.end()
    }
    if (req.method === 'GET' && req.url === HEALTH) return send(res, 200, { ok: true }, origin)

    const g = gate(req)
    if (g.status) return send(res, g.status, g.body, origin)

    const up = http.request({ host: '127.0.0.1', port: g.port, method: req.method, path: g.url, headers: forwardHeaders(req.headers, g.engine, g.port) })
    up.on('response', (ur) => {
      const headers = {}
      for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k)) headers[k] = v
      if (!headers['access-control-allow-origin']) Object.assign(headers, corsFor(origin))
      res.writeHead(ur.statusCode, ur.statusMessage, headers)
      res.flushHeaders()
      ur.pipe(res)
    })
    up.on('error', (err) => {
      if (res.headersSent) return res.destroy()
      if (err.code === 'ECONNREFUSED') return send(res, 503, { error: 'desktop_not_running' }, origin)
      send(res, 502, { error: 'engine_unreachable', message: err.message }, origin)
    })
    res.on('close', () => { if (!res.writableFinished) up.destroy() })
    req.pipe(up)
  }

  /** A WebSocket (the PTY): the same gate, then the raw upgrade handed to the engine, both ways. */
  function upgrade (req, socket, head) {
    socket.on('error', () => {})
    const g = gate(req)
    if (g.status) return refuseSocket(socket, g.status, g.body)
    const headers = forwardHeaders(req.headers, g.engine, g.port)
    headers.connection = 'Upgrade'
    headers.upgrade = req.headers.upgrade
    let head1 = `${req.method} ${g.url} HTTP/1.1\r\n`
    for (const [k, v] of Object.entries(headers)) for (const one of [].concat(v)) head1 += `${k}: ${one}\r\n`
    const up = net.connect(g.port, '127.0.0.1', () => {
      up.write(head1 + '\r\n')
      if (head && head.length) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
    up.on('error', (err) => {
      if (!up.bytesRead && !socket.destroyed) refuseSocket(socket, 503, { error: err.code === 'ECONNREFUSED' ? 'desktop_not_running' : 'engine_unreachable' })
      else socket.destroy()
    })
    socket.on('close', () => up.destroy())
    up.on('close', () => socket.destroy())
  }

  return { request, upgrade }
}

/** Desktop's engine as published now, or null. Read on every call: the password changes per launch. */
const liveDesktopEngine = (home) => desktopEngines(home || os.homedir())[0] || null

/** The server, started and stopped as the owner's switch changes. `tick()` never throws. */
class PhoneEndpoint {
  constructor ({ getKey, getNodeId, home = os.homedir(), now = () => Date.now(), log = (m) => console.log(`[phone] ${m}`) }) {
    Object.assign(this, { home, now, log })
    this.server = null
    this.port = null
    this.sockets = new Set()
    this.handlers = createHandlers({
      getKey,
      getNodeId,
      settings: () => readSettings(home),
      allowed: () => remoteAccessAllowed(remoteAccessFile(home)),
      engine: () => liveDesktopEngine(home),
      now,
      log
    })
  }

  tick () {
    try {
      const s = readSettings(this.home)
      if (s.enabled && (!this.server || this.port !== s.port)) this.start(s.port)
      if (!s.enabled && this.server) this.stop()
      // OFF means off for what is already open too: an event stream or a terminal would otherwise
      // outlive the switch. New requests are refused by the handler; this ends the old ones.
      if (this.sockets.size && !remoteAccessAllowed(remoteAccessFile(this.home))) {
        this.log(`remote access turned off — closing ${this.sockets.size} open connection(s)`)
        this.dropConnections()
      }
    } catch (err) {
      this.log(`tick failed: ${err.message}`)
    }
  }

  start (port) {
    if (this.server) this.stop()
    const server = http.createServer((req, res) => {
      try { this.handlers.request(req, res) } catch (err) { try { send(res, 500, { error: 'internal', message: err.message }) } catch {} }
    })
    server.on('upgrade', (req, socket, head) => {
      try { this.handlers.upgrade(req, socket, head) } catch { socket.destroy() }
    })
    // Every socket, upgraded ones included (closeAllConnections does not see those).
    server.on('connection', (sock) => { this.sockets.add(sock); sock.on('close', () => this.sockets.delete(sock)) })
    server.on('error', (err) => { this.log(`cannot listen on 127.0.0.1:${port}: ${err.message}`); this.server = null })
    server.listen(port, '127.0.0.1', () => this.log(`serving on 127.0.0.1:${port}`))
    this.server = server
    this.port = port
  }

  stop () {
    if (!this.server) return
    this.server.close()
    this.dropConnections()
    this.server = null
    this.log('stopped')
  }

  dropConnections () {
    for (const sock of this.sockets) sock.destroy()
    this.sockets.clear()
  }

  /**
   * The heartbeat field, explicit when off (the hub keeps the last report for an absent key).
   * `enabled` is what the phone can actually use: the switch on, the server listening, and remote
   * access allowed — so the platform stops issuing tokens to a machine that would refuse them.
   */
  report () {
    const s = readSettings(this.home)
    const on = s.enabled && !!this.server && remoteAccessAllowed(remoteAccessFile(this.home))
    return {
      enabled: on,
      url: on ? s.url : null,
      engine: liveDesktopEngine(this.home) ? 'running' : 'stopped',
      updated_at: new Date(this.now()).toISOString()
    }
  }
}

module.exports = { PhoneEndpoint, createHandlers, verifyToken, signToken, extractToken, readSettings, settingsFile, MAX_TTL_S, APP_ORIGINS, HEALTH }
