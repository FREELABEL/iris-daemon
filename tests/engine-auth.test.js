'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { publishedEngines, engineHeaders } = require('../lib/engine-auth')

// #190647 — Desktop's engine gets a per-launch password, published to local clients in
// ~/.iris/desktop-engine.json (0600). The bridge must use it, and must not trust a file anyone
// else could have written or read.

function home (data, mode = 0o600) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-auth-'))
  fs.mkdirSync(path.join(h, '.iris'))
  if (data !== undefined) {
    const f = path.join(h, '.iris', 'desktop-engine.json')
    fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data))
    fs.chmodSync(f, mode)
  }
  return h
}
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64')

test('no file — today\'s Desktop — means no engines and no header, exactly as before', () => {
  assert.deepStrictEqual(publishedEngines(home()), [])
  assert.deepStrictEqual(engineHeaders('http://127.0.0.1:49244/session', []), {})
})

test('a 0600 file we own gives the engine and its Basic credential (username defaults to opencode)', () => {
  const e = publishedEngines(home({ version: 1, port: 49244, password: 's3cret', pid: 1 }))
  assert.deepStrictEqual(e, [{ base: 'http://127.0.0.1:49244', authorization: basic('opencode', 's3cret') }])
  assert.deepStrictEqual(engineHeaders('http://127.0.0.1:49244/session/ses_1/message', e), { Authorization: basic('opencode', 's3cret') })
  assert.deepStrictEqual(engineHeaders('http://localhost:49244/session', e), { Authorization: basic('opencode', 's3cret') })
})

test('the password goes only to that port — not a neighbour, not another host', () => {
  const e = publishedEngines(home({ port: 4924, password: 'p' }))
  assert.deepStrictEqual(engineHeaders('http://127.0.0.1:49244/session', e), {})
  assert.deepStrictEqual(engineHeaders('http://127.0.0.1:4924/session', e), { Authorization: basic('opencode', 'p') })
  assert.deepStrictEqual(engineHeaders('http://evil.example:4924/session', e), {})
})

test('a file others can read, or one another user owns, is ignored', { skip: process.platform === 'win32' }, () => {
  assert.deepStrictEqual(publishedEngines(home({ port: 1, password: 'p' }, 0o644)), [])
  assert.deepStrictEqual(publishedEngines(home({ port: 1, password: 'p' }, 0o640)), [])
  assert.deepStrictEqual(publishedEngines(home({ port: 1, password: 'p' }), process.getuid() + 1), [])
})

test('malformed files and entries are skipped, never thrown', () => {
  assert.deepStrictEqual(publishedEngines(home('{not json')), [])
  assert.deepStrictEqual(publishedEngines(home({ port: 'x', password: 'p' })), [])
  assert.deepStrictEqual(publishedEngines(home({ port: 70000, password: 'p' })), [])
  assert.deepStrictEqual(publishedEngines(home({ port: 1 })), [])
  assert.strictEqual(publishedEngines(home([{ port: 1, password: 'a' }, { port: 2, password: 'b', username: 'u' }])).length, 2)
})

test('end to end: a password-protected server refuses without the header and answers with it', async () => {
  const pass = 'per-launch'
  const srv = http.createServer((req, res) => {
    if (req.headers.authorization !== basic('opencode', pass)) { res.writeHead(401); return res.end() }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'ses_1' }))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  try {
    const url = `http://127.0.0.1:${port}/session/ses_1`
    assert.strictEqual((await fetch(url)).status, 401)
    const engines = publishedEngines(home({ port, password: pass }))
    const r = await fetch(url, { headers: engineHeaders(url, engines) })
    assert.strictEqual(r.status, 200)
    assert.strictEqual((await r.json()).id, 'ses_1')
  } finally { srv.close() }
})
