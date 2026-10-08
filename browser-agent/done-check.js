'use strict'

/**
 * A done that claims a change must be backed by one.
 *
 * Measured 2026-10-03: gpt-5-nano called one read-only page tool (search_availability), then
 * answered {"type":"done","result":"Reservation created … R-####"} — a placeholder id for a
 * booking that never happened — and the loop scored the run success:true. The model's word was
 * the only evidence, and the loop took it.
 *
 * Page tools make the claim checkable. A run that says it booked, created, subscribed or paid
 * must contain at least one action that could have changed something: a page tool that is not
 * read-only and returned ok, or a click / type / keypress that succeeded. If there is none, the
 * done is refused once per step and the model is told why, so it can do the work or say "fail".
 *
 * config.require_write: true is the strict form — any done needs a successful write TOOL, for
 * tasks run against pages known to declare their actions.
 */

const CLAIMS_A_CHANGE = /\b(book(ed|ing)?|reserv(ed|ation)|creat(ed|e)|subscrib(ed|e)|submitt?(ed)?|purchas(ed|e)|order(ed)?|sent|paid|cancell?(ed)?|added|enroll(ed)?|register(ed)?|signed up|confirm(ed|ation)|saved|updated|deleted)\b/i

const STATE_CHANGING_UI = new Set(['click', 'type', 'form_input', 'press'])

/**
 * Record one step. `tools` is the list offered that step (for the read-only flag).
 * @returns {boolean} whether this step changed something
 */
function changedState (action, result, tools = []) {
  if (!result || result.ok !== true) return false
  const type = String(action?.type || '').toLowerCase()
  if (STATE_CHANGING_UI.has(type)) return true
  if (type === 'tool') {
    const name = String(action.name || '').replace(/^page\./, '')
    const tool = tools.find((t) => t.name === name)
    return !(tool && tool.annotations && tool.annotations.readOnly)
  }
  return false
}

function wroteWithTool (action, result, tools = []) {
  return String(action?.type || '').toLowerCase() === 'tool' && changedState(action, result, tools)
}

/**
 * May this done stand?
 * @param {object} action  the done action
 * @param {{ changed: boolean, wroteWithTool: boolean }} evidence  accumulated over the run
 * @param {object} config  task.config
 */
function doneVerdict (action, evidence, config = {}) {
  const claim = String(action?.result || '')
  if (config.require_write && !evidence.wroteWithTool) {
    return { ok: false, reason: 'This task requires a page tool that changes something to succeed before it is done, and none has. Call the tool, or use "fail" and say why.' }
  }
  if (CLAIMS_A_CHANGE.test(claim) && !evidence.changed) {
    return { ok: false, reason: `"done" refused: it says something was ${claim.match(CLAIMS_A_CHANGE)[0].toLowerCase()}, but nothing in this run changed anything — no write tool succeeded and nothing was clicked or typed. Do the action, or use "fail".` }
  }
  return { ok: true }
}

module.exports = { doneVerdict, changedState, wroteWithTool, CLAIMS_A_CHANGE }
