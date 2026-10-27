'use strict'

/**
 * Send this machine's FULL session list to the server's session index (#191232).
 *
 * `iris recall` searches Desktop + CLI sessions on every machine you own (#191223). The index is
 * fed by the heartbeat, which carries only the newest 25 sessions per provider — so a session that
 * was already older than that when the index shipped could never be found. This sends everything:
 * once soon after the daemon starts, then once a day, in chunks the server accepts (it refuses
 * more than 500 per request rather than cutting them).
 *
 * Titles and ids only, the same fields the heartbeat already sends. No message text.
 *
 * Failure is a reason to try again, never a reason to stop the daemon: a chunk the server refused,
 * a bridge that did not answer, or an older server without the endpoint (404) all retry in
 * RETRY_MS (6h). Only a run that reached every provider and wrote every chunk waits a full day.
 */

const http = require('http')
const { sessionLabel } = require('./session-label')

const PROVIDERS = [
  { slug: 'claude-code', name: 'claude_code' },
  { slug: 'opencode', name: 'opencode' }, // includes IRIS Desktop's SQLite sessions
  { slug: 'codex', name: 'codex' }
]

const LIMIT = 1000
const CHUNK = 200
const EVERY_MS = 24 * 60 * 60 * 1000
// 6h, not 30 min (#191302): on the MacBook the opencode list takes 33s+ on the daemon's own main
// thread (embedded bridge, node:sqlite is synchronous), and the bridge finishes that scan even
// after this side gives up. Retrying twice an hour made a slow machine pay it 48 times a day.
const RETRY_MS = 6 * 60 * 60 * 1000
// Long enough for that list to come back, so a slow machine completes instead of retrying.
const BRIDGE_TIMEOUT_MS = 120 * 1000
const PATH = '/api/v6/node-agent/sessions/index'

/** One listed session as the fields the index stores — built field by field, like the heartbeat. */
function toRow (s, provider) {
  return {
    session_id: s.session_id,
    provider: s.provider || provider,
    name: s.name || null,
    label: sessionLabel(s),
    project_path: s.project_path || null,
    git_branch: s.git_branch || null,
    model: s.model || null,
    updated_at: s.updated_at || null
  }
}

/**
 * One full pass. `getJson(path)` asks the local bridge and returns null when it could NOT ask
 * (that is "unknown", not "none"); `post(path, body)` sends to the server and throws on non-2xx.
 */
async function backfill ({ getJson, post, limit = LIMIT, chunk = CHUNK }) {
  const report = { listed: {}, unreachable: [], sent: 0, indexed: 0, failedChunks: 0 }
  for (const { slug, name } of PROVIDERS) {
    const data = await getJson(`/api/sessions/${slug}?limit=${limit}&counts=0`)
    if (data === null) {
      report.unreachable.push(name)
      continue
    }
    const rows = (Array.isArray(data.sessions) ? data.sessions : [])
      .filter((s) => s && typeof s.session_id === 'string' && s.session_id)
      .map((s) => toRow(s, name))
    report.listed[name] = rows.length
    for (let i = 0; i < rows.length; i += chunk) {
      const part = rows.slice(i, i + chunk)
      try {
        const res = await post(PATH, { sessions: part })
        report.sent += part.length
        report.indexed += Number(res && res.indexed) || 0
      } catch (e) {
        report.failedChunks++
        report.lastError = e && e.message
      }
    }
  }
  return report
}

/** Did this pass do everything it set out to? Anything less retries in RETRY_MS. */
function complete (report) {
  return report.failedChunks === 0 && report.unreachable.length === 0
}

/** The local bridge, as the session refresh in index.js asks it — with room for a 1000-row list. */
function bridgeGetJson (path, { port = parseInt(process.env.A2A_PORT || '3200', 10), timeoutMs = BRIDGE_TIMEOUT_MS } = {}) {
  let token = null
  try { token = require('../lib/bridge-auth').getToken() } catch { token = null }
  return new Promise((resolve) => {
    const req = http.get({
      host: 'localhost',
      port,
      path,
      headers: token ? { 'X-Bridge-Key': token, Accept: 'application/json' } : { Accept: 'application/json' }
    }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null)
        try { resolve(JSON.parse(body)) } catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null) })
  })
}

/** Runs `backfill` when due; safe to call after every heartbeat. */
class SessionIndexBackfill {
  constructor ({ getJson = bridgeGetJson, post, now = Date.now, log = console, firstDelayMs = 60 * 1000 } = {}) {
    this.getJson = getJson
    this.post = post
    this.now = now
    this.log = log
    // Not on the very first heartbeat: let the bridge and the session refresh settle first.
    this.nextAt = now() + firstDelayMs
    this.running = false
  }

  async maybeRun () {
    if (this.running || this.now() < this.nextAt) return null
    this.running = true
    const started = this.now()
    try {
      const report = await backfill({ getJson: this.getJson, post: this.post })
      report.durationMs = this.now() - started
      const done = complete(report)
      this.nextAt = this.now() + (done ? EVERY_MS : RETRY_MS)
      const listed = Object.entries(report.listed).map(([p, n]) => `${p} ${n}`).join(', ') || 'none'
      this.log.log(`[session-index] sent ${report.sent} (${listed}), indexed ${report.indexed} in ${Math.round(report.durationMs / 1000)}s` +
        (report.unreachable.length ? `; could not list ${report.unreachable.join(', ')}` : '') +
        (report.failedChunks ? `; ${report.failedChunks} chunk(s) failed: ${report.lastError}` : '') +
        (done ? '' : ' — retrying in 6h'))
      return report
    } catch (e) {
      this.nextAt = this.now() + RETRY_MS
      this.log.warn(`[session-index] backfill failed, retrying in 6h: ${e && e.message}`)
      return null
    } finally {
      this.running = false
    }
  }
}

module.exports = { SessionIndexBackfill, backfill, complete, toRow, PROVIDERS, CHUNK, LIMIT, EVERY_MS, RETRY_MS, BRIDGE_TIMEOUT_MS, PATH }
