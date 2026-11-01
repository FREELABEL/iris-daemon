'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawnSync } = require('child_process')

// #192113 — local IRIS servers require a per-start token, published in ~/.iris/servers/<port>.json.
// This daemon must use it, must never send it anywhere else, and must keep working against servers
// that do not ask. Everything here runs on fake servers on free ports under a temp HOME.

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-auth-servers-'))
process.env.HOME = ROOT
process.env.USERPROFILE = ROOT // os.homedir() on Windows
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const { publishedEngines, engineHeaders, loopbackPort, refusalReason, logRefusal } = require('../lib/engine-auth')
const { fetchSessionServerJson, findSessionServer, listServerSessions, refusedBody } = require('../lib/server-sessions')
const { opencodeActivity } = require('../lib/opencode-activity')
const { probeHosts } = require('../lib/session-host')

const TOKEN = 'fake-token-for-tests-only'
const basic = (p, u = 'opencode') => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64')
const DEAD_PID = spawnSync(process.execPath, ['-e', '']).pid
const posixOnly = { skip: process.platform === 'win32' }

const serversDir = () => path.join(ROOT, '.iris', 'servers')
const recordFile = (port) => path.join(serversDir(), `${port}.json`)

function publish (port, over = {}, mode = 0o600) {
  fs.mkdirSync(serversDir(), { recursive: true, mode: 0o700 })
  const file = recordFile(port)
  fs.writeFileSync(file, JSON.stringify({ version: 1, port, pid: process.pid, hostname: '127.0.0.1', username: 'opencode', password: TOKEN, ...over }))
  fs.chmodSync(file, mode)
}
function unpublish (port) { fs.rmSync(recordFile(port), { force: true }) }

/** A server like #435's (`token` set: 401 without it) or like today's (`token` unset: ignores it). */
async function fakeServer ({ token, host = '127.0.0.1', handler } = {}) {
  const seen = []
  const srv = http.createServer((req, res) => {
    seen.push(req.headers.authorization)
    if (handler) return handler(req, res)
    if (token && req.headers.authorization !== basic(token)) { res.writeHead(401); return res.end('unauthorized') }
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url.startsWith('/project/current')) return res.end(JSON.stringify({ worktree: '/w' }))
    if (req.url.startsWith('/experimental/session')) return res.end(JSON.stringify([{ id: 'ses_1', title: 't', time: {} }]))
    if (req.url.startsWith('/session/status')) return res.end(JSON.stringify({ ses_1: { type: 'busy' } }))
    res.end(JSON.stringify({ id: 'ses_1' }))
  })
  await new Promise((r) => srv.listen(0, host, r))
  const port = srv.address().port
  return { srv, port, seen, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(r)) }
}

// ── The token is sent ──────────────────────────────────────────────────────────────────────────

test('a new server: the token from its record gets in, on every call site', async () => {
  const s = await fakeServer({ token: TOKEN })
  publish(s.port)
  try {
    assert.strictEqual((await fetch(`${s.base}/session`)).status, 401, 'the fake server must really require it')
    assert.deepStrictEqual(await fetchSessionServerJson(`${s.base}/session/ses_1`, 2000), { id: 'ses_1' })
    assert.deepStrictEqual(await findSessionServer('ses_1', [s.base]), { base: s.base, refused: [] })
    const listed = await listServerSessions({ servers: [s.base], fetchJson: fetchSessionServerJson })
    assert.strictEqual(listed.answered, 1)
    assert.strictEqual(listed.rows[0].session_id, 'ses_1')
    const t = new Date().toISOString()
    const live = await opencodeActivity({ sessions: [{ session_id: 'ses_1', project_path: '/w', updated_at: t }], servers: [s.base], fetchJson: fetchSessionServerJson })
    assert.strictEqual(live.activity.ses_1, 'working')
    assert.deepStrictEqual(await probeHosts(fetch, [s.port]), [{ port: s.port, worktree: '/w' }])
    assert.strictEqual(s.seen.filter((a) => a === basic(TOKEN)).length, 5)
  } finally { unpublish(s.port); await s.close() }
})

test('every loopback spelling gets it; the username comes from the record', () => {
  publish(4100, { username: 'someone' })
  try {
    const want = { Authorization: basic(TOKEN, 'someone') }
    for (const u of ['http://127.0.0.1:4100/session', 'http://localhost:4100/x', 'http://127.1.2.3:4100', 'http://[::1]:4100/x', 'http://LOCALHOST:4100']) {
      assert.deepStrictEqual(engineHeaders(u), want, u)
    }
    assert.deepStrictEqual(engineHeaders('http://127.0.0.1:4101/session'), {}, 'a neighbouring port gets nothing')
  } finally { unpublish(4100) }
})

