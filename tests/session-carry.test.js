'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { carryUnreachable } = require('../daemon/session-status')

/**
 * #190956 — sampled every 5 s on a loaded Mac, a live Desktop chat read YYYYYY.... : one
 * heartbeat carried 0 opencode rows because the lookup timed out, the server replaced the list,
 * and `iris hive ask` said "No session matching" for a chat that was open.
 */
const NOW = Date.parse('2026-10-23T17:00:00Z')
const ago = (ms) => new Date(NOW - ms).toISOString()
const prev = [
  { session_id: 'ses_desk', provider: 'opencode', name: 'Desktop chat', status: 'active', activity: 'working', updated_at: ago(60_000), waiting: null },
  { session_id: 'cc_1', provider: 'claude_code', name: 'cc', status: 'active', activity: null, updated_at: ago(60_000), waiting: null },
]

test('an unreachable provider keeps its last rows — measurement dropped, marked carried', () => {
  const rows = carryUnreachable(prev, ['opencode'], NOW)
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].session_id, 'ses_desk')
  assert.strictEqual(rows[0].carried, true)
  assert.strictEqual(rows[0].activity, null, 'a stale "working" must not be re-asserted')
  assert.strictEqual(rows[0].status, 'active', 'status re-derived from updated_at')
})

test('nothing unreachable, or nothing known before: nothing carried', () => {
  assert.deepStrictEqual(carryUnreachable(prev, [], NOW), [])
  assert.deepStrictEqual(carryUnreachable([], ['opencode'], NOW), [])
  assert.deepStrictEqual(carryUnreachable(undefined, ['opencode'], NOW), [])
})

test('a held question still reads needs_you when carried', () => {
  const held = { ...prev[0], waiting: { kind: 'question', held: true, questions: [{ question: 'Publish?' }] } }
  assert.strictEqual(carryUnreachable([held], ['opencode'], NOW)[0].status, 'needs_you')
})

test('wired: the refresh carries unreachable providers before sorting', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'index.js'), 'utf8')
  assert.match(SRC, /sessions\.push\(\.\.\.require\('\.\/session-status'\)\.carryUnreachable\(this\._cachedSessions, unreachable\)\)/)
})
