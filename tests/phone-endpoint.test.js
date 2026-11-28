'use strict'

const test = require('node:test')
const assert = require('node:assert')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { PhoneEndpoint, signToken, verifyToken, extractToken, readSettings, MAX_TTL_S } = require('../daemon/phone-endpoint')
const { TunnelKeepAlive } = require('../daemon/tunnel-keepalive')

// #194511 ADR-03 — the IRIS iPhone app reaches IRIS Desktop through a relay tunnel and this endpoint.
// The token format is shared with fl-iris-api (phone-token); VECTOR pins it so the two cannot drift.
const KEY = 'node-api-key-123'
const NODE = '01a10379-0c9f-73c5-bf83-157496a21589'
const NOW = 1792000000000
const VECTOR = { key: KEY, nodeId: NODE, ttlS: 43200, now: NOW, nonce: 'a1b2c3d4e5f60718293a4b5c' }
const ENGINE_PASSWORD = 'per-launch-s3cret'
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64')

test('the shared token vector (copy into fl-iris-api; checked against openssl dgst -sha256 -hmac)', () => {
  assert.strictEqual(signToken(VECTOR), 'hp1.01a10379-0c9f-73c5-bf83-157496a21589.1792043200.a1b2c3d4e5f60718293a4b5c.9acbb829ca03cd50fb6cd6525fd593d2664b0a6afba0961dd7e2c9d589b2bbff')
})

test('verifyToken: every way a token can be wrong, and reuse is fine', () => {
  const ok = signToken({ key: KEY, nodeId: NODE, now: NOW })
  const why = (t, o = {}) => verifyToken(t, { key: KEY, nodeId: NODE, now: NOW, ...o }).why
  const cases = [
    ['valid', ok, {}, undefined],
    ['valid again (reusable until exp)', ok, {}, undefined],
    ['valid an hour before expiry', ok, { now: NOW + 11 * 3600e3 }, undefined],
    ['empty', '', {}, 'not an IRIS phone token'],
    ['hv1 prefix', 'hv1' + ok.slice(3), {}, 'not an IRIS phone token'],
    ['extra part', ok + '.x', {}, 'not an IRIS phone token'],
    ['another node', ok, { nodeId: 'other' }, 'token is for another node'],
    ['expired', ok, { now: NOW + 12 * 3600e3 + 1000 }, 'token expired'],
    ['exp not a number', ok.replace('.1792043200.', '.17920432e2.'), {}, 'token expired'],
    ['13 h + 1 s ahead', signToken({ key: KEY, nodeId: NODE, now: NOW, ttlS: MAX_TTL_S + 1 }), {}, 'token lives too long'],
    ['exactly 13 h ahead', signToken({ key: KEY, nodeId: NODE, now: NOW, ttlS: MAX_TTL_S }), {}, undefined],
    ['bad nonce', signToken({ key: KEY, nodeId: NODE, now: NOW, nonce: 'xyz' }), {}, 'bad nonce'],
    ['wrong key', ok, { key: 'wrong' }, 'bad signature'],
    ['tampered signature', ok.slice(0, -1) + (ok.endsWith('0') ? '1' : '0'), {}, 'bad signature'],
    ['short signature', ok.slice(0, -2), {}, 'bad signature'],
    ['no key yet', ok, { key: '' }, 'this node has no identity yet']
  ]
  for (const [name, t, o, want] of cases) assert.strictEqual(why(t, o), want, name)
})