test('a record joins the candidates; Desktop stays first, and a port\'s own record wins on credentials', () => {
  const desktop = path.join(ROOT, '.iris', 'desktop-engine.json')
  publish(4110)
  publish(4111, { password: 'newer' })
  fs.writeFileSync(desktop, JSON.stringify([{ port: 4111, password: 'older', pid: process.pid }, { port: 4112, password: 'd', pid: process.pid }]))
  fs.chmodSync(desktop, 0o600)
  try {
    assert.deepStrictEqual(publishedEngines().map((e) => [e.base, e.authorization]), [
      ['http://127.0.0.1:4111', basic('newer')],
      ['http://127.0.0.1:4112', basic('d')],
      ['http://127.0.0.1:4110', basic(TOKEN)],
    ])
    assert.deepStrictEqual(engineHeaders('http://127.0.0.1:4111/x'), { Authorization: basic('newer') })
    assert.deepStrictEqual(engineHeaders('http://127.0.0.1:4112/x'), { Authorization: basic('d') })
  } finally { unpublish(4110); unpublish(4111); fs.rmSync(desktop, { force: true }) }
})

// ── The token goes nowhere else ────────────────────────────────────────────────────────────────

test('never to a remote host or a tunnel, whatever the URL is dressed as', () => {
  publish(443, { port: 443 })
  publish(4120)
  try {
    for (const u of [
      'https://demo.t.heyiris.io/session',
      'https://demo.t.heyiris.io:4120/session',
      'http://evil.example:4120/session',
      'http://127.0.0.1.evil.example:4120/session',
      'http://localhost.evil.example:4120/session',
      'http://127.0.0.1:4120@evil.example:4120/session',
      'http://evil.example:4120/127.0.0.1:4120',
      'http://10.0.0.5:4120/session',
      'http://100.64.0.1:4120/session',
      'http://0.0.0.0:4120/session',
      'https://127.0.0.1:443/session', // these servers speak plain http
      'http://user:pw@127.0.0.1:4120/session',
      'not a url',
    ]) {
      assert.deepStrictEqual(engineHeaders(u), {}, u)
      assert.deepStrictEqual(engineHeaders(u, publishedEngines()), {}, `${u} (explicit list)`)
    }
    assert.strictEqual(loopbackPort('http://evil.example:4120/'), null)
  } finally { unpublish(443); unpublish(4120) }
})

test('on the wire: this machine\'s own LAN address counts as remote, so it gets nothing', async (t) => {
  const lan = Object.values(os.networkInterfaces()).flat().find((n) => n && n.family === 'IPv4' && !n.internal)
  if (!lan) return t.skip('no non-loopback interface here')
  const s = await fakeServer({ host: '0.0.0.0' })
  publish(s.port)
  try {
    await fetchSessionServerJson(`http://${lan.address}:${s.port}/session/ses_1`, 2000)
    assert.deepStrictEqual(s.seen, [undefined])
  } finally { unpublish(s.port); await s.close() }
})

test('a local server redirecting elsewhere does not carry the token with it', async () => {
  const other = await fakeServer()
  const s = await fakeServer({ handler: (req, res) => { res.writeHead(302, { location: `${other.base}/session/ses_1` }); res.end() } })
  publish(s.port)
  try {
    await fetchSessionServerJson(`${s.base}/session/ses_1`, 2000)
    assert.deepStrictEqual(s.seen, [basic(TOKEN)])
    assert.deepStrictEqual(other.seen, [undefined])
  } finally { unpublish(s.port); await s.close(); await other.close() }
})

// ── A record that is not a credential ──────────────────────────────────────────────────────────

for (const [what, mode] of [['group-readable', 0o640], ['world-readable', 0o644], ['group-writable', 0o620]]) {
  test(`a ${what} record is ignored`, posixOnly, () => {
    publish(4130, {}, mode)
    try {
      assert.deepStrictEqual(engineHeaders('http://127.0.0.1:4130/x'), {})
      assert.deepStrictEqual(publishedEngines(), [])
    } finally { unpublish(4130) }
  })
}

test('a record another user owns is ignored', posixOnly, () => {
  publish(4131)
  try {
    assert.strictEqual(publishedEngines(ROOT).length, 1)
    assert.deepStrictEqual(publishedEngines(ROOT, process.getuid() + 1), [])
  } finally { unpublish(4131) }
})

test('a symlink is not a record', posixOnly, () => {
  publish(4132)
  fs.symlinkSync(recordFile(4132), recordFile(4133))
  try {
    assert.deepStrictEqual(engineHeaders('http://127.0.0.1:4133/x'), {})
  } finally { unpublish(4132); unpublish(4133) }
})

