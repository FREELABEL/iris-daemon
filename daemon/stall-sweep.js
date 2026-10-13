'use strict'

/**
 * The stall sweep: which Hive sessions need a nudge or a person, decided in code (#189150, G4).
 *
 * Measured 2026-10-12: 237 sessions across the Hive, 211 of them idle or stale. Nearly all of
 * those are idle because they FINISHED. A sweep that nudges every idle session pokes about two
 * hundred finished conversations every ten minutes — noise that gets muted, which is the defect
 * the whole epic (#189146) is about. And unattended tasks that run past their timeout are already
 * failed by the server (`nodes:detect-stale`, every two minutes), so they are not this file's job.
 *
 * What is left, and what this decides:
 *   needs_you   the session is blocked on a question to a person (`waiting`)      → tell the person, once per question
 *   nudge       someone CLAIMED it (it is owned work), and it went quiet           → one nudge into the session, ever
 *   gone_cold   claimed, already nudged, and still quiet a day later               → tell the person, once
 *   ignore      everything else — unclaimed idle sessions are finished conversations
 *
 * Pure: no network, no clock of its own. scripts/stall-sweep.js reads the sessions, acts and
 * keeps the state file.
 */

const QUIET_MS = 30 * 60 * 1000          // matches session-status ACTIVE_MS: quiet = not active
const COLD_MS = 24 * 60 * 60 * 1000

const NUDGE = 'Status check from the Hive stall sweep: this session is claimed and has been quiet for a while. ' +
  'If the work is done, reply with FINAL and the PR or ticket link. If you are blocked, say exactly what you need and from whom. ' +
  'If it is no longer needed, say so and stop.'

function waitingKey (w) {
  if (!w) return null
  if (typeof w === 'string') return w.slice(0, 200)
  const q = Array.isArray(w.questions) && w.questions[0] ? (w.questions[0].question || w.questions[0].header || '') : (w.question || w.text || '')
  return String(w.id || w.tool_use_id || q || JSON.stringify(w)).slice(0, 200)
}

function assigneeOf (claim) {
  if (!claim) return null
  if (typeof claim === 'string') return claim
  return claim.assignee || null
}

/**
 * sessions: rows from `iris hive sessions --json`
 * prev: { nudged: {sid: iso}, told: {sid: key} }
 * → { actions: [{kind, session_id, node, label, detail, to?}], state }
 */
function decide (sessions, prev, { now = Date.now() } = {}) {
  const state = { nudged: { ...((prev && prev.nudged) || {}) }, told: { ...((prev && prev.told) || {}) } }
  const actions = []
  const seen = new Set()
  for (const s of sessions || []) {
    if (!s || !s.session_id) continue
    seen.add(s.session_id)
    const base = { session_id: s.session_id, node: s.node || '', label: s.label || s.name || '' }
    const updated = Date.parse(s.updated_at || '')
    const quietFor = Number.isNaN(updated) ? null : now - updated

    // 1 · blocked on a person: tell them, once per distinct question
    const wk = waitingKey(s.waiting)
    if (wk) {
      const key = `waiting:${wk}`
      if (state.told[s.session_id] !== key) {
        actions.push({ kind: 'needs_you', ...base, to: assigneeOf(s.claim), detail: 'waiting on an answer from a person' })
        state.told[s.session_id] = key
      }
      continue
    }

    const owner = assigneeOf(s.claim)
    // Unclaimed and quiet is a finished conversation. Do not touch it.
    if (!owner) continue
    if (quietFor === null || quietFor < QUIET_MS) continue

    // 2 · claimed and quiet: one nudge, ever
    if (!state.nudged[s.session_id]) {
      actions.push({ kind: 'nudge', ...base, to: owner, detail: `claimed by ${owner}, quiet ${Math.round(quietFor / 60000)} min`, message: NUDGE })
      state.nudged[s.session_id] = new Date(now).toISOString()
      continue
    }

    // 3 · nudged already, still quiet a day after the nudge: tell the owner, once
    const nudgedAt = Date.parse(state.nudged[s.session_id])
    if (!Number.isNaN(nudgedAt) && now - nudgedAt >= COLD_MS && updated <= nudgedAt && state.told[s.session_id] !== 'cold') {
      actions.push({ kind: 'gone_cold', ...base, to: owner, detail: `claimed by ${owner}; nudged ${state.nudged[s.session_id]} and nothing since` })
      state.told[s.session_id] = 'cold'
    }
  }
  // A session that has disappeared is done with; forget it so the state file cannot grow forever.
  for (const sid of Object.keys(state.nudged)) if (!seen.has(sid)) delete state.nudged[sid]
  for (const sid of Object.keys(state.told)) if (!seen.has(sid)) delete state.told[sid]
  return { actions, state }
}

module.exports = { decide, waitingKey, NUDGE, QUIET_MS, COLD_MS }
