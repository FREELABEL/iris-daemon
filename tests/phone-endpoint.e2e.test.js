/**
 * The phone path end to end against a REAL IRIS Desktop engine (#194511, ADR-03):
 *
 *   hp1 token ──▶ daemon phone endpoint (this repo) ──▶ ~/.iris/desktop-engine.json ──▶ iris-cli serve
 *
 * phone-endpoint.test.js proves the endpoint against a stand-in server; this proves it against the
 * engine that ships in IRIS Desktop, which refuses a missing password (401) and an unknown Host (403)
 * — the two things a proxy most easily gets wrong. No relay and no tunnel: those are the platform's.
 *
 * Opt-in, because it needs the Desktop engine binary:
 *   IRIS_E2E_ENGINE=/Applications/IRIS.app/Contents/MacOS/iris-cli node --test tests/phone-endpoint.e2e.test.js
 */
const { test, before, after } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const net = require('net')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { createHandlers, signToken } = require('../daemon/phone-endpoint')
const { desktopEngines } = require('../lib/engine-auth')

const BIN = process.env.IRIS_E2E_ENGINE
const skip = !BIN && 'set IRIS_E2E_ENGINE to the IRIS Desktop engine (iris-cli) to run'

const KEY = crypto.randomBytes(24).toString('hex')
const NODE = '01a1801e-e2e-node'
const PASSWORD = crypto.randomBytes(24).toString('base64url')
let home, engineProc, enginePort, endpoint, endpointPort
let allowed = true

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
})

function call (pathname, { token, headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers }
    if (token) h.authorization = 'Basic ' + Buffer.from(`iris:${token}`).toString('base64')
    const req = http.request({ host: '127.0.0.1', port: endpointPort, path: pathname, method, headers: h }, (res) => {
      if (String(res.headers['content-type'] || '').includes('text/event-stream')) {
        // An event stream never ends: take the first chunk, then hang up.
        res.once('data', (chunk) => { res.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: String(chunk) }) })
        return
      }
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.setTimeout(15000, () => req.destroy(new Error(`timeout on ${pathname}`)))
    req.end()
  })
}

async function waitForEngine () {
  for (let i = 0; i < 60; i++) {
    const ok = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: enginePort, path: '/global/health', headers: { authorization: 'Basic ' + Buffer.from(`opencode:${PASSWORD}`).toString('base64') } }, (res) => { res.resume(); resolve(res.statusCode === 200) })
        .on('error', () => resolve(false))
    })
    if (ok) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('the Desktop engine did not answer /global/health within 30 s')
}

before(async () => {
  if (skip) return
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-phone-e2e-'))
  fs.mkdirSync(path.join(home, '.iris'))
  enginePort = await freePort()
  engineProc = spawn(BIN, ['serve', '--port', String(enginePort), '--hostname', '127.0.0.1'], {
    cwd: home,
    env: { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache'), OPENCODE_SERVER_PASSWORD: PASSWORD },
    stdio: 'ignore'
  })
  // What IRIS Desktop writes for local clients (engine_auth.rs): owner-only, the live pid.
  fs.writeFileSync(path.join(home, '.iris', 'desktop-engine.json'), JSON.stringify({ version: 1, port: enginePort, username: 'opencode', password: PASSWORD, pid: engineProc.pid }), { mode: 0o600 })
  await waitForEngine()

  const handlers = createHandlers({
    getKey: () => KEY,
    getNodeId: () => NODE,
    settings: () => ({ enabled: true }),
    allowed: () => allowed,
    engine: () => desktopEngines(home)[0] || null
  })
  endpointPort = await freePort()
  endpoint = http.createServer(handlers.request)
  endpoint.on('upgrade', handlers.upgrade)
  await new Promise((resolve) => endpoint.listen(endpointPort, '127.0.0.1', resolve))
})

after(() => {
  if (endpoint) endpoint.close()
  if (engineProc && engineProc.exitCode === null) engineProc.kill('SIGKILL')
  if (home) fs.rmSync(home, { recursive: true, force: true })
})

test('the engine itself refuses the request without its password (the thing the endpoint must add)', { skip }, async () => {
  const direct = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: enginePort, path: '/session' }, (res) => { res.resume(); resolve(res.statusCode) }))
  assert.strictEqual(direct, 401)
})

