'use strict'

/**
 * ACP sessions kept open on this machine by `iris acp run --keep` (#191170).
 *
 * Each one is an agent (Claude Code, Codex, Gemini, opencode, IRIS) driven over the Agent Client
 * Protocol by an `iris` process that stays up, serves the session on 127.0.0.1 with a token made
 * for that launch, and writes where to find it to ~/.iris/acp/<session>.json (0600). That file is
 * already in the fleet's session shape; this module lists the live ones and forwards a message or
 * an answer to the process holding the session.
 *
 * The token and port never leave this machine: they are stripped before anything is reported.
 * A record whose process is gone is skipped — the CLI prunes it the next time it lists.
 */

const path = require('path')

const registryDir = (home) => path.join(home, '.iris', 'acp')

function pidAlive (pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}

/** Every live holder record, newest activity first. Unreadable or dead records are skipped. */
function readHolders (fs, home, alive = pidAlive) {
  let names = []
  try { names = fs.readdirSync(registryDir(home)).filter((n) => n.endsWith('.json')) } catch { return [] }
  const out = []
  for (const n of names) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(registryDir(home), n), 'utf8'))
      if (!rec || typeof rec.session_id !== 'string' || !alive(rec.pid)) continue
      if (!Number.isInteger(rec.port) || typeof rec.token !== 'string') continue
      out.push(rec)
    } catch {}
  }
  const t = (r) => { const v = Date.parse(r.updated_at || r.created_at || ''); return Number.isNaN(v) ? -Infinity : v }
  return out.sort((a, b) => t(b) - t(a))
}

/** The fleet's view of a holder: no token, no port. */
function sessionOf (rec) {
  return {
    session_id: rec.session_id,
    name: rec.name || null,
    project_path: rec.project_path || null,
    git_branch: null,
    model: rec.agent_name || rec.agent || null,
    agent: rec.agent || null,
    created_at: rec.created_at || null,
    updated_at: rec.updated_at || null,
    message_count: Number.isInteger(rec.message_count) ? rec.message_count : null,
    status: rec.status || null,
    waiting: rec.waiting || null,
    provider: 'acp'
  }
}

function listAcpSessions (fs, home, limit = 20, alive = pidAlive) {
  return readHolders(fs, home, alive).slice(0, limit).map(sessionOf)
}

function findHolder (fs, home, sessionId, alive = pidAlive) {
  return readHolders(fs, home, alive).find((r) => r.session_id === sessionId) || null
}

/**
 * Call the holder. Returns {status, body} and never throws: a holder that went away between the
 * listing and the call is a 404 with the reason, not an exception.
 */
async function callHolder (fetchFn, rec, method, route, body, timeoutMs = 8000) {
  try {
    const r = await fetchFn(`http://127.0.0.1:${rec.port}${route}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-acp-token': rec.token },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    })
    const out = await r.json().catch(() => ({ error: `holder answered HTTP ${r.status} with no JSON` }))
    return { status: r.status, body: out }
  } catch (err) {
    return { status: 502, body: { error: `the iris process holding this session did not answer: ${err.message}`, session_id: rec.session_id } }
  }
}

module.exports = { registryDir, readHolders, listAcpSessions, findHolder, callHolder, sessionOf, pidAlive }
