'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { normalizeHistoryRequest, PROVIDER_SLUGS } = require('../lib/session-history-request')

/**
 * Reading ONE session's transcript over bridge_call (epic #185632 — observation from the phone).
 *
 * Why not the CLI: `run_iris_command` shells out through tmux, and measured 2026-09-17 the SAME
 * command (`iris --version`, `iris sessions history <id>`) returned exit 1 with no output twice and
 * exit 0 twice on one machine. bridge_call runs in the daemon process — no shell, no PATH, no tmux.
 *
 * bridge_call passes args as QUERY PARAMETERS, so this normalises what arrives as strings.
 */
test('the platform vocabulary (claude_code) maps to the route slug (claude-code)', () => {
  assert.strictEqual(normalizeHistoryRequest({ id: 'abcd', provider: 'claude_code' }).providers[0], 'claude-code')
  assert.strictEqual(normalizeHistoryRequest({ id: 'abcd', provider: 'claude-code' }).providers[0], 'claude-code')
  assert.strictEqual(normalizeHistoryRequest({ id: 'abcd', provider: 'OpenCode' }).providers[0], 'opencode')
})

test('no provider means try them all, cheapest first', () => {
  assert.deepStrictEqual(normalizeHistoryRequest({ id: 'abcd' }).providers, PROVIDER_SLUGS)
  assert.deepStrictEqual(normalizeHistoryRequest({ id: 'abcd', provider: 'nonsense' }).providers, PROVIDER_SLUGS)
})

test('a session id is required and is never a path', () => {
  assert.strictEqual(normalizeHistoryRequest({}).error, 'id is required')
  // Too short to be a session id — a stray word must not become a filename probe.
  assert.match(normalizeHistoryRequest({ id: 'ab' }).error || '', /id/)
  assert.strictEqual(normalizeHistoryRequest({ id: '   ' }).error, 'id is required')
  for (const bad of ['../../etc/passwd', 'a/b', 'a\\b', 'a b', 'a;b', '$(x)']) {
    assert.match(normalizeHistoryRequest({ id: bad }).error || '', /id/, bad)
  }
  assert.strictEqual(normalizeHistoryRequest({ id: 'f92533d5-c998-4172-84ba-8caeacdbf46f' }).id, 'f92533d5-c998-4172-84ba-8caeacdbf46f')
  assert.strictEqual(normalizeHistoryRequest({ id: 'ses_f5265121cfferN8BLTciOmygUW' }).id, 'ses_f5265121cfferN8BLTciOmygUW')
})

test('limit is bounded — a transcript is read on a phone, not dumped', () => {
  assert.strictEqual(normalizeHistoryRequest({ id: 'abcd' }).limit, 20)
  assert.strictEqual(normalizeHistoryRequest({ id: 'abcd', limit: '5' }).limit, 5)
  assert.strictEqual(normalizeHistoryRequest({ id: 'abcd', limit: 500 }).limit, 100)
  assert.strictEqual(normalizeHistoryRequest({ id: 'abcd', limit: 0 }).limit, 1)
  assert.strictEqual(normalizeHistoryRequest({ id: 'abcd', limit: 'abc' }).limit, 20)
})

test('the LAST messages are what matters, and each is bounded', () => {
  const msgs = Array.from({ length: 30 }, (_, i) => ({ role: 'user', type: 'text', text: `m${i}` }))
  const { messages, omitted } = require('../lib/session-history-request').tailMessages(msgs, 5)
  assert.deepStrictEqual(messages.map((m) => m.text), ['m25', 'm26', 'm27', 'm28', 'm29'])
  assert.strictEqual(omitted, 25)

  const long = [{ role: 'assistant', type: 'text', text: 'x'.repeat(5000) }]
  const out = require('../lib/session-history-request').tailMessages(long, 5)
  assert.strictEqual(out.messages[0].text.length, 2000)
  assert.strictEqual(out.omitted, 0)
  assert.deepStrictEqual(require('../lib/session-history-request').tailMessages('nope', 5), { messages: [], omitted: 0 })
})