test('extractToken: Basic iris:<t>, Bearer, ?iris_token= — and the query param is always stripped', () => {
  assert.deepStrictEqual(extractToken({ authorization: basic('iris', 'hp1.a') }, '/x'), { token: 'hp1.a', url: '/x' })
  assert.deepStrictEqual(extractToken({ authorization: 'Bearer hp1.b' }, '/x'), { token: 'hp1.b', url: '/x' })
  assert.strictEqual(extractToken({ authorization: basic('opencode', 'hp1.a') }, '/x').token, null)
  assert.deepStrictEqual(extractToken({}, '/pty/1/connect?iris_token=hp1.c&directory=%2Ftmp%2Fa%20b'), { token: 'hp1.c', url: '/pty/1/connect?directory=%2Ftmp%2Fa%20b' })
  assert.deepStrictEqual(extractToken({}, '/a?iris_token=hp1.c'), { token: 'hp1.c', url: '/a' })
  // a header wins, but the query copy still never reaches the engine
  assert.deepStrictEqual(extractToken({ authorization: 'Bearer hp1.h' }, '/a?x=1&iris_token=hp1.q'), { token: 'hp1.h', url: '/a?x=1' })
})

// ---- a stand-in for Desktop's engine: refuses wrong Host / credentials like the real one ----

function standInEngine () {
  const seen = []
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers })
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) { res.writeHead(403); return res.end('host') }
    if (req.headers.authorization !== basic('opencode', ENGINE_PASSWORD)) { res.writeHead(401); return res.end('auth') }
    if (req.url === '/event/forever') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: hello\n\n')
      return
    }
    if (req.url === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let i = 0
      const t = setInterval(() => {
        res.write(`data: ${i}\n\n`)
        if (++i === 3) { clearInterval(t); res.end() }
      }, 200)
      return
    }
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ url: req.url, method: req.method, body }))
    })
  })
  server.on('upgrade', (req, socket) => {
    seen.push({ url: req.url, headers: req.headers, upgrade: true })
    sockets.add(socket)
    const ok = req.headers.host === `127.0.0.1:${server.address().port}` && req.headers.authorization === basic('opencode', ENGINE_PASSWORD)
    if (!ok) return socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', (d) => socket.write('echo:' + d))
  })
  server.closeEverything = () => { for (const s of sockets) s.destroy(); server.closeAllConnections(); server.close() }
  return { server, seen }
}

const listen = (server, port = 0) => new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)))

function makeHome ({ phone = { enabled: true, url: 'https://box-phone.t.heyiris.io' }, enginePort, remote } = {}) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-ep-'))
  fs.mkdirSync(path.join(h, '.iris'))
  if (phone) fs.writeFileSync(path.join(h, '.iris', 'phone.json'), JSON.stringify(phone))
  if (enginePort) writeEngine(h, enginePort)
  if (remote !== undefined) fs.writeFileSync(path.join(h, '.iris', 'remote-access.json'), JSON.stringify({ allow: remote }))
  return h
}
function writeEngine (h, port, password = ENGINE_PASSWORD) {
  const f = path.join(h, '.iris', 'desktop-engine.json')
  fs.writeFileSync(f, JSON.stringify({ version: 1, port, username: 'opencode', password, pid: process.pid }))
  fs.chmodSync(f, 0o600)
}

async function setup (t, opts = {}) {
  const eng = standInEngine()
  const enginePort = opts.noEngine ? null : await listen(eng.server)
  // A free port for phone.json, so tick() — the daemon's own path — starts the server.
  const probe = http.createServer()
  const free = await listen(probe)
  await new Promise((r) => probe.close(r))
  const home = makeHome({ ...opts, phone: { enabled: true, url: 'https://box-phone.t.heyiris.io', port: free }, enginePort })
  const ep = new PhoneEndpoint({ getKey: () => KEY, getNodeId: () => NODE, home, log: () => {} })
  ep.tick()
  await new Promise((r) => ep.server.once('listening', r))
  const port = ep.server.address().port
  assert.strictEqual(port, free)
  t.after(() => { ep.stop(); eng.server.closeEverything() })
  return { ep, eng, home, port, enginePort, token: signToken({ key: KEY, nodeId: NODE }) }
}

