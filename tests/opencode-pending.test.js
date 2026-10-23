'use strict'
const test = require('node:test')
const assert = require('node:assert')
const http = require('http')
const { pendingBySession, resolveAnswer, waitingFromPermission, waitingFromQuestion, permissionReply } = require('../lib/opencode-pending')

// #190649 — an IRIS Desktop session paused on a permission prompt or a question could be answered
// only at that Desktop. These are the engine's own pending requests, in the fleet's `waiting` shape.

const perm = { id: 'per_1', sessionID: 'ses_A', permission: 'bash', patterns: ['rm -rf dist'], metadata: {}, always: [] }
const ques = { id: 'que_1', sessionID: 'ses_B', questions: [
  { question: 'Which database?', header: 'DB', options: [{ label: 'Postgres', description: '' }, { label: 'SQLite', description: '' }] },
  { question: 'Which features?', header: 'Feat', multiple: true, custom: false, options: [{ label: 'Auth', description: '' }, { label: 'Billing', description: '' }] }
] }

test('a permission is one question with three options, held, in the Claude Code waiting shape', () => {
  const w = waitingFromPermission(perm)
  assert.strictEqual(w.kind, 'question')
  assert.strictEqual(w.held, true)
  assert.strictEqual(w.questions[0].question, 'Allow bash on rm -rf dist?')
  assert.deepStrictEqual(w.questions[0].options.map((o) => o.label), ['Allow once', 'Always allow', 'Reject'])
})

test('a permission answer maps to once / always / reject — and anything unrecognised is REFUSED, never allowed', () => {
  for (const [c, r] of [['1', 'once'], ['Allow once', 'once'], ['yes', 'once'], ['2', 'always'], ['always', 'always'], ['3', 'reject'], ['no', 'reject'], ['Reject', 'reject']]) {
    assert.strictEqual(permissionReply(c), r, c)
  }
  for (const c of ['', '4', 'maybe', 'sure thing', 'allow everything forever']) assert.strictEqual(permissionReply(c), null, c)
  assert.match(resolveAnswer(waitingFromPermission(perm), ['maybe']).error, /1 \(Allow once\)/)
  assert.deepStrictEqual(resolveAnswer(waitingFromPermission(perm), ['3']), { path: 'permission/per_1/reply', body: { reply: 'reject' } })
})

test('question answers: by number, by label (any case), multiple comma-separated, free text only where allowed', () => {
  const w = waitingFromQuestion(ques)
  assert.deepStrictEqual(resolveAnswer(w, ['2', 'auth, 2']), { path: 'question/que_1/reply', body: { answers: [['SQLite'], ['Auth', 'Billing']] } })
  assert.deepStrictEqual(resolveAnswer(w, ['MySQL please', '1']).body.answers, [['MySQL please'], ['Auth']])   // q1 allows custom
  assert.match(resolveAnswer(w, ['1', 'Payroll']).error, /not one of/)                                         // q2 does not
  assert.match(resolveAnswer(w, ['1']).error, /no answer/)
  // the {question: label} map the Claude Code path uses works too
  assert.deepStrictEqual(resolveAnswer(w, { 'Which database?': 'Postgres', 'Which features?': 'Billing' }).body.answers, [['Postgres'], ['Billing']])
})

test('pending: asked per server and directory; a question wins over a permission; failures never throw', async () => {
  const calls = []
  const fetchJson = async (url) => {
    calls.push(url)
    if (url.includes('/permission?')) return [perm, { id: 'per_2', sessionID: 'ses_B', permission: 'edit', patterns: [] }]
    if (url.includes('/question?')) return [ques]
    return null
  }
  const m = await pendingBySession({ servers: ['http://127.0.0.1:1'], directories: ['/a', '/a', ''], fetchJson })
  assert.strictEqual(calls.length, 2)                       // one directory (deduped), two endpoints
  assert.strictEqual(m.get('ses_A').waiting.opencode.type, 'permission')
  assert.strictEqual(m.get('ses_B').waiting.opencode.type, 'question')
  const none = await pendingBySession({ servers: ['x'], directories: ['/a'], fetchJson: async () => { throw new Error('down') } })
  assert.strictEqual(none.size, 0)
})

test('end to end against a fake engine: list the pending permission, answer it, the engine receives "reject"', async () => {
  let received = null
  const srv = http.createServer((req, res) => {
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.method === 'GET' && req.url.startsWith('/permission?directory=%2Fwork')) return json(200, [perm])
    if (req.method === 'GET' && req.url.startsWith('/question?')) return json(200, [])
    if (req.method === 'POST' && req.url === '/permission/per_1/reply?directory=%2Fwork') {
      let b = ''; req.on('data', (d) => { b += d }); req.on('end', () => { received = JSON.parse(b); json(200, true) }); return
    }
    json(404, {})
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  try {
    const fetchJson = async (url) => { const r = await fetch(url); return r.ok ? r.json() : null }
    const pending = (await pendingBySession({ servers: [base], directories: ['/work'], fetchJson })).get('ses_A')
    assert.ok(pending, 'the permission is found')
    const r = resolveAnswer(pending.waiting, ['no'])
    const resp = await fetch(`${base}/${r.path}?directory=${encodeURIComponent('/work')}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(r.body) })
    assert.strictEqual(resp.status, 200)
    assert.deepStrictEqual(received, { reply: 'reject' })
  } finally { srv.close() }
})
