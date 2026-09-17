'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { sessionActivity, ACTIVE_MS } = require('../daemon/session-status')

/**
 * A session opencode says is WORKING is active, whatever its timestamp says (epic #185632, 4b).
 * A session with no measurement keeps the timestamp-derived status — and `activity: null`, which
 * means "not measured", never "waiting".
 */
const NOW = Date.parse('2026-09-17T06:00:00Z')
const ago = (ms) => new Date(NOW - ms).toISOString()

test('working or retrying makes a session active even if its transcript is hours old', () => {
  // A long tool call does not touch updated_at; opencode still reports busy.
  assert.deepStrictEqual(sessionActivity({ updated_at: ago(3 * 60 * 60 * 1000), activity: 'working' }, NOW), { status: 'active', activity: 'working' })
  assert.deepStrictEqual(sessionActivity({ updated_at: ago(3 * 60 * 60 * 1000), activity: 'retrying' }, NOW), { status: 'active', activity: 'retrying' })
  assert.deepStrictEqual(sessionActivity({ updated_at: null, activity: 'working' }, NOW), { status: 'active', activity: 'working' })
})

test('no measurement keeps the timestamp-derived status and says so with null', () => {
  assert.deepStrictEqual(sessionActivity({ updated_at: ago(60 * 1000) }, NOW), { status: 'active', activity: null })
  assert.deepStrictEqual(sessionActivity({ updated_at: ago(ACTIVE_MS + 60 * 1000), activity: null }, NOW), { status: 'idle', activity: null })
  assert.deepStrictEqual(sessionActivity({ updated_at: ago(3 * 24 * 60 * 60 * 1000) }, NOW), { status: 'stale', activity: null })
})

test('an activity value the daemon does not recognise is dropped, not trusted', () => {
  for (const bogus of ['busy', 'idle', 'waiting', 'WORKING', 1, true, {}]) {
    assert.deepStrictEqual(sessionActivity({ updated_at: ago(3 * 24 * 60 * 60 * 1000), activity: bogus }, NOW), { status: 'stale', activity: null }, String(bogus))
  }
})

test('the refresh uses it, and asks opencode — only opencode — for live status', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'index.js'), 'utf8')
  assert.match(SRC, /const live = slug === 'opencode' \? '&live=1' : ''/)
  assert.match(SRC, /\.\.\.sessionActivity\(s\)/)
})
