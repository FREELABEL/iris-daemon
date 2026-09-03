'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { deriveSessionStatus, ACTIVE_MS, IDLE_MS } = require('../daemon/session-status')

const NOW = Date.parse('2026-09-03T20:00:00Z')
const ago = (ms) => new Date(NOW - ms).toISOString()

test('a session touched moments ago is active', () => {
  assert.strictEqual(deriveSessionStatus(ago(60 * 1000), NOW), 'active')
})

test('a session touched today but not recently is IDLE, not active', () => {
  assert.strictEqual(deriveSessionStatus(ago(4 * 60 * 60 * 1000), NOW), 'idle')
})

test('the 15-day-old session from the live fleet reads STALE', () => {
  // Measured: MacBookPro reported a session last touched 2026-08-19 as status 'active'.
  assert.strictEqual(deriveSessionStatus('2026-08-19T22:01:32.796Z', NOW), 'stale')
})

test('NO timestamp is unknown — absence is not activity', () => {
  // This is the exact bug: `s.status || 'active'` stamped 'active' when the provider said
  // nothing at all. Absence has to be its own answer.
  for (const v of [null, undefined, '']) {
    assert.strictEqual(deriveSessionStatus(v, NOW), 'unknown')
  }
})

test('an UNPARSEABLE timestamp is unknown, not active', () => {
  // Otherwise any provider with a malformed date reintroduces the bug through the back door.
  assert.strictEqual(deriveSessionStatus('not a date', NOW), 'unknown')
  assert.strictEqual(deriveSessionStatus('2026-13-45T99:99:99Z', NOW), 'unknown')
})

test('a FUTURE timestamp is a clock problem, not activity', () => {
  // Clock skew across a fleet is normal. Crediting it as "running" would make a
  // mis-set machine look permanently busy.
  assert.strictEqual(deriveSessionStatus(new Date(NOW + 3 * 60 * 60 * 1000).toISOString(), NOW), 'unknown')
})

test('small future skew inside the active window is tolerated', () => {
  // A few seconds ahead is ordinary NTP drift, not a broken clock.
  assert.strictEqual(deriveSessionStatus(new Date(NOW + 5000).toISOString(), NOW), 'active')
})

test('the boundaries land on the generous side', () => {
  assert.strictEqual(deriveSessionStatus(ago(ACTIVE_MS - 1000), NOW), 'active')
  assert.strictEqual(deriveSessionStatus(ago(ACTIVE_MS + 1000), NOW), 'idle')
  assert.strictEqual(deriveSessionStatus(ago(IDLE_MS - 1000), NOW), 'idle')
  assert.strictEqual(deriveSessionStatus(ago(IDLE_MS + 1000), NOW), 'stale')
})

test('every branch returns one of the four documented values', () => {
  const allowed = new Set(['active', 'idle', 'stale', 'unknown'])
  for (const v of [null, 'x', ago(0), ago(1e6), ago(1e10), new Date(NOW + 1e9).toISOString()]) {
    assert.ok(allowed.has(deriveSessionStatus(v, NOW)), `unexpected: ${deriveSessionStatus(v, NOW)}`)
  }
})
