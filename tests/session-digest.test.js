'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { DIGEST_CHARS, claudeDigest, codexDigest, digestFor, enabled } = require('../lib/session-digest')
const { listCodexSessions } = require('../lib/codex-sessions')

const J = (o) => JSON.stringify(o)
const user = (text) => J({ type: 'user', message: { role: 'user', content: text } })
const userParts = (text) => J({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
const toolResult = () => J({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } })
const reply = (text) => J({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'tool_use', name: 'Bash' }] } })
const NOW = Date.parse('2026-11-26T18:00:00Z')

test('Claude Code: first ask from the head, last ask and last reply from the tail', () => {
  const head = [user('<command-name>/clear</command-name>'), user('fix the Chromebook download button'), reply('Looking.')].join('\n')
  const tail = ['{"cut line', userParts('ship it'), toolResult(), reply('I merged PR #452 and the button is live.')].join('\n')
  assert.deepStrictEqual(claudeDigest(head, tail), {
    first_ask: 'fix the Chromebook download button',
    last_ask: 'ship it',
    last_reply: 'I merged PR #452 and the button is live.'
  })
})

test('text the person did not type never becomes an ask', () => {
  const head = [user('<system-reminder>x</system-reminder>'), user('Caveat: local'), user('[Request interrupted by user]'), user('real question')].join('\n')
  assert.strictEqual(claudeDigest(head, '').first_ask, 'real question')
})

test('a short session (no tail chunk) still gets all three', () => {
  const head = [user('why is it slow'), reply('A 3 s spam check.')].join('\n')
  assert.deepStrictEqual(claudeDigest(head, ''), { first_ask: 'why is it slow', last_ask: 'why is it slow', last_reply: 'A 3 s spam check.' })
})

test('every field is cut to the limit, on whitespace-normalised text', () => {
  const d = claudeDigest(user('a  b\n' + 'x'.repeat(1000)), '')
  assert.ok(d.first_ask.length <= DIGEST_CHARS && d.first_ask.endsWith('…') && d.first_ask.startsWith('a b '))
})

test('Codex: user_message and agent_message events', () => {
  const ev = (type, message) => J({ timestamp: '2026-11-26T10:00:00Z', type: 'event_msg', payload: { type, message } })
  const head = [J({ type: 'session_meta', payload: { id: 'x', cwd: '/w' } }), ev('user_message', 'EU cards fail at checkout'), ev('agent_message', 'Reading the 3DS code.')].join('\n')
  const tail = [ev('user_message', 'run the tests again'), ev('agent_message', 'Two still fail. Mock or skip?')].join('\n')
  assert.deepStrictEqual(codexDigest(head, tail), { first_ask: 'EU cards fail at checkout', last_ask: 'run the tests again', last_reply: 'Two still fail. Mock or skip?' })
})

test('no digest for a session quiet for more than 48 h, with no date, or when switched off', () => {
  const head = [user('q'), reply('a')].join('\n')
  assert.ok(digestFor('claude', head, '', '2026-11-26T09:00:00Z', NOW, {}))
  assert.strictEqual(digestFor('claude', head, '', '2026-11-24T09:00:00Z', NOW, {}), null)
  assert.strictEqual(digestFor('claude', head, '', null, NOW, {}), null)
  assert.strictEqual(digestFor('claude', head, '', '2026-11-26T09:00:00Z', NOW, { IRIS_SESSION_DIGESTS: 'off' }), null)
  assert.strictEqual(enabled({ IRIS_SESSION_DIGESTS: 'OFF' }), false)
})

test('a session with nothing typed and nothing said gets no digest, not an empty one', () => {
  assert.strictEqual(digestFor('claude', toolResult(), '', '2026-11-26T09:00:00Z', NOW, {}), null)
})

test('the Codex lister attaches it to recent sessions', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-digest-'))
  const dir = path.join(home, '.codex', 'sessions', '2026', '11', '26')
  fs.mkdirSync(dir, { recursive: true })
  const now = new Date().toISOString()
  const ev = (type, message) => J({ timestamp: now, type: 'event_msg', payload: { type, message } })
  fs.writeFileSync(path.join(dir, 'rollout-2026-11-26T10-00-00-0b6f3c8e-1111-4222-8333-944455556666.jsonl'),
    [J({ timestamp: now, type: 'session_meta', payload: { id: 's1', cwd: '/w', timestamp: now } }), ev('user_message', 'upgrade deps'), ev('agent_message', '14 of 22 done.')].join('\n') + '\n')
  const [s] = listCodexSessions(fs, { HOME: home }, 5)
  assert.deepStrictEqual(s.digest, { first_ask: 'upgrade deps', last_ask: 'upgrade deps', last_reply: '14 of 22 done.' })
})

test('wired: the Claude Code lister and the heartbeat carry it', () => {
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8'), /digestFor\('claude', headLines\.join/)
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'daemon', 'index.js'), 'utf8'), /digest: s\.digest \|\| null/)
})
