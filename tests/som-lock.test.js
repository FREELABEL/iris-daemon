// The SOM batch lock (#190291). On 2026-10-21 a batch on iris-hive-001 died at 03:40 and left
// /tmp/som_batch.lock behind. For the next 30 minutes every SOM run, including one dispatched
// from Hive, printed "ALREADY RUNNING", exited 0 and was reported as completed. The lock only
// looked at its age, never at whether its process was alive.
const test = require('node:test')
const assert = require('node:assert')
const { lockVerdict } = require('../som/som-lock')

const MIN = 60 * 1000
const now = Date.parse('2026-10-21T04:08:00Z')

test('a lock whose process is dead is stale at any age', () => {
  assert.strictEqual(lockVerdict({ pid: 920095, started: now - 28 * MIN }, now, () => false), 'stale')
  assert.strictEqual(lockVerdict({ pid: 920095, started: now - 1 * MIN }, now, () => false), 'stale')
})

test('a lock whose process is alive and young means a batch is running', () => {
  assert.strictEqual(lockVerdict({ pid: 1234, started: now - 5 * MIN }, now, () => true), 'busy')
})

test('a live lock older than 30 minutes is still treated as stale (a hung batch)', () => {
  assert.strictEqual(lockVerdict({ pid: 1234, started: now - 31 * MIN }, now, () => true), 'stale')
})

test('a corrupt lock is stale', () => {
  assert.strictEqual(lockVerdict(null, now, () => true), 'stale')
  assert.strictEqual(lockVerdict({ pid: 'x' }, now, () => true), 'stale')
})

test('the default liveness check finds this process alive and a nonsense pid dead', () => {
  const { pidAlive } = require('../som/som-lock')
  assert.strictEqual(pidAlive(process.pid), true)
  assert.strictEqual(pidAlive(2 ** 22 + 12345), false)
})

test('som-all.js uses the shared verdict instead of its own age-only check', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../som/som-all.js'), 'utf8')
  assert.match(src, /require\('\.\/som-lock'\)/)
  assert.doesNotMatch(src, /if \(age < maxAge\)/)
})