test('no token: 401 from the endpoint, and the engine is never asked', { skip }, async () => {
  const r = await call('/session')
  assert.strictEqual(r.status, 401)
  assert.strictEqual(JSON.parse(r.body).error, 'unauthorized')
})

test('a valid hp1 token reaches the real engine: /session answers 200 with JSON', { skip }, async () => {
  const r = await call('/session', { token: signToken({ key: KEY, nodeId: NODE }) })
  assert.strictEqual(r.status, 200, r.body)
  assert.ok(Array.isArray(JSON.parse(r.body)), `expected the engine's session list, got ${r.body.slice(0, 200)}`)
})

test('the engine accepts the proxied Host (it answers 403 to a Host it was not told about)', { skip }, async () => {
  const r = await call('/global/health', { token: signToken({ key: KEY, nodeId: NODE }), headers: { host: 'iris-hive-002-phone.t.heyiris.io' } })
  assert.strictEqual(r.status, 200, r.body)
})

test('a token for another machine, or signed with another key, is refused', { skip }, async () => {
  assert.strictEqual((await call('/session', { token: signToken({ key: KEY, nodeId: 'someone-else' }) })).status, 401)
  assert.strictEqual((await call('/session', { token: signToken({ key: 'wrong', nodeId: NODE }) })).status, 401)
})

test('an expired token is refused', { skip }, async () => {
  const token = signToken({ key: KEY, nodeId: NODE, ttlS: 60, now: Date.now() - 3600 * 1000 })
  assert.strictEqual((await call('/session', { token })).status, 401)
})

test('the event stream comes through unbuffered, with the token in the query (no header on an EventSource)', { skip }, async () => {
  const token = signToken({ key: KEY, nodeId: NODE })
  const r = await call(`/global/event?iris_token=${encodeURIComponent(token)}`)
  assert.strictEqual(r.status, 200)
  assert.match(String(r.headers['content-type']), /text\/event-stream/)
  assert.ok(r.body.length > 0, 'expected the first event before the stream closes')
})

test('the iPhone app origin gets CORS on a real engine reply', { skip }, async () => {
  const r = await call('/session', { token: signToken({ key: KEY, nodeId: NODE }), headers: { origin: 'tauri://localhost' } })
  assert.strictEqual(r.status, 200)
  assert.strictEqual(r.headers['access-control-allow-origin'], 'tauri://localhost')
})

test('"Allow access to this computer" OFF refuses even a valid token', { skip }, async () => {
  allowed = false
  try {
    const r = await call('/session', { token: signToken({ key: KEY, nodeId: NODE }) })
    assert.strictEqual(r.status, 403)
  } finally {
    allowed = true
  }
})

test('Desktop closed: 503 desktop_not_running, not a hang or a 502', { skip }, async () => {
  engineProc.kill('SIGKILL')
  await new Promise((r) => engineProc.once('exit', r))
  const r = await call('/session', { token: signToken({ key: KEY, nodeId: NODE }) })
  assert.strictEqual(r.status, 503)
  assert.strictEqual(JSON.parse(r.body).error, 'desktop_not_running')
})

// Not opt-in: the token the PLATFORM builds (fl-iris-api HivePhone::token, PHP) must verify here
// (JS). This vector was produced by fl-iris-api main's HivePhone::token on 2026-11-28 with exactly
// these inputs; if either side changes the format, one of these two assertions fails.
test('hp1 vector from fl-iris-api (PHP) verifies in the daemon (JS), and the JS signer agrees byte for byte', () => {
  const { verifyToken } = require('../daemon/phone-endpoint')
  const vector = 'hp1.01a1801e-8eb0-7191-bf97-32dbb3c50f93.1795843200.00112233445566778899aabb.badf240003681ecc89e1f81eba9457d8bd201f653fe4710191cdf42b3852fb37'
  const node = '01a1801e-8eb0-7191-bf97-32dbb3c50f93'
  const at = 1795800000 * 1000
  assert.deepStrictEqual(verifyToken(vector, { key: 'vector-key-194511', nodeId: node, now: at }), { ok: true, exp: 1795843200 })
  assert.strictEqual(signToken({ key: 'vector-key-194511', nodeId: node, ttlS: 43200, now: at, nonce: '00112233445566778899aabb' }), vector)
})
