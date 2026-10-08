'use strict'

/**
 * Is a Claude Code session WAITING ON A PERSON right now — and for what? (#188536, epic #188549)
 *
 * Session status was time-only (daemon/session-status.js): a session that asked "which layout?" an
 * hour ago and has been sitting on the prompt since read as `idle`, exactly like one that finished.
 * The one state worth interrupting someone for was the one the fleet could not show.
 *
 * The answer is already on disk. MEASURED 2026-10-08 on three real transcripts: a question is an
 * assistant `tool_use` named `AskUserQuestion` whose `input.questions[]` carries question, header,
 * multiSelect and options[{label, description}]. Its answer arrives as a user `tool_result` with the
 * same `tool_use_id`. So "waiting" is: the most recent question has no answer after it, and the
 * assistant has not spoken since.
 *
 * Pure function of the tail chunk the bridge already reads for `updated_at` — no hook, no second
 * file read. Same bytes, same verdict, every time, which is what makes it replay-testable.
 *
 * What it deliberately does NOT claim:
 *   - A pending Bash/Edit tool_use (a permission prompt) is indistinguishable here from a tool that
 *     is still running. Reporting it would turn every long build into "needs you". Not reported.
 *   - A question older than the tail window cannot be seen. Its answer, if any, is then also outside
 *     the window or unmatched — either way nothing pending is found, and null is "cannot tell".
 */

const QUESTION_TOOL = 'AskUserQuestion'

// This rides on EVERY heartbeat for every session, so it is bounded. The tool itself allows 1–4
// questions of 2–4 options; the caps leave room above that and stop a pathological input there.
const MAX_QUESTIONS = 4
const MAX_OPTIONS = 6
const MAX_TEXT = 500
const MAX_DESC = 200

const clip = (str, n) => (str.length > n ? str.slice(0, n - 1) + '…' : str)

function blocksOf (evt) {
  const content = evt && evt.message && evt.message.content
  return Array.isArray(content) ? content : []
}

function cleanOption (o) {
  if (!o || typeof o !== 'object') return null
  const label = typeof o.label === 'string' ? o.label : null
  if (!label) return null
  return { label: clip(label, MAX_DESC), description: typeof o.description === 'string' ? clip(o.description, MAX_DESC) : null }
}

function cleanQuestions (input) {
  const qs = input && Array.isArray(input.questions) ? input.questions : []
  const out = []
  for (const q of qs) {
    if (!q || typeof q.question !== 'string' || q.question === '') continue
    out.push({
      question: clip(q.question, MAX_TEXT),
      header: typeof q.header === 'string' ? clip(q.header, MAX_DESC) : null,
      multiSelect: q.multiSelect === true,
      options: (Array.isArray(q.options) ? q.options : []).map(cleanOption).filter(Boolean).slice(0, MAX_OPTIONS)
    })
    if (out.length === MAX_QUESTIONS) break
  }
  return out
}

/**
 * @param {string} chunk the transcript tail (may start mid-line)
 * @returns {null | {kind: 'question', tool_use_id: string, asked_at: string|null, questions: Array}}
 */
function waitingFromChunk (chunk) {
  if (typeof chunk !== 'string' || chunk === '') return null

  // The latest unanswered question, or null. Walked in file order: Claude Code appends.
  let pending = null

  for (const line of chunk.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed[0] !== '{') continue

    let evt
    try { evt = JSON.parse(trimmed) } catch { continue } // the truncated first line of a tail
    if (!evt || (evt.type !== 'assistant' && evt.type !== 'user')) continue

    if (evt.type === 'assistant') {
      let asked = null
      for (const b of blocksOf(evt)) {
        if (b && b.type === 'tool_use' && b.name === QUESTION_TOOL && typeof b.id === 'string') {
          const questions = cleanQuestions(b.input)
          if (questions.length) asked = { kind: 'question', tool_use_id: b.id, asked_at: typeof evt.timestamp === 'string' ? evt.timestamp : null, questions }
        }
      }
      // Any assistant turn after a question means the conversation moved on without (or after) an
      // answer — e.g. an interrupt. Only a question in THIS event keeps something pending.
      pending = asked
      continue
    }

    // user: an answer to the pending question clears it. So does an interrupt, which Claude Code
    // writes as a user text block rather than a tool_result.
    if (!pending) continue
    // A plain-string user turn is a person typing a new prompt: they are not waiting on the question.
    if (evt.message && typeof evt.message.content === 'string' && evt.message.content !== '') { pending = null; continue }
    for (const b of blocksOf(evt)) {
      if (!b) continue
      if (b.type === 'tool_result' && b.tool_use_id === pending.tool_use_id) { pending = null; break }
      if (b.type === 'text' && typeof b.text === 'string' && b.text.startsWith('[Request interrupted by user')) { pending = null; break }
    }
  }

  return pending
}

module.exports = { waitingFromChunk, QUESTION_TOOL, MAX_QUESTIONS, MAX_OPTIONS, MAX_TEXT }
