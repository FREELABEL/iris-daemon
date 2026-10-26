'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { SessionIndexBackfill, backfill, complete, toRow, PATH, EVERY_MS, RETRY_MS } = require('../daemon/session-index-backfill')

// #191232 — the full session list for `iris recall`; the heartbeat carries only 25 per provider.

const session = (id, extra = {}) => ({
  session_id: id,
  name: 'Hive chat fixes verified under load and tickets closed',
  project_path: '/Users/me/sites/freelabel',
  git_branch: null,
  model: 'iris/gpt-5.6-luna',
  updated_at: '2026-10-26T17:17:11.865Z',
  status: 'idle',
  messages: ['never sent'],
  ...extra
})

const bridgeWith = (lists) => async (path) => {
  const slug = /\/api\/sessions\/([^?]+)/.exec(path)[1]
  return slug in lists ? lists[slug] : { sessions: [] }
}

test('asks every provider for its whole list, not the heartbeat 25', async () => {
  const asked = []
  await backfill({ getJson: async (p) => { asked.push(p); return { sessions: [] } }, post: async () => ({}) })
  assert.deepStrictEqual(asked, [
    '/api/sessions/claude-code?limit=1000&counts=0',
    '/api/sessions/opencode?limit=1000&counts=0',
    '/api/sessions/codex?limit=1000&counts=0'
  ])
})

test('sends in chunks the server accepts, to the node-agent endpoint', async () => {
  const posts = []
  const many = Array.from({ length: 450 }, (_, i) => session(`ses_${i}`))
  const report = await backfill({
    getJson: bridgeWith({ opencode: { sessions: many } }),
    post: async (path, body) => { posts.push([path, body.sessions.length]); return { indexed: body.sessions.length } }
  })
  assert.deepStrictEqual(posts, [[PATH, 200], [PATH, 200], [PATH, 50]])
  assert.strictEqual(report.sent, 450)
  assert.strictEqual(report.indexed, 450)
  assert.ok(complete(report))
})

test('a row carries titles and ids only — never message text or live status', () => {
  const row = toRow(session('ses_a'), 'opencode')
  assert.deepStrictEqual(Object.keys(row).sort(), ['git_branch', 'label', 'model', 'name', 'project_path', 'provider', 'session_id', 'updated_at'])
  assert.strictEqual(row.provider, 'opencode')
})

test('an unreachable provider is unknown, not empty — and the pass is not complete', async () => {
  const report = await backfill({
    getJson: async (p) => (p.includes('codex') ? null : { sessions: [session('ses_a')] }),
    post: async () => ({ indexed: 1 })
  })
  assert.deepStrictEqual(report.unreachable, ['codex'])
  assert.strictEqual(complete(report), false)
})

test('a refused chunk does not stop the rest, and the pass is not complete', async () => {
  let n = 0
  const report = await backfill({
    getJson: bridgeWith({ opencode: { sessions: Array.from({ length: 300 }, (_, i) => session(`s${i}`)) } }),
    post: async () => { if (n++ === 0) throw new Error('HTTP 404: not found'); return { indexed: 100 } }
  })
  assert.strictEqual(report.failedChunks, 1)
  assert.strictEqual(report.sent, 100)
  assert.strictEqual(complete(report), false)
})

test('runs once when due, then waits a day — or 30 minutes after a failure', async () => {
  let t = 0
  const quiet = { log () {}, warn () {} }
  let calls = 0
  const ok = new SessionIndexBackfill({ getJson: async () => { calls++; return { sessions: [] } }, post: async () => ({}), now: () => t, log: quiet, firstDelayMs: 1000 })

  assert.strictEqual(await ok.maybeRun(), null) // not before the first delay
  t = 1000
  assert.ok(await ok.maybeRun())
  assert.strictEqual(calls, 3)
  t += EVERY_MS - 1
  assert.strictEqual(await ok.maybeRun(), null) // a day has not passed
  t += 1
  assert.ok(await ok.maybeRun())

  t = 0
  const failing = new SessionIndexBackfill({ getJson: async () => null, post: async () => ({}), now: () => t, log: quiet, firstDelayMs: 0 })
  await failing.maybeRun()
  assert.strictEqual(failing.nextAt, RETRY_MS)
})

test('never runs twice at once', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  let calls = 0
  const b = new SessionIndexBackfill({ getJson: async () => { calls++; await gate; return { sessions: [] } }, post: async () => ({}), now: () => 0, log: { log () {}, warn () {} }, firstDelayMs: 0 })
  const first = b.maybeRun()
  assert.strictEqual(await b.maybeRun(), null)
  release()
  await first
  assert.strictEqual(calls, 3)
})