for (const [what, over] of [
  ['a dead pid', { pid: DEAD_PID }],
  ['no pid', { pid: undefined }],
  ['pid 0, which kill(2) calls alive', { pid: 0 }],
  ['a negative pid', { pid: -1 }],
  ['a pid that is not a number', { pid: String(process.pid) }],
  ['another port', { port: 4141 }],
  ['no password', { password: undefined }],
  ['an empty password', { password: '' }],
]) {
  test(`a record with ${what} is ignored`, () => {
    publish(4140, over)
    try {
      assert.deepStrictEqual(engineHeaders('http://127.0.0.1:4140/x'), {})
      assert.deepStrictEqual(publishedEngines(), [])
    } finally { unpublish(4140) }
  })
}

test('malformed files and strange names are skipped, never thrown', () => {
  fs.mkdirSync(serversDir(), { recursive: true, mode: 0o700 })
  const junk = ['4150.json', '.4150.123.ab.tmp', 'notes.txt', '99999.json'].map((n) => path.join(serversDir(), n))
  for (const f of junk) { fs.writeFileSync(f, '{not json'); fs.chmodSync(f, 0o600) }
  fs.mkdirSync(path.join(serversDir(), '4151.json'))
  try {
    assert.deepStrictEqual(publishedEngines(), [])
    assert.deepStrictEqual(engineHeaders('http://127.0.0.1:4150/x'), {})
    assert.deepStrictEqual(engineHeaders('http://127.0.0.1:4151/x'), {})
  } finally {
    for (const f of junk) fs.rmSync(f, { force: true })
    fs.rmdirSync(path.join(serversDir(), '4151.json'))
  }
})

test('Desktop\'s file now obeys the pid rule too; one with no pid still works, as it does today', () => {
  const desktop = path.join(ROOT, '.iris', 'desktop-engine.json')
  fs.mkdirSync(path.dirname(desktop), { recursive: true })
  fs.writeFileSync(desktop, JSON.stringify([{ port: 4160, password: 'gone', pid: DEAD_PID }, { port: 4161, password: 'nopid' }]))
  fs.chmodSync(desktop, 0o600)
  try {
    assert.deepStrictEqual(engineHeaders('http://127.0.0.1:4160/x'), {})
    assert.deepStrictEqual(engineHeaders('http://127.0.0.1:4161/x'), { Authorization: basic('nopid') })
  } finally { fs.rmSync(desktop, { force: true }) }
})

test('Windows: mode and uid cannot be checked and are skipped; pid and loopback still apply', { skip: process.platform === 'win32' }, () => {
  // Real Windows runs this whole file in CI. Here, the branch itself: the platform says win32 and
  // there is no getuid, which is what Node reports there.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  const getuid = process.getuid
  publish(4170, {}, 0o644)
  publish(4171, { pid: DEAD_PID }, 0o644)
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  process.getuid = undefined
  try {
    assert.deepStrictEqual(engineHeaders('http://127.0.0.1:4170/x'), { Authorization: basic(TOKEN) })
    assert.deepStrictEqual(engineHeaders('http://127.0.0.1:4171/x'), {})
    assert.deepStrictEqual(engineHeaders('http://evil.example:4170/x'), {})
  } finally {
    Object.defineProperty(process, 'platform', platform)
    process.getuid = getuid
    unpublish(4170); unpublish(4171)
  }
})

// ── Old servers and stale records: must not leak, must not block ───────────────────────────────

test('an old server with no record: nothing is sent, exactly as today', async () => {
  const s = await fakeServer()
  try {
    assert.deepStrictEqual(await fetchSessionServerJson(`${s.base}/session/ses_1`, 2000), { id: 'ses_1' })
    assert.deepStrictEqual(s.seen, [undefined])
  } finally { await s.close() }
})

test('no ~/.iris/servers at all, the state of every machine before #435, changes nothing', () => {
  assert.ok(!fs.existsSync(serversDir()) || fs.readdirSync(serversDir()).length === 0)
  assert.deepStrictEqual(publishedEngines(), [])
  assert.deepStrictEqual(engineHeaders('http://127.0.0.1:4096/session'), {})
})

test('an old server ignores the header if a record exists, and still answers', async () => {
  const s = await fakeServer()
  publish(s.port)
  try {
    assert.deepStrictEqual(await findSessionServer('ses_1', [s.base]), { base: s.base, refused: [] })
  } finally { unpublish(s.port); await s.close() }
})

test('a stale record on a reused port: the new listener gets no token and is still found', async () => {
  const s = await fakeServer()
  publish(s.port, { pid: DEAD_PID })
  try {
    assert.deepStrictEqual(await findSessionServer('ses_1', [s.base]), { base: s.base, refused: [] })
    assert.deepStrictEqual(s.seen, [undefined])
  } finally { unpublish(s.port); await s.close() }
})