function get (port, p, headers = {}, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let b = ''
      res.on('data', (c) => { b += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('a valid token: caller auth dropped, engine creds + Host added, body and query forwarded', { timeout: 10000 }, async (t) => {
  const { port, eng, enginePort, token } = await setup(t)
  for (const auth of [basic('iris', token), `Bearer ${token}`]) {
    const r = await get(port, '/session?directory=%2Ftmp', { authorization: auth, 'content-type': 'application/json' }, 'POST', '{"a":1}')
    assert.strictEqual(r.status, 200)
    assert.deepStrictEqual(JSON.parse(r.body), { url: '/session?directory=%2Ftmp', method: 'POST', body: '{"a":1}' })
    const last = eng.seen.at(-1)
    assert.strictEqual(last.headers.authorization, basic('opencode', ENGINE_PASSWORD))
    assert.strictEqual(last.headers.host, `127.0.0.1:${enginePort}`)
    assert.ok(!JSON.stringify(last.headers).includes(token), 'the phone token never reaches the engine')
  }
})

test('?iris_token= works and is stripped before forwarding', { timeout: 10000 }, async (t) => {
  const { port, eng, token } = await setup(t)
  const r = await get(port, `/file?path=a&iris_token=${encodeURIComponent(token)}`)
  assert.strictEqual(r.status, 200)
  assert.strictEqual(eng.seen.at(-1).url, '/file?path=a')
})

test('the engine password is read live: a Desktop relaunch with a new password just works', { timeout: 10000 }, async (t) => {
  const { port, home, enginePort, token } = await setup(t)
  writeEngine(home, enginePort, 'stale-password')
  assert.strictEqual((await get(port, '/x', { authorization: `Bearer ${token}` })).status, 401, 'engine refused the stale password')
  writeEngine(home, enginePort)
  assert.strictEqual((await get(port, '/x', { authorization: `Bearer ${token}` })).status, 200)
})

test('no token, a bad token, another node\'s token → 401 and the engine never hears of it', { timeout: 10000 }, async (t) => {
  const { port, eng } = await setup(t)
  const bad = [
    {},
    { authorization: 'Bearer hp1.nope' },
    { authorization: `Bearer ${signToken({ key: KEY, nodeId: 'other-node' })}` },
    { authorization: `Bearer ${signToken({ key: 'other-key', nodeId: NODE })}` },
    { authorization: basic('opencode', ENGINE_PASSWORD) }
  ]
  for (const h of bad) {
    const r = await get(port, '/session', h)
    assert.strictEqual(r.status, 401, JSON.stringify(h))
    assert.strictEqual(JSON.parse(r.body).error, 'unauthorized')
  }
  assert.strictEqual(eng.seen.length, 0)
})

test('no Desktop engine → 503 desktop_not_running (no file, and a file whose engine is gone)', { timeout: 10000 }, async (t) => {
  const { port, home, token } = await setup(t, { noEngine: true })
  let r = await get(port, '/session', { authorization: `Bearer ${token}` })
  assert.strictEqual(r.status, 503)
  assert.deepStrictEqual(JSON.parse(r.body), { error: 'desktop_not_running' })
  // A file left behind pointing at a port nobody listens on.
  const dead = http.createServer()
  const deadPort = await listen(dead)
  await new Promise((r2) => dead.close(r2))
  writeEngine(home, deadPort)
  r = await get(port, '/session', { authorization: `Bearer ${token}` })
  assert.strictEqual(r.status, 503)
  assert.deepStrictEqual(JSON.parse(r.body), { error: 'desktop_not_running' })
})

test('"Allow access to this computer" OFF → 403 for everything, valid token or not; ON again works', { timeout: 10000 }, async (t) => {
  const { port, home, eng, token } = await setup(t, { remote: false })
  for (const [p, h, m] of [['/session', { authorization: `Bearer ${token}` }], [`/x?iris_token=${token}`, {}], ['/__iris/healthz', {}], ['/session', { origin: 'tauri://localhost', 'access-control-request-method': 'POST' }, 'OPTIONS']]) {
    const r = await get(port, p, h, m)
    assert.strictEqual(r.status, 403, p)
  }
  assert.strictEqual(eng.seen.length, 0)
  fs.writeFileSync(path.join(home, '.iris', 'remote-access.json'), JSON.stringify({ allow: true }))
  assert.strictEqual((await get(port, '/session', { authorization: `Bearer ${token}` })).status, 200)
})

test('remote access turned OFF ends streams and terminals already open, at the next tick', { timeout: 10000 }, async (t) => {
  const { ep, port, home, token } = await setup(t)
  const ws = await upgrade(port, `/pty/abc/connect?iris_token=${token}`)
  assert.strictEqual(ws.status, 101)
  const sse = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/event/forever', headers: { authorization: `Bearer ${token}` } }, (res) => res.once('data', () => resolve(res))).on('error', reject)
  })
  const ended = Promise.all([
    new Promise((r) => sse.on('close', r)),
    new Promise((r) => ws.socket.on('close', r))
  ])
  ep.tick()
  assert.strictEqual(ep.sockets.size, 2, 'still allowed: nothing dropped')
  fs.writeFileSync(path.join(home, '.iris', 'remote-access.json'), JSON.stringify({ allow: false }))
  ep.tick()
  await ended
  assert.strictEqual(ep.sockets.size, 0)
})

test('SSE passes through as it is written, not buffered to the end', { timeout: 10000 }, async (t) => {
  const { port, token } = await setup(t)
  const arrivals = await new Promise((resolve, reject) => {
    const start = Date.now()
    const times = []
    http.get({ host: '127.0.0.1', port, path: '/event', headers: { authorization: `Bearer ${token}` } }, (res) => {
      assert.strictEqual(res.headers['content-type'], 'text/event-stream')
      res.on('data', (c) => { for (const _ of String(c).match(/data:/g) || []) times.push(Date.now() - start) })
      res.on('end', () => resolve(times))
    }).on('error', reject)
  })
  assert.strictEqual(arrivals.length, 3)
  assert.ok(arrivals[0] < 400, `first event at ${arrivals[0]}ms`)
  assert.ok(arrivals[2] - arrivals[0] >= 300, `events spread out: ${arrivals}`)
})

function upgrade (port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } })
    req.on('upgrade', (res, socket) => resolve({ status: res.statusCode, socket }))
    req.on('response', (res) => { let b = ''; res.on('data', (c) => { b += c }); res.on('end', () => resolve({ status: res.statusCode, body: b })) })
    req.on('error', reject)
    req.end()
  })
}

