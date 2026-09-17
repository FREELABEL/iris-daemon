'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { lastMessageAtFromChunk, MESSAGE_TYPES } = require('../lib/session-times')

/**
 * WHEN a session last actually said something (epic #185632).
 *
 * MEASURED 2026-09-17 across 12 real Claude Code transcripts: the file's mtime and the last real
 * message differ by up to 721 MINUTES. Claude Code appends lines that are not messages —
 * `attachment`, `system`, `ai-title`, `mode`, `permission-mode`, `atis-latch`, `bridge-session` —
 * and every one of them touches the file.
 *
 * The session list reported mtime as `updated_at`, so a session whose last message was twelve
 * hours ago showed as "now" and lit the live dot, while its transcript ended hours earlier. The
 * list was wrong, not the transcript.
 */

const line = (o) => JSON.stringify(o)
const msg = (role, ts, extra = {}) => line({ type: role, message: { role, content: 'x' }, timestamp: ts, ...extra })

test('the last USER or ASSISTANT message wins, not the last line', () => {
  const chunk = [
    msg('user', '2026-09-17T10:00:00.000Z'),
    msg('assistant', '2026-09-17T10:00:05.000Z'),
    line({ type: 'attachment', timestamp: '2026-09-17T22:00:00.000Z' }),
    line({ type: 'ai-title', title: 'x' }),
    line({ type: 'bridge-session' }),
  ].join('\n')

  assert.strictEqual(lastMessageAtFromChunk(chunk), '2026-09-17T10:00:05.000Z')
})

test('only the two message types count', () => {
  assert.deepStrictEqual(MESSAGE_TYPES, ['user', 'assistant'])
  const chunk = [
    msg('assistant', '2026-09-17T09:00:00.000Z'),
    line({ type: 'system', message: { role: 'system', content: 'x' }, timestamp: '2026-09-17T23:00:00.000Z' }),
    line({ type: 'summary', timestamp: '2026-09-17T23:30:00.000Z' }),
  ].join('\n')

  assert.strictEqual(lastMessageAtFromChunk(chunk), '2026-09-17T09:00:00.000Z')
})

test('a NON-message line carrying a message.role is still not a message', () => {
  // `summary` and `attachment` lines can carry a message block; only the line TYPE decides.
  const chunk = [
    msg('user', '2026-09-17T10:00:00.000Z'),
    line({ type: 'summary', message: { role: 'assistant', content: 'x' }, timestamp: '2026-09-17T23:00:00.000Z' }),
    line({ type: 'attachment', message: { role: 'user', content: 'x' }, timestamp: '2026-09-17T23:30:00.000Z' }),
  ].join('\n')

  assert.strictEqual(lastMessageAtFromChunk(chunk), '2026-09-17T10:00:00.000Z')
})

test('a message line whose ROLE is not user or assistant does not count', () => {
  const chunk = [
    msg('assistant', '2026-09-17T10:00:00.000Z'),
    line({ type: 'user', message: { role: 'tool', content: 'x' }, timestamp: '2026-09-17T23:00:00.000Z' }),
    line({ type: 'assistant', message: {}, timestamp: '2026-09-17T23:10:00.000Z' }),
  ].join('\n')

  assert.strictEqual(lastMessageAtFromChunk(chunk), '2026-09-17T10:00:00.000Z')
})

test('a message with no timestamp does not erase the last good one', () => {
  const chunk = [msg('user', '2026-09-17T08:00:00.000Z'), line({ type: 'assistant', message: { role: 'assistant', content: 'x' } })].join('\n')
  assert.strictEqual(lastMessageAtFromChunk(chunk), '2026-09-17T08:00:00.000Z')
})

test('a TRUNCATED first line is discarded — the chunk is the tail of a big file', () => {
  // Reading the last 256KB lands mid-line; parsing that half-line must not throw or invent a time.
  const good = msg('user', '2026-09-17T11:00:00.000Z')
  assert.strictEqual(lastMessageAtFromChunk('{"type":"assistant","messa' + '\n' + good), '2026-09-17T11:00:00.000Z')
})

test('nothing usable is null — never "now", never the file time', () => {
  assert.strictEqual(lastMessageAtFromChunk(''), null)
  assert.strictEqual(lastMessageAtFromChunk('not json\nalso not json'), null)
  assert.strictEqual(lastMessageAtFromChunk(line({ type: 'attachment', timestamp: '2026-09-17T22:00:00.000Z' })), null)
  assert.strictEqual(lastMessageAtFromChunk(undefined), null)
})

test('an unparseable timestamp is not a time', () => {
  assert.strictEqual(lastMessageAtFromChunk(msg('user', 'yesterday')), null)
  assert.strictEqual(lastMessageAtFromChunk([msg('user', '2026-09-17T07:00:00.000Z'), msg('user', 'nonsense')].join('\n')), '2026-09-17T07:00:00.000Z')
})

test('out-of-order lines: the LATEST message time wins, not the last one written', () => {
  const chunk = [msg('assistant', '2026-09-17T12:00:00.000Z'), msg('user', '2026-09-17T11:00:00.000Z')].join('\n')
  assert.strictEqual(lastMessageAtFromChunk(chunk), '2026-09-17T12:00:00.000Z')
})
