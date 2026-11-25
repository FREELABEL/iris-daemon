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

// inbox_scan crashed on every run on iris-hive-001 and was listed as completed (#194234).
test('an inbox_scan that exits non-zero failed', () => {
  assert.strictEqual(statusForExit('inbox_scan', 1), 'failed')
  assert.strictEqual(statusForExit('inbox_scan', 0), 'completed')
})

const { headedDisplayPrefix } = require('../daemon/task-executor')

test('a headed browser on a Linux box with no display gets a virtual one', () => {
  assert.strictEqual(headedDisplayPrefix({}, 'linux', true), 'xvfb-run -a ')
})

test('no prefix where a display exists or xvfb-run is missing', () => {
  assert.strictEqual(headedDisplayPrefix({ DISPLAY: ':0' }, 'linux', true), '')
  assert.strictEqual(headedDisplayPrefix({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux', true), '')
  assert.strictEqual(headedDisplayPrefix({}, 'darwin', true), '')
  assert.strictEqual(headedDisplayPrefix({}, 'linux', false), '')
})
