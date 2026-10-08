'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { waitingFromChunk, MAX_QUESTIONS, MAX_OPTIONS, MAX_TEXT } = require('../lib/session-waiting')
const { sessionActivity } = require('../daemon/session-status')

/**
 * Replay fixtures for "is this session blocked on a person?" (#188536, epic #188549).
 *
 * Every line below has the shape MEASURED on real Claude Code transcripts 2026-10-08: the question is
 * an assistant tool_use named AskUserQuestion, the answer a user tool_result with the same id. Each
 * case is a fixed byte string, so a failure reproduces exactly — same input, same verdict.
 */

const T = (m) => `2026-10-08T10:${String(m).padStart(2, '0')}:00.000Z`
const L = (o) => JSON.stringify(o)

const ask = (id, m, question = 'Which layout for the pricing section?') => L({
  type: 'assistant',
  timestamp: T(m),
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Three layouts are drafted. One question before I build.' },
      {
        type: 'tool_use',
        id,
        name: 'AskUserQuestion',
        input: {
          questions: [{
            question,
            header: 'Layout',
            multiSelect: false,
            options: [
              { label: 'Three tiers (Recommended)', description: 'With an annual toggle' },
              { label: 'One plan', description: 'One price' },
              { label: 'A table', description: 'Comparison table' }
            ]
          }]
        }
      }
    ]
  }
})
const answer = (id, m) => L({ type: 'user', timestamp: T(m), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Your questions have been answered: "Which layout?"="One plan".' }] } })
const say = (m, text = 'Done. Tests green.') => L({ type: 'assistant', timestamp: T(m), message: { role: 'assistant', content: [{ type: 'text', text }] } })
const bash = (id, m) => L({ type: 'assistant', timestamp: T(m), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }] } })
const noise = () => [L({ type: 'system', subtype: 'turn_duration' }), L({ type: 'attachment' }), L({ type: 'queue-operation' }), L({ type: 'ai-title', title: 'x' })].join('\n')
const tail = (...lines) => lines.join('\n') + '\n'

test('an unanswered question is waiting, with the question and every option', () => {
  const w = waitingFromChunk(tail(say(1, 'Looking.'), ask('toolu_A', 2), noise()))
  assert.strictEqual(w.kind, 'question')
  assert.strictEqual(w.tool_use_id, 'toolu_A')
  assert.strictEqual(w.asked_at, T(2))
  assert.strictEqual(w.questions[0].question, 'Which layout for the pricing section?')
  assert.deepStrictEqual(w.questions[0].options.map(o => o.label), ['Three tiers (Recommended)', 'One plan', 'A table'])
})

test('an answered question is not waiting', () => {
  assert.strictEqual(waitingFromChunk(tail(ask('toolu_A', 1), answer('toolu_A', 2), noise())), null)
})

test('two questions, the first answered and the second open: the second is what is waiting', () => {
  const w = waitingFromChunk(tail(ask('toolu_A', 1, 'First?'), answer('toolu_A', 2), say(3, 'ok'), ask('toolu_B', 4, 'Second?')))
  assert.strictEqual(w.tool_use_id, 'toolu_B')
  assert.strictEqual(w.questions[0].question, 'Second?')
})

test('an answer for a DIFFERENT question does not clear the open one', () => {
  const w = waitingFromChunk(tail(ask('toolu_B', 3), answer('toolu_OLD', 4)))
  assert.strictEqual(w && w.tool_use_id, 'toolu_B')
})

test('a tail cut mid-line before the question still finds it', () => {
  const full = tail(say(1, 'x'.repeat(400)), ask('toolu_A', 2))
  assert.strictEqual(waitingFromChunk(full.slice(37)).tool_use_id, 'toolu_A')
})

test('the answer is in the tail but the question fell outside it: NOT waiting', () => {
  // The window starts after the question; only the orphaned tool_result is visible.
  assert.strictEqual(waitingFromChunk(tail(answer('toolu_A', 2), say(3))), null)
})

