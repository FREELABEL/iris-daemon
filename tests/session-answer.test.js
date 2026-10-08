'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { deliverAnswer, resolveAnswers } = require('../lib/session-answer')

/**
 * Answering a waiting question from another machine (epic #188549 S4). Both mechanisms here were
 * measured on Claude Code 2.1.290 before this was written: the hook's updatedInput.answers, and a
 * single option-number keystroke into the tmux pane. These tests pin WHICH one is used WHEN, and
 * that every case that cannot reach the prompt refuses instead of reporting success.
 */

const SID = '2acb6f45-30a2-4238-8a42-9bc0ba3f237c'
const TOOL = 'toolu_011oK5evtEurRVvcT7PgHLoW'
const Q = { question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'r' }, { label: 'Blue', description: 'b' }] }
const askLine = (questions = [Q]) => JSON.stringify({ type: 'assistant', timestamp: '2026-10-08T09:13:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: TOOL, name: 'AskUserQuestion', input: { questions } }] } })
const SCREEN = ' ☐ Color\nWhich color?\n❯ 1. Red\n  2. Blue\n  3. Type something.\nEnter to select · ↑/↓ to navigate · Esc to cancel\n'

function home ({ transcript = askLine() + '\n', holding, where } = {}) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-'))
  const proj = path.join(h, '.claude', 'projects', '-tmp-proj')
  fs.mkdirSync(proj, { recursive: true })
  if (transcript !== null) fs.writeFileSync(path.join(proj, `${SID}.jsonl`), transcript)
  const dir = path.join(h, '.iris', 'answers')
  fs.mkdirSync(dir, { recursive: true })
  if (holding) fs.writeFileSync(path.join(dir, `${SID}.holding.json`), JSON.stringify(holding))
  if (where) fs.writeFileSync(path.join(dir, `${SID}.where.json`), JSON.stringify(where))
  return h
}

const NOW = Date.parse('2026-10-08T09:14:00Z')
function deps (h, { alive = true, screen = SCREEN, paneGone = false } = {}) {
  const typed = []
  return {
    typed,
    fs,
    home: h,
    now: () => NOW,
    kill: (pid) => { if (!alive) throw new Error('ESRCH') },
    tmux: (args) => {
      if (paneGone) throw new Error("can't find pane")
      if (args.includes('capture-pane')) return screen
      if (args.includes('send-keys')) { typed.push(args); return '' }
      return ''
    }
  }
}
const HOLD = { tool_use_id: TOOL, pid: 4242, until: '2026-10-08T09:40:00Z' }
const WHERE = { tool_use_id: TOOL, tmux: { socket: '/tmp/tmux-1000/default', pane: '%3' } }
const answerFile = (h) => path.join(h, '.iris', 'answers', `${SID}.answer.json`)

test('HOLD: the hook is holding this question → the answer file is written for it', () => {
  const h = home({ holding: HOLD, where: WHERE })
  const d = deps(h)
  const out = deliverAnswer(d, SID, { 'Which color?': 'Blue' })
  assert.strictEqual(out.status, 200)
  assert.strictEqual(out.body.delivered, 'hook')
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(answerFile(h), 'utf8')), { tool_use_id: TOOL, answers: { 'Which color?': 'Blue' } })
  assert.strictEqual(d.typed.length, 0, 'never types while the hook holds')
})

test('KEYS: hook not holding, question on screen in a known pane → one option-number keystroke', () => {
  const h = home({ where: WHERE })
  const d = deps(h)
  const out = deliverAnswer(d, SID, { 'Which color?': 'blue' })
  assert.strictEqual(out.body.delivered, 'keys')
  assert.deepStrictEqual(d.typed, [['-S', '/tmp/tmux-1000/default', 'send-keys', '-t', '%3', '2']])
  assert.strictEqual(fs.existsSync(answerFile(h)), false)
})

test('a hold that expired, or whose hook process died, is not a hold', () => {
  for (const [holding, alive] of [[{ ...HOLD, until: '2026-10-08T09:00:00Z' }, true], [HOLD, false], [{ ...HOLD, tool_use_id: 'toolu_OLD' }, true]]) {
    const h = home({ holding, where: WHERE })
    const out = deliverAnswer(deps(h, { alive }), SID, ['2'])
    assert.strictEqual(out.body.delivered, 'keys', JSON.stringify(holding))
  }
})

test('the question is not on screen (answered locally a moment ago) → refuses, types nothing', () => {
  const h = home({ where: WHERE })
  const d = deps(h, { screen: '❯ \n auto mode on' })
  const out = deliverAnswer(d, SID, ['Blue'])
  assert.strictEqual(out.status, 409)
  assert.strictEqual(d.typed.length, 0)
})

test('not in tmux and no hold → refuses and says how to make it reachable', () => {
  const out = deliverAnswer(deps(home()), SID, ['Blue'])
  assert.strictEqual(out.status, 409)
  assert.strictEqual(out.body.delivered, false)
  assert.match(out.body.error, /tmux/)
  assert.match(out.body.error, /away/)
})

test('a where-file from an EARLIER question is not trusted for this one', () => {
  const d = deps(home({ where: { ...WHERE, tool_use_id: 'toolu_OLD' } }))
  assert.strictEqual(deliverAnswer(d, SID, ['Blue']).status, 409)
  assert.strictEqual(d.typed.length, 0)
})