test('WebSocket upgrade (the PTY) is proxied both ways, token from the query, stripped', { timeout: 10000 }, async (t) => {
  const { port, eng, enginePort, token } = await setup(t)
  const r = await upgrade(port, `/pty/abc/connect?directory=%2Ftmp&iris_token=${encodeURIComponent(token)}`)
  assert.strictEqual(r.status, 101)
  const seen = eng.seen.at(-1)
  assert.strictEqual(seen.upgrade, true)
  assert.strictEqual(seen.url, '/pty/abc/connect?directory=%2Ftmp')
  assert.strictEqual(seen.headers.host, `127.0.0.1:${enginePort}`)
  assert.strictEqual(seen.headers.authorization, basic('opencode', ENGINE_PASSWORD))
  assert.strictEqual(seen.headers['sec-websocket-key'], 'dGhlIHNhbXBsZSBub25jZQ==')
  const echo = await new Promise((resolve) => { r.socket.once('data', (d) => resolve(String(d))); r.socket.write('ls\n') })
  assert.strictEqual(echo, 'echo:ls\n')
  r.socket.destroy()
})

test('WebSocket upgrade without a token, or with remote access off, is refused before the engine', { timeout: 10000 }, async (t) => {
  const { port, eng, home, token } = await setup(t)
  assert.strictEqual((await upgrade(port, '/pty/abc/connect')).status, 401)
  fs.writeFileSync(path.join(home, '.iris', 'remote-access.json'), JSON.stringify({ allow: false }))
  assert.strictEqual((await upgrade(port, `/pty/abc/connect?iris_token=${token}`)).status, 403)
  assert.strictEqual(eng.seen.length, 0)
})