test('an interrupt after the question clears it', () => {
  const interrupt = L({ type: 'user', timestamp: T(3), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } })
  assert.strictEqual(waitingFromChunk(tail(ask('toolu_A', 2), interrupt)), null)
})

test('a new typed prompt after the question clears it', () => {
  const typed = L({ type: 'user', timestamp: T(3), message: { role: 'user', content: 'actually, do the API first' } })
  assert.strictEqual(waitingFromChunk(tail(ask('toolu_A', 2), typed)), null)
})

test('the assistant speaking again after the question clears it', () => {
  assert.strictEqual(waitingFromChunk(tail(ask('toolu_A', 2), say(3, 'Never mind, going with one plan.'))), null)
})

test('a turn that simply ended is not "waiting on you" — only a question is', () => {
  assert.strictEqual(waitingFromChunk(tail(say(1, 'All done, PR is up.'), noise())), null)
})

test('a pending Bash call (could be a permission prompt OR a running build) is not reported', () => {
  assert.strictEqual(waitingFromChunk(tail(bash('toolu_X', 1))), null)
})

test('garbage, empty and non-string input give null and never throw', () => {
  for (const bad of [undefined, null, '', 42, {}, 'not json\n{"half":', '{"type":"assistant","message":{"content":"str"}}']) {
    assert.strictEqual(waitingFromChunk(bad), null, String(bad))
  }
  // A question with no usable questions[] is not a question.
  const empty = L({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'AskUserQuestion', input: {} }] } })
  assert.strictEqual(waitingFromChunk(empty), null)
})

test('the payload is bounded — it rides on every heartbeat', () => {
  const huge = L({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 't',
        name: 'AskUserQuestion',
        input: { questions: Array.from({ length: 9 }, () => ({ question: 'q'.repeat(5000), options: Array.from({ length: 20 }, (_, i) => ({ label: 'o' + i, description: 'd'.repeat(5000) })) })) }
      }]
    }
  })
  const w = waitingFromChunk(huge)
  assert.strictEqual(w.questions.length, MAX_QUESTIONS)
  assert.strictEqual(w.questions[0].options.length, MAX_OPTIONS)
  assert.ok(w.questions[0].question.length <= MAX_TEXT)
  assert.ok(JSON.stringify(w).length < 16 * 1024, `waiting payload is ${JSON.stringify(w).length} bytes`)
})

const NOW = Date.parse('2026-10-08T10:10:00Z')
const W = { kind: 'question', tool_use_id: 't', questions: [{ question: 'Which?', options: [] }] }

test('needs_you: a waiting session that spoke today', () => {
  assert.strictEqual(sessionActivity({ updated_at: T(5), waiting: W }, NOW).status, 'needs_you')
  assert.strictEqual(sessionActivity({ updated_at: '2026-10-08T01:00:00Z', waiting: W }, NOW).status, 'needs_you')
})

test('a question left on a prompt days ago is stale, not needs_you', () => {
  assert.strictEqual(sessionActivity({ updated_at: '2026-10-01T10:00:00Z', waiting: W }, NOW).status, 'stale')
})

test('no waiting, or a malformed one, leaves the old status untouched', () => {
  for (const w of [null, undefined, {}, { kind: 'question' }, { kind: 'question', questions: [] }, { kind: 'other', questions: [1] }]) {
    assert.strictEqual(sessionActivity({ updated_at: T(5), waiting: w }, NOW).status, 'active', JSON.stringify(w))
  }
})

test('both listing paths are wired: the bridge reads it from the tail, the heartbeat carries it', () => {
  const BRIDGE = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
  assert.match(BRIDGE, /const waiting = waitingFromHold\(HOLD_DEPS, sessionId\) \|\| waitingFromChunk\(tail\)/)
  assert.match(BRIDGE, /message_count: messageCount,\n\s+waiting,/)
  const DAEMON = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'index.js'), 'utf8')
  assert.match(DAEMON, /waiting: s\.waiting \|\| null,/)
})
