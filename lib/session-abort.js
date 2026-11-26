'use strict'

/**
 * Stop a running session on THIS machine, the way its own harness stops (#194307 — a shared
 * room's Stop button). Never a process kill: killing loses the session's in-flight state and,
 * for Claude Code, the transcript tail. Each harness already has an interrupt a person uses:
 *
 *   claude-code  Esc, typed into the tmux pane the session runs in
 *   opencode     the engine's POST /session/:id/abort (what the Desktop stop button calls)
 *   acp          the `iris acp run --keep` holder's POST /cancel → ACP `session/cancel`
 *                (Codex, Gemini CLI and any other ACP agent, kept by IRIS)
 *
 * Returns { status, body } and never throws. 404 = not running here; 409 = running but there is
 * no way to reach its interrupt (Claude Code outside tmux); 502 = the harness refused.
 *
 * deps: { fs, home, kill, ps, tmux }                     for claude-code (as lib/session-message)
 *       { findServer(sid), engineHeaders(url), fetch }   for opencode
 *       { findHolder(sid), callHolder(fetch, rec, method, route, body), fetch } for acp
 */

const { liveSession, paneFor } = require('./session-message')

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
const PROVIDERS = ['claude-code', 'opencode', 'acp']

function slug (provider) {
  const p = String(provider || '').trim().toLowerCase()
  return p === 'claude_code' ? 'claude-code' : p
}

async function abortClaudeCode (deps, sessionId) {
  const live = liveSession(deps, sessionId)
  if (!live) {
    return { status: 404, body: { stopped: false, error: `session ${sessionId} is not running on this machine — there is nothing to stop.`, session_id: sessionId } }
  }
  const where = paneFor(deps, live.pid)
  if (!where) {
    return {
      status: 409,
      body: {
        stopped: false,
        error: `session ${sessionId} is running here (pid ${live.pid}) but not inside tmux, so there is no screen to press Esc in. It was NOT killed. Stop it where it is open, or run it inside tmux.`,
        session_id: sessionId
      }
    }
  }
  const sock = where.socket ? ['-S', where.socket] : []
  try {
    deps.tmux([...sock, 'send-keys', '-t', where.pane, 'Escape'])
  } catch (e) {
    return { status: 409, body: { stopped: false, error: `tmux pane ${where.pane} is gone (${e.message})`, session_id: sessionId } }
  }
  return { status: 200, body: { stopped: 'pane', session_id: sessionId, pane: where.pane, pid: live.pid } }
}

async function abortOpencode (deps, sessionId) {
  const { base } = await deps.findServer(sessionId)
  if (!base) {
    return { status: 404, body: { stopped: false, error: `No live session server on this machine is running ${sessionId} — there is nothing to stop.`, session_id: sessionId } }
  }
  const url = `${base}/session/${encodeURIComponent(sessionId)}/abort`
  let r
  try {
    r = await deps.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(deps.engineHeaders ? deps.engineHeaders(url) : {}) }, signal: AbortSignal.timeout(8000) })
  } catch (e) {
    return { status: 502, body: { stopped: false, error: `the session server at ${base} did not answer: ${e.message}`, session_id: sessionId } }
  }
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    return { status: 502, body: { stopped: false, error: `the session server refused the stop: HTTP ${r.status} ${String(t).slice(0, 200)}`, session_id: sessionId } }
  }
  return { status: 200, body: { stopped: 'engine', session_id: sessionId, server: base } }
}

async function abortAcp (deps, sessionId) {
  const rec = deps.findHolder(sessionId)
  if (!rec) {
    return { status: 404, body: { stopped: false, error: `No kept ACP session ${sessionId} on this machine (iris acp sessions lists them).`, session_id: sessionId } }
  }
  const out = await deps.callHolder(deps.fetch, rec, 'POST', '/cancel', {})
  if (out.status >= 200 && out.status < 300) return { status: 200, body: { stopped: 'acp', session_id: sessionId, ...(out.body || {}) } }
  return { status: out.status === 404 ? 502 : out.status, body: { stopped: false, session_id: sessionId, ...(out.body || {}) } }
}

async function abortSession (deps, provider, sessionId) {
  if (!SAFE_ID.test(String(sessionId || ''))) return { status: 400, body: { stopped: false, error: 'invalid session id' } }
  const p = slug(provider)
  try {
    if (p === 'claude-code') return await abortClaudeCode(deps, sessionId)
    if (p === 'opencode') return await abortOpencode(deps, sessionId)
    if (p === 'acp') return await abortAcp(deps, sessionId)
  } catch (e) {
    return { status: 500, body: { stopped: false, error: e.message, session_id: sessionId } }
  }
  return { status: 400, body: { stopped: false, error: `stopping a ${provider || 'unnamed'} session is not supported; supported: ${PROVIDERS.join(', ')}`, session_id: sessionId } }
}

module.exports = { abortSession, PROVIDERS, SAFE_ID }
