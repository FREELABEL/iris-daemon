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

/* ── The page must be the NEWEST page, and the count must be honest ──────────────────────────
 * Measured 2026-09-17 on session 73d85563: the provider route sliced `messages.slice(0, 200)` —
 * the OLDEST 200 — and the wrapper then took the tail of THAT. The response said it last spoke
 * at 21:31:54Z while handing back messages that stopped at 19:16:26Z, 2h15m earlier, so the
 * session list and the transcript disagreed about the same session. A response that contradicts
 * itself is worse than one that admits it is truncated.
 */

const { newestMessages, omittedFrom, HISTORY_PAGE } = require('../lib/session-history-request')

test('a page of history is the newest page, never the oldest', () => {
    const msgs = Array.from({ length: 220 }, (_, i) => ({ role: 'user', type: 'text', text: `m${i}` }))
    const page = newestMessages(msgs, 60)
    assert.strictEqual(page.messages.length, 60)
    assert.strictEqual(page.messages[0].text, 'm160')
    assert.strictEqual(page.messages[59].text, 'm219', 'the LAST message in the session must be in the page')
    assert.strictEqual(page.total, 220)
    assert.strictEqual(page.omitted, 160)
})

test('a session shorter than the page omits nothing, and a junk list is empty not a crash', () => {
    const three = [{ text: 'a' }, { text: 'b' }, { text: 'c' }]
    assert.deepStrictEqual(newestMessages(three, 60), { messages: three, total: 3, omitted: 0 })
    assert.deepStrictEqual(newestMessages(null, 60), { messages: [], total: 0, omitted: 0 })
    assert.deepStrictEqual(newestMessages([], 60), { messages: [], total: 0, omitted: 0 })
})

test('a missing or nonsense limit falls back to a PAGE, never to the whole session', () => {
    // `slice(-0)` is `slice(0)` — the entire array. A session with 4,000 messages would have been
    // serialised in full to a phone by a caller that simply forgot the parameter.
    const many = Array.from({ length: 250 }, (_, i) => ({ text: `m${i}` }))
    for (const bad of [0, -5, NaN, undefined, null, 'sixty']) {
        const page = newestMessages(many, bad)
        assert.strictEqual(page.messages.length, HISTORY_PAGE, `limit ${String(bad)} must page at ${HISTORY_PAGE}`)
        assert.strictEqual(page.messages[page.messages.length - 1].text, 'm249', 'and it is still the newest page')
        assert.strictEqual(page.omitted, 50)
    }
})

test('"earlier messages not shown" counts against the whole session, not against the page', () => {
    // The old count was 140 — messages dropped from an already-truncated 200 — while the session
    // actually held 1030 the reader could not see. A wrong number reads as a true one.
    assert.strictEqual(omittedFrom(1030, 140, 60), 970);
    // No total from the machine: fall back to what the slice knows, rather than inventing one.
    assert.strictEqual(omittedFrom(undefined, 140, 60), 140);
    assert.strictEqual(omittedFrom('lots', 140, 60), 140);
    // A total smaller than what was shown is not believable; the slice wins.
    assert.strictEqual(omittedFrom(10, 140, 60), 140);
    assert.strictEqual(omittedFrom(60, 0, 60), 0);
})

test('a byte cursor is accepted, and nonsense is simply absent rather than zero', () => {
    // `since: 0` and `since: absent` MUST differ — 0 means "I have nothing, stream me everything
    // from the start", absent means "this is a first open, give me the page and the totals".
    assert.strictEqual(normalizeHistoryRequest({ id: 'abcd' }).since, undefined)
    assert.strictEqual(normalizeHistoryRequest({ id: 'abcd', since: '0' }).since, 0)
    assert.strictEqual(normalizeHistoryRequest({ id: 'abcd', since: '4096' }).since, 4096)
    assert.strictEqual(normalizeHistoryRequest({ id: 'abcd', since: 4096 }).since, 4096)
    for (const bad of ['', 'abc', '-1', null, undefined, {}]) {
        assert.strictEqual(normalizeHistoryRequest({ id: 'abcd', since: bad }).since, undefined, `since=${JSON.stringify(bad)}`)
    }
})