test('the pane is gone → refuses', () => {
  assert.strictEqual(deliverAnswer(deps(home({ where: WHERE }), { paneGone: true }), SID, ['Blue']).status, 409)
})

test('nothing pending → 409; unknown session → 404; bad id → 400', () => {
  const answered = askLine() + '\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: TOOL, content: 'x' }] } }) + '\n'
  assert.strictEqual(deliverAnswer(deps(home({ transcript: answered, holding: HOLD })), SID, ['Blue']).status, 409)
  assert.strictEqual(deliverAnswer(deps(home({ transcript: null })), SID, ['Blue']).status, 404)
  for (const bad of ['../../etc/passwd', '', 'a b', 'x'.repeat(200), null]) {
    assert.strictEqual(deliverAnswer(deps(home()), bad, ['Blue']).status, 400, String(bad))
  }
})

test('free text and multi-question answers go through the hook, never as keystrokes', () => {
  const h = home({ where: WHERE })
  const d = deps(h)
  const out = deliverAnswer(d, SID, ['purple, actually'])
  assert.strictEqual(out.status, 409)
  assert.strictEqual(d.typed.length, 0)
  const h2 = home({ holding: HOLD })
  assert.deepStrictEqual(deliverAnswer(deps(h2), SID, ['purple, actually']).body.answers, { 'Which color?': 'purple, actually' })
})

test('resolveAnswers: label (any case), 1-based number, free text; out-of-range and missing refuse', () => {
  const w = { questions: [Q] }
  assert.deepStrictEqual(resolveAnswers(w, ['2']), { answers: { 'Which color?': 'Blue' }, picks: [2] })
  assert.deepStrictEqual(resolveAnswers(w, { 'Which color?': 'RED' }), { answers: { 'Which color?': 'Red' }, picks: [1] })
  assert.deepStrictEqual(resolveAnswers(w, ['teal']), { answers: { 'Which color?': 'teal' }, picks: [null] })
  assert.match(resolveAnswers(w, ['3']).error, /no option 3/)
  assert.match(resolveAnswers(w, {}).error, /no answer given/)
  assert.match(resolveAnswers(w, undefined).error, /no answer given/)
})

test('wired: the bridge route and the session_message answers branch', () => {
  const BRIDGE = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
  assert.match(BRIDGE, /app\.post\('\/api\/sessions\/claude-code\/:id\/answer'/)
  const EXEC = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'task-executor.js'), 'utf8')
  assert.match(EXEC, /const route = isAnswer \? 'answer' : 'message'/)
  assert.match(EXEC, /const failFlag = isAnswer \? '--fail-with-body' : '-f'/)
})

// MEASURED in the end-to-end run, 2026-10-08: while the hook holds, the transcript does NOT contain
// the AskUserQuestion tool_use yet — only attachment/ai-title lines. The fixtures above put the
// question in the transcript and passed; the real session returned "not waiting". These pin the fix.
const NOT_YET = JSON.stringify({ type: 'attachment' }) + '\n' + JSON.stringify({ type: 'ai-title', title: 'x' }) + '\n'
const HELD = { ...HOLD, asked_at: '2026-10-08T09:13:00Z', questions: [Q] }

test('during a hold the transcript has no question yet — the hold file is the source, and delivery works', () => {
  const h = home({ transcript: NOT_YET, holding: HELD })
  const out = deliverAnswer(deps(h), SID, ['2'])
  assert.strictEqual(out.status, 200)
  assert.strictEqual(out.body.delivered, 'hook')
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(answerFile(h), 'utf8')).answers, { 'Which color?': 'Blue' })
})

test('waitingFromHold: live hold → the question, marked held; dead, expired or empty → null', () => {
  const { waitingFromHold } = require('../lib/session-answer')
  const w = waitingFromHold(deps(home({ transcript: NOT_YET, holding: HELD })), SID)
  assert.strictEqual(w.held, true)
  assert.strictEqual(w.tool_use_id, TOOL)
  assert.strictEqual(w.questions[0].question, 'Which color?')
  assert.strictEqual(waitingFromHold(deps(home({ holding: HELD }), { alive: false }), SID), null)
  assert.strictEqual(waitingFromHold(deps(home({ holding: { ...HELD, until: '2026-10-08T09:00:00Z' } })), SID), null)
  assert.strictEqual(waitingFromHold(deps(home({ holding: { ...HELD, questions: [] } })), SID), null)
  assert.strictEqual(waitingFromHold(deps(home({ holding: HELD })), '../x'), null)
})

test('a held question is needs_you even when the transcript has no dated message yet', () => {
  const { sessionActivity } = require('../daemon/session-status')
  const held = { kind: 'question', held: true, tool_use_id: TOOL, questions: [Q] }
  assert.strictEqual(sessionActivity({ updated_at: null, waiting: held }, NOW).status, 'needs_you')
})

test('the bridge listing consults the live hold before the transcript', () => {
  const BRIDGE = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
  assert.match(BRIDGE, /const waiting = waitingFromHold\(HOLD_DEPS, sessionId\) \|\| waitingFromChunk\(tail\)/)
})
