'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

/**
 * The heartbeat must distinguish "I looked and found none" from "I could not look" (#183538).
 *
 * MEASURED: a node was upgraded, restarted, and verified running the new code. Its bridge
 * could not serve /api/sessions/*, so the refresh found nothing and the daemon sent an empty
 * list. The server's `! empty()` guard refused to write it, so the fleet kept showing the
 * pre-upgrade payload — 20 sessions, all "active", oldest 15 days — and every later heartbeat
 * refreshed `sessions_updated_at` on top of it.
 *
 * The record therefore said: this node has 20 running sessions, confirmed seconds ago. All of
 * it false, and nothing said so.
 *
 * Source-contract assertions: the behaviour lives inside a large Daemon class that cannot be
 * constructed without a live bridge, so these pin the contract rather than pretending to
 * exercise it. A test that needed a running fleet would not run at all, and a test that does
 * not run is the thing this whole file is about.
 */
const SRC = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'index.js'), 'utf8')

test('the heartbeat OMITS active_sessions when the refresh could not run', () => {
  // Presence of the key is the signal. Always sending it — empty on failure — is what let a
  // node that had stopped reporting keep showing fossils as live.
  assert.match(
    SRC,
    /\.\.\.\(this\._sessionsReportable \? \{ active_sessions: this\._getLocalSessions\(\) \} : \{\}\)/,
    'active_sessions must be conditionally spread, not unconditionally set',
  )
})

test('reportability is DERIVED from reachability, never hardcoded true', () => {
  // It was `= true` on any completed loop, which is how a refresh that reached nothing still
  // announced "zero sessions". The flag must be computed from what we could actually ask.
  assert.ok(
    !/this\._sessionsReportable = true\b/.test(SRC),
    'reportability must not be hardcoded true — it has to be earned',
  )
  assert.match(SRC, /this\._sessionsReportable = unreachable\.length < providers\.length/)
})

test('a FAILED refresh marks it unreportable rather than reporting zero', () => {
  assert.match(SRC, /this\._sessionsReportable = false/)
})

test('the flag starts FALSE — nothing is confirmed before the first refresh', () => {
  // Starting true would mean a daemon that dies during its first refresh overwrites a good
  // list with an empty one, which is the same bug pointed the other way.
  // Anchored on the INIT pair, not on a refresh call: `_refreshSessionCache()` is invoked
  // from more than one place (startup and every ping), and the first textual occurrence is
  // the ping one. Slicing from the wrong anchor tested nothing and still passed five of six.
  assert.match(
    SRC,
    /this\._cachedSessions = \[\][\s\S]{0,400}?this\._sessionsReportable = false[\s\S]{0,80}?this\._refreshSessionCache\(\)/,
    'the flag must be initialised false alongside the cache, before the startup refresh',
  )
})

test('a failed refresh does NOT wipe the last known list', () => {
  // Keep the data, stop claiming it is current. Those are different actions and the old code
  // conflated them.
  const catchBlock = SRC.slice(SRC.indexOf('[sessions] refresh failed') - 400, SRC.indexOf('[sessions] refresh failed') + 200)
  assert.ok(
    !/this\._cachedSessions = \[\]/.test(catchBlock),
    'the failure path must not clear the cache — the server keeps the old list, unstamped',
  )
})

test('the failure is announced, not silent', () => {
  // A refresh that quietly stops is indistinguishable from one that keeps succeeding.
  assert.match(SRC, /\[sessions\] refresh failed/)
})

test('a provider we could NOT ASK is not counted as zero sessions', () => {
  // getJson resolves null for a non-200, a parse failure or a timeout. The old
  // `(data && data.sessions) || []` turned that into an empty list, so a node whose bridge
  // could not serve /api/sessions/* reported a confident "zero sessions". Same collapse as
  // the bug one layer up, one layer down.
  assert.match(SRC, /if \(data === null\) \{[\s\S]{0,120}?unreachable\.push\(name\)/)
})

test('all providers unreachable means UNREPORTABLE, not zero', () => {
  assert.match(SRC, /this\._sessionsReportable = unreachable\.length < providers\.length/)
})

test('a PARTIAL failure still reports, and names what was missed', () => {
  // What we did learn is true and useful. The gap has to be visible rather than implied by
  // an absence in the list.
  assert.match(SRC, /could not reach: .*their sessions are UNKNOWN, not zero/)
})
