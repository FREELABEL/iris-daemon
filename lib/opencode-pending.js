'use strict'

/**
 * What an IRIS Desktop / opencode session is waiting on a PERSON for, and answering it (#190649).
 *
 * `iris hive answer` worked only for Claude Code: an opencode session paused on a permission prompt
 * ("allow bash: rm -rf dist?") or on a question could be answered only by someone sitting at that
 * Desktop. The engine already exposes both, per directory instance:
 *
 *   GET  /permission?directory=D            -> [{ id, sessionID, permission, patterns, ... }]
 *   POST /permission/<id>/reply?directory=D { reply: "once" | "always" | "reject" }
 *   GET  /question?directory=D              -> [{ id, sessionID, questions: [{question, header, options:[{label}], multiple}] }]
 *   POST /question/<id>/reply?directory=D   { answers: [[label, ...], ...] }
 *
 * Both are reported in the same `waiting` shape Claude Code sessions use (kind 'question', options
 * with labels), so the fleet view, needs_you and `iris hive answer` need nothing new. A permission
 * becomes one question with three options. `held: true` — the engine is holding it live.
 *
 * NEVER AUTO-APPROVES. Nothing here answers on its own; resolveAnswer only translates a choice a
 * person made. An unrecognised choice for a permission is refused, never guessed as "allow".
 *
 * Network calls are injected (`fetchJson(url, ms)`, `postJson(url, body, ms)`) and never throw out.
 */

const CALL_TIMEOUT_MS = 1500
const MAX_DIRECTORIES = 6
const PERMISSION_OPTIONS = [
  { label: 'Allow once', reply: 'once' },
  { label: 'Always allow', reply: 'always' },
  { label: 'Reject', reply: 'reject' }
]

const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '')

function waitingFromPermission (req) {
  const patterns = Array.isArray(req.patterns) ? req.patterns.filter((p) => typeof p === 'string' && p) : []
  const what = clip(String(req.permission || 'a tool'), 80)
  return {
    kind: 'question',
    held: true,
    asked_at: null,
    opencode: { type: 'permission', id: String(req.id) },
    questions: [{
      header: 'Permission',
      question: clip(`Allow ${what}${patterns.length ? ` on ${patterns.slice(0, 3).join(', ')}${patterns.length > 3 ? ' …' : ''}` : ''}?`, 300),
      options: PERMISSION_OPTIONS.map((o) => ({ label: o.label, description: null }))
    }]
  }
}

function waitingFromQuestion (req) {
  const questions = (Array.isArray(req.questions) ? req.questions : []).slice(0, 4).map((q) => ({
    header: clip(q && q.header, 30) || null,
    question: clip(q && q.question, 300),
    multiple: !!(q && q.multiple),
    custom: !(q && q.custom === false),
    options: (Array.isArray(q && q.options) ? q.options : []).slice(0, 8).map((o) => ({
      label: clip(o && o.label, 80),
      description: o && typeof o.description === 'string' ? clip(o.description, 160) : null
    }))
  }))
  return { kind: 'question', held: true, asked_at: null, opencode: { type: 'question', id: String(req.id) }, questions }
}

/**
 * Pending prompts per session id, asked of each server for each directory. Questions win over
 * permissions for the same session (a question is what the agent is literally waiting on).
 */
async function pendingBySession ({ servers, directories, fetchJson }) {
  const out = new Map()
  const dirs = [...new Set((directories || []).filter((d) => typeof d === 'string' && d))].slice(0, MAX_DIRECTORIES)
  const calls = []
  for (const base of servers || []) {
    for (const dir of dirs) {
      const q = `directory=${encodeURIComponent(dir)}`
      for (const [path, make, rank] of [['permission', waitingFromPermission, 1], ['question', waitingFromQuestion, 2]]) {
        calls.push(
          Promise.resolve()
            .then(() => fetchJson(`${String(base).replace(/\/+$/, '')}/${path}?${q}`, CALL_TIMEOUT_MS))
            .then((list) => {
              for (const req of Array.isArray(list) ? list : []) {
                if (!req || !req.id || !req.sessionID) continue
                const prev = out.get(req.sessionID)
                if (prev && prev.rank >= rank) continue
                out.set(req.sessionID, { rank, base, directory: dir, waiting: make(req) })
              }
            })
            .catch(() => {})
        )
      }
    }
  }
  await Promise.all(calls)
  return out
}

/** A permission choice — by number, label or plain word — to the engine's reply, or null. */
function permissionReply (choice) {
  const c = String(choice || '').trim().toLowerCase()
  if (!c) return null
  if (/^\d+$/.test(c)) return PERMISSION_OPTIONS[Number(c) - 1] ? PERMISSION_OPTIONS[Number(c) - 1].reply : null
  const byLabel = PERMISSION_OPTIONS.find((o) => o.label.toLowerCase() === c)
  if (byLabel) return byLabel.reply
  if (['once', 'allow', 'yes', 'y', 'approve', 'ok'].includes(c)) return 'once'
  if (['always', 'always allow'].includes(c)) return 'always'
  if (['reject', 'deny', 'no', 'n', 'decline'].includes(c)) return 'reject'
  return null
}

/** One choice for one question → the labels the engine expects. Number, label, or free text. */
function questionAnswer (q, choice) {
  const raw = String(choice || '').trim()
  if (!raw) return { error: `no answer for "${q.question}"` }
  const parts = q.multiple ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [raw]
  const labels = []
  for (const p of parts) {
    if (/^\d+$/.test(p) && q.options[Number(p) - 1]) { labels.push(q.options[Number(p) - 1].label); continue }
    const hit = q.options.find((o) => o.label.toLowerCase() === p.toLowerCase())
    if (hit) { labels.push(hit.label); continue }
    if (q.custom) { labels.push(p); continue }
    return { error: `"${p}" is not one of: ${q.options.map((o, i) => `${i + 1}. ${o.label}`).join(', ')}` }
  }
  return { labels }
}

/**
 * Translate the person's choices (array, one per question; or {question: label}) for a pending
 * prompt into the engine request. Returns { path, body } or { error }.
 */
function resolveAnswer (waiting, choices) {
  const list = Array.isArray(choices)
    ? choices
    : (choices && typeof choices === 'object' ? waiting.questions.map((q) => choices[q.question]) : [])
  const o = waiting.opencode || {}
  if (o.type === 'permission') {
    const reply = permissionReply(list[0])
    if (!reply) return { error: `answer the permission with 1 (Allow once), 2 (Always allow) or 3 (Reject) — got "${list[0] ?? ''}"` }
    return { path: `permission/${encodeURIComponent(o.id)}/reply`, body: { reply } }
  }
  if (o.type === 'question') {
    const answers = []
    for (let i = 0; i < waiting.questions.length; i++) {
      const r = questionAnswer(waiting.questions[i], list[i])
      if (r.error) return { error: r.error }
      answers.push(r.labels)
    }
    return { path: `question/${encodeURIComponent(o.id)}/reply`, body: { answers } }
  }
  return { error: 'nothing to answer' }
}

module.exports = {
  pendingBySession, resolveAnswer, waitingFromPermission, waitingFromQuestion, permissionReply,
  PERMISSION_OPTIONS, MAX_DIRECTORIES, CALL_TIMEOUT_MS
}
