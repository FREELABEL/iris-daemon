'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

/**
 * A capped list must say it was capped (epic #185632, step 1).
 *
 * MEASURED 2026-09-17: both live Macs in bloq 15 reported EXACTLY 50 sessions — 25 per provider
 * × 2 providers, the per-provider limit in _refreshSessionCache. The daemon already computed
 * which providers hit the cap and which it could not reach, logged both to its own console, and
 * sent neither. So the platform held "50 sessions" with no way to tell a complete list from a cut
 * one — the same silent-cap signature the old limit of 10 produced (exactly 20 on every node).
 *
 * The truncation is not dangerous for LIVENESS: the bridge sorts by updated_at desc before it
 * slices, so what the cap drops is the oldest. It is dangerous for the COUNT, which is the first
 * thing a fleet view prints.
 */
const { sessionReportFields, SESSIONS_PER_PROVIDER_LIMIT } = require('../daemon/session-status')

const SESSIONS = [{ session_id: 'a' }, { session_id: 'b' }]

test('an unreportable cycle sends NOTHING — not even the truncation fields', () => {
  // Absent is the server's "no update, keep what you have" signal. Sending truncation facts
  // without a list would stamp facts about a list that was not refreshed.
  assert.deepStrictEqual(
    sessionReportFields({ reportable: false, sessions: SESSIONS, truncated: ['opencode'], unreachable: [] }),
    {},
  )
})

test('a reportable cycle sends the list with what it could not see, named', () => {
  assert.deepStrictEqual(
    sessionReportFields({ reportable: true, sessions: SESSIONS, truncated: ['claude_code', 'opencode'], unreachable: ['ollama'] }),
    {
      active_sessions: SESSIONS,
      sessions_truncated: ['claude_code', 'opencode'],
      sessions_unreachable: ['ollama'],
      sessions_limit_per_provider: SESSIONS_PER_PROVIDER_LIMIT,
    },
  )
})

test('a complete list says so with EMPTY arrays, not by omission', () => {
  // [] means "I checked: nothing was cut". Omitting the key would read, on the server, as an
  // older daemon that cannot tell — a different fact.
  const f = sessionReportFields({ reportable: true, sessions: [], truncated: [], unreachable: [] })
  assert.deepStrictEqual(f.sessions_truncated, [])
  assert.deepStrictEqual(f.sessions_unreachable, [])
  assert.deepStrictEqual(f.active_sessions, [])
})

test('missing inputs on a reportable cycle become empty lists, never undefined', () => {
  const f = sessionReportFields({ reportable: true })
  assert.deepStrictEqual(f.active_sessions, [])
  assert.deepStrictEqual(f.sessions_truncated, [])
  assert.deepStrictEqual(f.sessions_unreachable, [])

  // A string is iterable: spread, 'opencode' would ship as eight one-letter providers.
  const g = sessionReportFields({ reportable: true, sessions: 'x', truncated: 'opencode', unreachable: 'ollama' })
  assert.deepStrictEqual(g.active_sessions, [])
  assert.deepStrictEqual(g.sessions_truncated, [])
  assert.deepStrictEqual(g.sessions_unreachable, [])
})

test('the arrays sent are copies — a later refresh cannot mutate a payload in flight', () => {
  const truncated = ['opencode']
  const unreachable = ['ollama']
  const f = sessionReportFields({ reportable: true, sessions: [], truncated, unreachable })
  truncated.push('claude_code')
  unreachable.length = 0
  assert.deepStrictEqual(f.sessions_truncated, ['opencode'])
  assert.deepStrictEqual(f.sessions_unreachable, ['ollama'])
})

test('reportable must be literally true', () => {
  assert.deepStrictEqual(sessionReportFields({ reportable: 'yes', sessions: SESSIONS }), {})
  assert.deepStrictEqual(sessionReportFields({ reportable: 1, sessions: SESSIONS }), {})
  assert.deepStrictEqual(sessionReportFields(), {})
})

test('the limit is the one the refresh actually uses', () => {
  assert.strictEqual(SESSIONS_PER_PROVIDER_LIMIT, 25)
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'index.js'), 'utf8')
  assert.match(SRC, /limit=\$\{SESSIONS_PER_PROVIDER_LIMIT\}/, 'the fetch must use the exported limit')
  assert.match(SRC, /rows\.length >= SESSIONS_PER_PROVIDER_LIMIT/, 'the truncation check must use the same limit')
  assert.ok(!/const PER_PROVIDER_LIMIT\s*=/.test(SRC), 'no second, local copy of the limit that could drift')
})

test('the heartbeat sends the truncation facts, not just the console', () => {
  // A field that is computed and never sent is the defect this file exists for.
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'index.js'), 'utf8')
  assert.match(
    SRC,
    /\.\.\.sessionReportFields\(\{\s*reportable: this\._sessionsReportable === true,\s*sessions: this\._sessionsReportable === true \? this\._getLocalSessions\(\) : \[\],\s*truncated: this\._cachedSessionsTruncated,\s*unreachable: this\._cachedSessionsUnreachable,?\s*\}\)/,
  )
})
