// See daemon/task-age.js. 2026-11-01 22:42 UTC: a weeks-old `railway redeploy -e production -s fl-api`
// came out of a released cloud backlog and redeployed production. Only browser jobs had an age limit.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const a = require('../daemon/task-age')

const NOW = Date.parse('2026-11-01T22:42:00Z')
const REDEPLOY = { id: 'redeploy-1', type: 'test_run', prompt: 'railway redeploy -e production -s fl-api', created_at: '2026-10-11T09:00:00Z' }

test('the weeks-old redeploy is expired, not run', () => {
  const v = a.expiry(REDEPLOY, { now: NOW, maxAge: 1440 })
  assert.ok(v, 'expired')
  assert.match(v.reason, /Queued 22 days/)
  assert.match(v.reason, /IRIS_TASK_MAX_AGE_MIN/)
})

test('a task from this hour runs; 0 turns the guard off; no timestamp, no guess', () => {
  assert.strictEqual(a.expiry({ created_at: '2026-11-01T22:00:00Z' }, { now: NOW, maxAge: 1440 }), null)
  assert.strictEqual(a.expiry(REDEPLOY, { now: NOW, maxAge: 0 }), null)
  assert.strictEqual(a.expiry({ id: 'a2a' }, { now: NOW, maxAge: 1440 }), null)
})

test('the max age comes from the environment, 24 hours by default', () => {
  assert.strictEqual(a.maxAgeMinutes({}), 1440)
  assert.strictEqual(a.maxAgeMinutes({ IRIS_TASK_MAX_AGE_MIN: '60' }), 60)
  assert.strictEqual(a.maxAgeMinutes({ IRIS_TASK_MAX_AGE_MIN: '0' }), 0)
  assert.strictEqual(a.maxAgeMinutes({ IRIS_TASK_MAX_AGE_MIN: 'x' }), 1440)
})

test('a deadline decides: past it is expired, before it runs however old the task is', () => {
  const old = { ...REDEPLOY, not_after: '2026-11-02T00:00:00.000Z' }
  assert.strictEqual(a.expiry(old, { now: NOW, maxAge: 1440 }), null, 'caller said it is still wanted')
  const late = { created_at: '2026-11-01T22:41:00Z', not_after: '2026-11-01T22:41:30.000Z' }
  assert.match(a.expiry(late, { now: NOW, maxAge: 1440 }).reason, /Past its deadline/)
  assert.match(a.expiry(late, { now: NOW, browser: true }).reason, /Past its deadline/, 'browser jobs keep their deadline too')
})

test('browser jobs are left to their own stricter check; a fan-out join waits by design', () => {
  assert.strictEqual(a.expiry(REDEPLOY, { now: NOW, maxAge: 1440, browser: true }), null)
  assert.strictEqual(a.expiry({ ...REDEPLOY, metadata: { _join: true } }, { now: NOW, maxAge: 1440 }), null)
})

test('execute() reports the stale shell task expired and never runs it', async () => {
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'task-age-home-'))
  const { TaskExecutor } = require('../daemon/task-executor')
  const { WorkspaceManager } = require('../daemon/workspace-manager')
  const marker = path.join(process.env.HOME, 'ran')
  const sent = []
  const cloud = { submitResult: async (id, body) => { sent.push({ id, body }) }, reportProgress: async () => {}, post: async () => ({}) }
  const ex = new TaskExecutor(cloud, new WorkspaceManager(path.join(process.env.HOME, 'data')))
  ex.tmux = { available: false, cleanup () {}, cleanupAll () {} }
  const created = new Date(Date.now() - 22 * 24 * 3600 * 1000).toISOString()
  const origLog = console.log; console.log = () => {}
  try {
    await ex.execute({ id: 'stale-redeploy-0001', type: 'test_run', prompt: `touch ${marker}`, created_at: created })
  } finally { console.log = origLog }
  assert.strictEqual(fs.existsSync(marker), false, 'the command ran')
  assert.strictEqual(sent.length, 1)
  assert.strictEqual(sent[0].body.status, 'expired')
  assert.match(sent[0].body.error, /Queued 22 days/)
})
