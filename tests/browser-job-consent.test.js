// See daemon/browser-job-consent.js. 2026-10-23: 40 unassigned tasks were waiting in the cloud,
// 33 of them hourly `discover` runs going back two days; the Mac would inherit all of them.
const test = require('node:test')
const assert = require('node:assert')
const c = require('../daemon/browser-job-consent')

const NOW = Date.parse('2026-10-23T21:00:00Z')

test('a Mac announces browser jobs by default; other nodes stay quiet unless asked', () => {
  assert.strictEqual(c.consentMode({}, 'darwin'), 'notify')
  assert.strictEqual(c.consentMode({}, 'linux'), 'off')
  assert.strictEqual(c.consentMode({ IRIS_BROWSER_JOBS: 'ASK' }, 'darwin'), 'ask')
  assert.strictEqual(c.consentMode({ IRIS_BROWSER_JOBS: 'off' }, 'darwin'), 'off')
  assert.strictEqual(c.consentMode({ IRIS_BROWSER_JOBS: 'nonsense' }, 'linux'), 'off')
})

test('a job from a two-day backlog is stale; one from this hour is not', () => {
  assert.strictEqual(c.isStale({ created_at: '2026-10-21T21:00:45Z' }, NOW, 120), true)
  assert.strictEqual(c.isStale({ created_at: '2026-10-23T20:00:45Z' }, NOW, 120), false)
  assert.strictEqual(c.isStale({ created_at: '2026-10-21T21:00:45Z' }, NOW, 0), false, '0 turns the guard off')
  assert.strictEqual(c.isStale({}, NOW, 120), false, 'no timestamp, no guess')
})

test('the max age comes from the environment, 120 minutes by default', () => {
  assert.strictEqual(c.maxAgeMinutes({}), 120)
  assert.strictEqual(c.maxAgeMinutes({ IRIS_BROWSER_TASK_MAX_AGE_MIN: '30' }), 30)
  assert.strictEqual(c.maxAgeMinutes({ IRIS_BROWSER_TASK_MAX_AGE_MIN: 'x' }), 120)
})

test('the notification names the job, its arguments and where it came from', () => {
  const job = c.describeJob({ type: 'som_batch', title: 'hive_task_dispatch', prompt: 'limit=25 enrich=1 warmup=1', created_at: '2026-10-23T19:27:26Z', _source: 'pusher' }, NOW)
  assert.strictEqual(job.title, 'IRIS · SOM outreach')
  assert.match(job.message, /limit=25 enrich=1 warmup=1 — from a cloud schedule, queued 2 h ago/)
  assert.match(c.describeJob({ type: 'inbox_scan', _source: 'mesh', prompt: '' }, NOW).message, /no arguments — from another of your machines$/)
})

test('the dialog survives quotes in a prompt and offers Run or Skip with a time limit', () => {
  const s = c.dialogScript({ title: 'IRIS · Browser script', message: 'say "hi" \\ bye' }, 120)
  assert.match(s, /display dialog "say \\"hi\\" \\\\ bye/)
  assert.match(s, /buttons \{"Skip", "Run"\}/)
  assert.match(s, /giving up after 120$/)
})

test('only a clicked Run runs; Skip, no answer or an error do not', async () => {
  assert.strictEqual(c.parseDialog('button returned:Run, gave up:false\n'), 'run')
  assert.strictEqual(c.parseDialog('button returned:, gave up:true\n'), 'timeout')
  assert.strictEqual(c.parseDialog(''), 'skip')
  const fake = (out, err) => (cmd, args, opts, cb) => cb(err, out)
  assert.strictEqual(await c.askToRun({ title: 't', message: 'm' }, 5, fake('button returned:Run, gave up:false')), 'run')
  assert.strictEqual(await c.askToRun({ title: 't', message: 'm' }, 5, fake('', new Error('User canceled. (-128)'))), 'skip')
})
