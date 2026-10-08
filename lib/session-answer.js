'use strict'

/**
 * Deliver an answer to a Claude Code session that is waiting on a question — from another machine
 * (epic #188549, S4).
 *
 * Measured 2026-10-08 on Claude Code 2.1.290 in tmux. A question can be answered from outside its
 * terminal in exactly two ways, and which one works depends on the moment:
 *
 *   HOLD   the PreToolUse hook (`iris hive answer-hook`) is holding the question open, waiting on
 *          a file. Write the answer there and the hook returns it as `updatedInput.answers` —
 *          Claude Code records "User answered Claude's questions: Which color? → Blue".
 *   KEYS   the hook has let go and the question is ON SCREEN. A single option-number keystroke
 *          into the session's tmux pane selects it ("2" → Pear, no Enter).
 *
 * The old path — `claude -p <msg> --resume <id>` — is neither. It starts a SECOND process on the
 * same session and the prompt on screen never hears about it. It is not used for answers.
 *
 * The hook and this module share one directory and three files per session:
 *   <sid>.where.json    written by the hook when a question fires: tool_use_id, tmux socket + pane
 *   <sid>.holding.json  written by the hook while it holds: tool_use_id, pid, until
 *   <sid>.answer.json   written HERE: tool_use_id, answers — the hook picks it up and deletes it
 *
 * Every refusal names why. "Delivered" is only said when a mechanism that was measured to work
 * was used; there is no fallback that reports success over a message nobody read (#184783).
 */

const path = require('path')
const { waitingFromChunk, cleanQuestions } = require('./session-waiting')
const { readTailChunk } = require('./session-times')

const ANSWERS_DIR = (home) => path.join(home, '.iris', 'answers')
const SAFE_ID = /^[A-Za-z0-9_-]{8,128}$/

function readJson (fs, p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

/** The transcript for a session id under ~/.claude/projects, or null. */
function findTranscript (fs, home, sessionId) {
  const root = path.join(home, '.claude', 'projects')
  let dirs
  try { dirs = fs.readdirSync(root) } catch { return null }
  for (const d of dirs) {
    const p = path.join(root, d, `${sessionId}.jsonl`)
    try { if (fs.statSync(p).isFile()) return p } catch { /* not here */ }
  }
  return null
}

/**
 * Turn what the caller sent into Claude Code's `answers` shape — { "<question text>": "<label>" } —
 * checked against the question that is ACTUALLY pending. Accepts a label, or a 1-based option
 * number, per question. A free-text answer is allowed (the prompt offers "Type something").
 *
 * @param waiting  from waitingFromChunk
 * @param given    { "<question>": "<label|number|text>" }  or  an array, one entry per question
 */
function resolveAnswers (waiting, given) {
  const qs = waiting.questions
  const list = Array.isArray(given) ? given : null
  const answers = {}
  const picks = [] // per question: 1-based option index, or null for free text
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i]
    const raw = list ? list[i] : (given && given[q.question])
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      return { error: `no answer given for: "${q.question}"` }
    }
    const s = String(raw).trim()
    const byNum = /^\d+$/.test(s) ? q.options[Number(s) - 1] : null
    if (/^\d+$/.test(s) && !byNum) return { error: `"${q.question}" has ${q.options.length} options — there is no option ${s}` }
    const byLabel = q.options.find((o) => o.label.toLowerCase() === s.toLowerCase())
    const opt = byNum || byLabel
    answers[q.question] = opt ? opt.label : s
    picks.push(opt ? q.options.indexOf(opt) + 1 : null)
  }
  return { answers, picks }
}

/** The hook's hold for this session if it is live: fresh and its process alive. */
function liveHold (deps, dir, sessionId) {
  const h = readJson(deps.fs, path.join(dir, `${sessionId}.holding.json`))
  if (!h || typeof h.tool_use_id !== 'string') return null
  if (!(Date.parse(h.until) > deps.now())) return null
  try { deps.kill(h.pid, 0) } catch { return null }
  return h
}

/** Is the hook still holding THIS question? */
function hookHolding (deps, dir, sessionId, toolUseId) {
  const h = liveHold(deps, dir, sessionId)
  return !!h && h.tool_use_id === toolUseId
}