test('a restarted server: the old token is refused once, clearly, and the new record is read next time', async () => {
  const s = await fakeServer({ token: 'second-start' })
  publish(s.port, { password: 'first-start' })
  try {
    const first = await findSessionServer('ses_1', [s.base])
    assert.strictEqual(first.base, null)
    assert.strictEqual(s.seen.length, 1, 'refused once, not retried')
    assert.match(first.refused[0].reason, /refused the credentials published for it \(HTTP 401\)/)
    publish(s.port, { password: 'second-start' })
    assert.strictEqual((await findSessionServer('ses_1', [s.base])).base, s.base)
  } finally { unpublish(s.port); await s.close() }
})

// ── A refusal says so ──────────────────────────────────────────────────────────────────────────

test('401 with no usable record: says what is missing, is not "not open here", and is not retried', async () => {
  const s = await fakeServer({ token: TOKEN })
  try {
    const { base, refused } = await findSessionServer('ses_1', [s.base])
    assert.strictEqual(base, null)
    assert.strictEqual(s.seen.length, 1)
    assert.deepStrictEqual(refused.map((r) => [r.server, r.status]), [[s.base, 401]])
    assert.match(refused[0].reason, new RegExp(`requires a token.*servers/${s.port}\\.json is missing`))
    const body = refusedBody('ses_1', refused)
    assert.strictEqual(body.code, 'session_server_refused')
    assert.match(body.error, /requires a token/)
  } finally { await s.close() }
})

test('a refused server does not hide the one that holds the session', async () => {
  const closed = await fakeServer({ token: TOKEN })
  const open = await fakeServer()
  try {
    const { base, refused } = await findSessionServer('ses_1', [closed.base, open.base])
    assert.strictEqual(base, open.base)
    assert.strictEqual(refused.length, 1)
  } finally { await closed.close(); await open.close() }
})

test('the list routes keep their null contract and collect the refusal once per server', async () => {
  const s = await fakeServer({ token: TOKEN })
  const refused = []
  try {
    assert.strictEqual(await fetchSessionServerJson(`${s.base}/session/status`, 2000, refused), null)
    assert.strictEqual(await fetchSessionServerJson(`${s.base}/experimental/session`, 2000, refused), null)
    assert.strictEqual(refused.length, 1)
    assert.strictEqual(refused[0].status, 401)
  } finally { await s.close() }
})

test('reasons: a tunnel 401 and a 403 Host say something different; other statuses are not refusals', () => {
  assert.match(refusalReason('https://demo.t.heyiris.io/session', 401), /only sends local credentials to servers on this machine/)
  assert.match(refusalReason('http://127.0.0.1:4180/x', 403), /OPENCODE_SERVER_ALLOWED_HOSTS/)
  for (const status of [200, 404, 500]) assert.strictEqual(refusalReason('http://127.0.0.1:4180/x', status), null)
})

test('no token in any reason, response body or log line', async () => {
  const s = await fakeServer({ token: 'something-else' })
  publish(s.port)
  const lines = []
  const original = console.warn
  console.warn = (...a) => lines.push(a.join(' '))
  try {
    const { refused } = await findSessionServer('ses_1', [s.base])
    const out = JSON.stringify([refusedBody('ses_1', refused), lines])
    assert.ok(lines.length >= 1, 'the refusal must be logged')
    assert.ok(!out.includes(TOKEN) && !out.includes(basic(TOKEN).slice(6)), 'a token reached a message')
  } finally { console.warn = original; unpublish(s.port); await s.close() }
})

test('the log line repeats at most every ten minutes per server', () => {
  const lines = []
  const log = (l) => lines.push(l)
  logRefusal('http://127.0.0.1:1', 'a', log, 1000)
  logRefusal('http://127.0.0.1:1', 'a', log, 2000)
  logRefusal('http://127.0.0.1:2', 'b', log, 2000)
  logRefusal('http://127.0.0.1:1', 'a', log, 1000 + 10 * 60 * 1000)
  assert.strictEqual(lines.length, 3)
})

// ── Wired ──────────────────────────────────────────────────────────────────────────────────────

test('wired: the bridge finds and asks session servers only through the credentialed helpers', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
  assert.match(SRC, /findSessionServer\(sid, sessionServerCandidates\(\), timeoutMs\)/)
  assert.match(SRC, /fetchSessionServerJson\(url, timeoutMs, refused\)/)
  assert.strictEqual((SRC.match(/refusedBody\(/g) || []).length, 3, 'message, answer and history each report a refusal')
  assert.ok(!/fetch\(`\$\{base\}/.test(SRC), 'a raw fetch to a session server skips the credentials')
})
