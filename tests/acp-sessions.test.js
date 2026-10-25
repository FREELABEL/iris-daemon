'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { listAcpSessions, findHolder, callHolder, registryDir } = require('../lib/acp-sessions')

// #191170 — sessions held open by `iris acp run --keep`. The record is what the CLI writes
// (packages/opencode/src/acp/holder.ts recordOf), token and port included.
function home (records) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-sessions-'))
  fs.mkdirSync(registryDir(h), { recursive: true })
  for (const r of records) fs.writeFileSync(path.join(registryDir(h), `${r.session_id}.json`), JSON.stringify(r))
  return h
}
const rec = (id, extra = {}) => ({
  session_id: id, provider: 'acp', agent: 'claude', agent_name: 'Claude Code', name: 'fix the parser',
  project_path: '/home/u/app', pid: process.pid, port: 4100, token: 'secret-token', status: 'waiting',
  waiting: { kind: 'question', held: true, questions: [{ header: 'Permission', question: 'Allow Edit a.txt [edit]?', options: [{ label: 'Allow', description: null }] }] },
  created_at: '2026-10-25T10:00:00.000Z', updated_at: '2026-10-25T10:05:00.000Z', message_count: 3, ...extra
})

test('lists live holders in the fleet shape, without the token or port', () => {
  const h = home([rec('a1'), rec('b2', { updated_at: '2026-10-25T11:00:00.000Z', status: 'idle', waiting: null })])
  const out = listAcpSessions(fs, h, 20, () => true)
  assert.deepStrictEqual(out.map((s) => s.session_id), ['b2', 'a1'])
  assert.strictEqual(out[1].provider, 'acp')
  assert.strictEqual(out[1].model, 'Claude Code')
  assert.strictEqual(out[1].waiting.questions[0].header, 'Permission')
  for (const s of out) {
    assert.ok(!('token' in s) && !('port' in s), 'token and port never leave the machine')
    assert.ok(!JSON.stringify(s).includes('secret-token'))
  }
})

test('a holder whose process is gone, or a malformed record, is not listed', () => {
  const h = home([rec('dead', { pid: 999999 }), rec('noport', { port: 'x' }), rec('ok')])
  fs.writeFileSync(path.join(registryDir(h), 'junk.json'), '{not json')
  const out = listAcpSessions(fs, h, 20, (pid) => pid === process.pid)
  assert.deepStrictEqual(out.map((s) => s.session_id), ['ok'])
})

test('no registry folder is an empty list, not an error', () => {
  assert.deepStrictEqual(listAcpSessions(fs, path.join(os.tmpdir(), 'nope-' + Date.now())), [])
})

test('forwards to the holder with its token, and reports an unreachable holder as 502', async () => {
  let seen
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen = { url: req.url, token: req.headers['x-acp-token'], body: JSON.parse(body || '{}') }
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'delivered', via: 'live' }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const h = home([rec('live1', { port })])
  const holder = findHolder(fs, h, 'live1', () => true)
  const out = await callHolder(fetch, holder, 'POST', '/message', { message: 'hi', from: 'phone' })
  assert.deepStrictEqual(out, { status: 202, body: { status: 'delivered', via: 'live' } })
  assert.deepStrictEqual(seen, { url: '/message', token: 'secret-token', body: { message: 'hi', from: 'phone' } })
  server.close()

  const gone = await callHolder(fetch, { ...holder, port: 1 }, 'POST', '/answer', { answers: ['1'] }, 1000)
  assert.strictEqual(gone.status, 502)
  assert.match(gone.body.error, /did not answer/)
})

test('an unknown session id finds no holder', () => {
  const h = home([rec('a1')])
  assert.strictEqual(findHolder(fs, h, 'zz', () => true), null)
})