test('CORS: preflight from the app answered without a token; real responses carry the origin', { timeout: 10000 }, async (t) => {
  const { port, eng, token } = await setup(t)
  const pre = await get(port, '/session', { origin: 'tauri://localhost', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type, x-opencode-directory' }, 'OPTIONS')
  assert.strictEqual(pre.status, 204)
  assert.strictEqual(pre.headers['access-control-allow-origin'], 'tauri://localhost')
  assert.match(pre.headers['access-control-allow-headers'], /authorization/)
  assert.match(pre.headers['access-control-allow-headers'], /content-type/)
  const other = await get(port, '/session', { origin: 'https://evil.example', 'access-control-request-method': 'POST' }, 'OPTIONS')
  assert.strictEqual(other.status, 403)
  assert.strictEqual(other.headers['access-control-allow-origin'], undefined)
  assert.strictEqual(eng.seen.length, 0, 'preflights never reach the engine')
  const real = await get(port, '/session', { origin: 'tauri://localhost', authorization: `Bearer ${token}` })
  assert.strictEqual(real.status, 200)
  assert.strictEqual(real.headers['access-control-allow-origin'], 'tauri://localhost')
  const refused = await get(port, '/session', { origin: 'tauri://localhost' })
  assert.strictEqual(refused.status, 401)
  assert.strictEqual(refused.headers['access-control-allow-origin'], 'tauri://localhost', 'the app can read why it was refused')
})

test('switch and heartbeat report: off by default, explicit when off, engine running/stopped', { timeout: 10000 }, async (t) => {
  const none = makeHome({ phone: null })
  assert.strictEqual(readSettings(none).enabled, false)
  const off = new PhoneEndpoint({ getKey: () => KEY, getNodeId: () => NODE, home: none, now: () => NOW, log: () => {} })
  off.tick()
  assert.strictEqual(off.server, null, 'nothing listens while off')
  assert.deepStrictEqual(off.report(), { enabled: false, url: null, engine: 'stopped', updated_at: new Date(NOW).toISOString() })

  const { ep, home } = await setup(t)
  const r = ep.report()
  assert.deepStrictEqual({ ...r, updated_at: undefined }, { enabled: true, url: 'https://box-phone.t.heyiris.io', engine: 'running', updated_at: undefined })
  assert.ok(!Number.isNaN(Date.parse(r.updated_at)))
  fs.writeFileSync(path.join(home, '.iris', 'remote-access.json'), JSON.stringify({ allow: false }))
  assert.strictEqual(ep.report().enabled, false, 'remote access off: the platform must not hand out tokens for it')
})

test('the tunnel keep-alive restarts the phone tunnel from phone.json, not inference.json', () => {
  const home = makeHome({ phone: { enabled: true, port: 3291, node: process.execPath, tunnel: { name: 'box-phone', runner: __filename } } })
  const spawned = []
  const ka = new TunnelKeepAlive({
    home,
    getApiBase: () => 'https://api.example',
    getKey: () => KEY,
    readSettings,
    probe: () => 22,
    log: () => {},
    spawnFn: (node, args) => { spawned.push(args); return { pid: 999999, unref () {} } }
  })
  assert.strictEqual(ka.tick().action, 'restart')
  assert.deepStrictEqual(spawned, [[__filename, '--name', 'box-phone', '--port', '3291']])
  assert.strictEqual(fs.readFileSync(path.join(home, '.iris', 'tunnels', 'box-phone', 'tunnel.pid'), 'utf8'), '999999')
})
