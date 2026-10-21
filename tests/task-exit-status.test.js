// A som_batch that exited 1 was listed by `iris hive tasks` as "✓ completed" (#190300).
const test = require('node:test')
const assert = require('node:assert')
const { statusForExit } = require('../daemon/task-executor')

test('a som_batch that exits non-zero failed', () => {
  assert.strictEqual(statusForExit('som_batch', 1), 'failed')
})

test('exit 0 is completed for any type', () => {
  assert.strictEqual(statusForExit('som_batch', 0), 'completed')
  assert.strictEqual(statusForExit('discover', 0), 'completed')
})

test('requirement tests still fail on non-zero', () => {
  assert.strictEqual(statusForExit('custom_playwright', 1), 'failed')
})

test('other browser tasks keep the benign non-zero path', () => {
  assert.strictEqual(statusForExit('discover', 1), 'completed_with_warnings')
})