/**
 * The question a live hold is waiting on, or null.
 *
 * MEASURED 2026-10-08 (Claude Code 2.1.290): while a PreToolUse hook runs, the AskUserQuestion
 * tool_use is NOT yet in the transcript — the tail holds only attachment/ai-title lines. It is
 * written after the hook returns. So during the hold, the only window in which a remote answer
 * can be delivered through the hook, the transcript cannot show the question. The hook can: it
 * writes the questions into its hold file, and this reads them back.
 */
function waitingFromHold (deps, sessionId) {
  if (!SAFE_ID.test(String(sessionId || ''))) return null
  const h = liveHold(deps, ANSWERS_DIR(deps.home), sessionId)
  if (!h) return null
  const questions = cleanQuestions({ questions: h.questions })
  if (!questions.length) return null
  return { kind: 'question', tool_use_id: h.tool_use_id, asked_at: h.asked_at || null, questions, held: true }
}

/**
 * @param deps { fs, home, now(), kill(pid, sig), tmux(args[]) -> string }
 * @returns { status, body }  — status is an HTTP status the bridge route returns as-is
 */
function deliverAnswer (deps, sessionId, given) {
  if (!SAFE_ID.test(String(sessionId || ''))) return { status: 400, body: { error: 'invalid session id' } }

  const transcript = findTranscript(deps.fs, deps.home, sessionId)
  if (!transcript) return { status: 404, body: { error: 'no Claude Code session with that id on this machine' } }

  // A live hold first: while the hook holds, the question is not in the transcript yet.
  const waiting = waitingFromHold(deps, sessionId) ||
    waitingFromChunk(readTailChunk(deps.fs, transcript, deps.fs.statSync(transcript).size))
  if (!waiting) return { status: 409, body: { error: 'that session is not waiting on a question right now', delivered: false } }

  const r = resolveAnswers(waiting, given)
  if (r.error) return { status: 422, body: { error: r.error, questions: waiting.questions } }

  const dir = ANSWERS_DIR(deps.home)

  // HOLD — the hook is waiting for exactly this.
  if (hookHolding(deps, dir, sessionId, waiting.tool_use_id)) {
    deps.fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = path.join(dir, `${sessionId}.answer.json`)
    const tmp = `${file}.${process.pid}.tmp`
    deps.fs.writeFileSync(tmp, JSON.stringify({ tool_use_id: waiting.tool_use_id, answers: r.answers }), { mode: 0o600 })
    deps.fs.renameSync(tmp, file) // atomic: the hook never reads half an answer
    return { status: 200, body: { delivered: 'hook', answers: r.answers } }
  }

  // KEYS — the question is on screen in a tmux pane we know.
  const where = readJson(deps.fs, path.join(dir, `${sessionId}.where.json`))
  const pane = where && where.tool_use_id === waiting.tool_use_id && where.tmux
  if (!pane || !pane.socket || !pane.pane) {
    return {
      status: 409,
      body: {
        delivered: false,
        error: 'the question is on a screen this machine cannot type into: the session is not running inside tmux, and away mode was off when it asked. Answer it there, or run it inside tmux / turn on `iris hive away` next time.'
      }
    }
  }
  if (waiting.questions.length !== 1 || waiting.questions[0].multiSelect || r.picks[0] === null) {
    return { status: 409, body: { delivered: false, error: 'on-screen answers support one single-choice question picked by option; this one needs the terminal (or away mode next time)' } }
  }

  // Check the screen right before typing. If someone answered locally a moment ago, a bare "2"
  // would land in the chat box as a message — the one failure here that does damage.
  let screen = ''
  try { screen = deps.tmux(['-S', pane.socket, 'capture-pane', '-p', '-t', pane.pane]) } catch (e) {
    return { status: 409, body: { delivered: false, error: `tmux pane is gone (${e.message})` } }
  }
  const q = waiting.questions[0]
  if (!screen.includes(q.question.slice(0, 60)) || !/Enter to select/.test(screen)) {
    return { status: 409, body: { delivered: false, error: 'the question is not on screen in its pane right now — not typing blind' } }
  }
  deps.tmux(['-S', pane.socket, 'send-keys', '-t', pane.pane, String(r.picks[0])])
  return { status: 200, body: { delivered: 'keys', answers: r.answers } }
}

module.exports = { deliverAnswer, resolveAnswers, findTranscript, waitingFromHold, ANSWERS_DIR, SAFE_ID }
