'use strict'

/**
 * Which opencode sessions are WORKING right now — asked of the servers running them, not inferred
 * from when a file last changed (epic #185632, step 4b).
 *
 * The fleet view derived every session's state from `updated_at`, so "live" meant "touched in the
 * last 30 minutes" and 70 of a real reader's 100 sessions read stale. opencode already knows:
 * GET /session/status. Measured 2026-09-17 on a throwaway `iris serve`:
 *
 *   - The map holds ONLY non-idle sessions — {type:"busy"} or {type:"retry", ...}. A finished turn
 *     disappears from it.
 *   - Only the server RUNNING a session reports it. Every server lists the same sessions (they share
 *     disk storage), but a busy session on :4199 read {} on :4096. So a session missing from every
 *     map is UNMEASURED, not idle — this returns `working` / `retrying` and nothing else.
 *   - The instance is per directory: a busy session in directory B was invisible on the same server
 *     without ?directory=B. So each server is asked once per directory.
 *
 * ASKING LOADS AN INSTANCE on that server for that directory, so only directories with a recently
 * active session are asked, and at most MAX_DIRECTORIES of them. A session cannot be busy without
 * writing to its transcript, so a directory idle for longer than the window has nothing to find —
 * the window is generous (six hours) to cover a single long tool call.
 *
 * Runs on every heartbeat: each call carries a timeout, calls run in parallel, and nothing throws.
 * `fetchJson(url, timeoutMs)` is injected — it resolves the parsed body or null.
 */

const ACTIVITY_WINDOW_MS = 6 * 60 * 60 * 1000
const MAX_DIRECTORIES = 6
const CALL_TIMEOUT_MS = 1000

// An array or a string has no session-id keys, so only null needs excluding.
const isObject = (v) => typeof v === 'object' && v !== null

async function opencodeActivity ({ sessions, servers, fetchJson, now = Date.now() } = {}) {
  const list = Array.isArray(sessions) ? sessions : []
  const bases = Array.isArray(servers) ? servers : []

  // Wanted session ids, and the most recent activity per directory.
  const wanted = new Set()
  const latestByDir = new Map()
  for (const s of list) {
    if (!s || typeof s.session_id !== 'string' || s.session_id === '') continue
    wanted.add(s.session_id)
    const dir = typeof s.project_path === 'string' ? s.project_path : ''
    const t = Date.parse(s.updated_at || '')
    if (dir === '' || Number.isNaN(t) || now - t > ACTIVITY_WINDOW_MS) continue
    if (!latestByDir.has(dir) || t > latestByDir.get(dir)) latestByDir.set(dir, t)
  }

  const directories = [...latestByDir.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_DIRECTORIES)
    .map(([dir]) => dir)

  const activity = {}
  let errors = 0

  const calls = []
  for (const base of bases) {
    for (const dir of directories) {
      const url = `${String(base).replace(/\/+$/, '')}/session/status?directory=${encodeURIComponent(dir)}`
      calls.push(
        Promise.resolve()
          .then(() => fetchJson(url, CALL_TIMEOUT_MS))
          .then((body) => {
            if (!isObject(body)) return
            for (const [id, status] of Object.entries(body)) {
              if (!wanted.has(id) || !isObject(status)) continue
              if (status.type === 'busy') activity[id] = 'working'
              else if (status.type === 'retry' && activity[id] !== 'working') activity[id] = 'retrying'
            }
          })
          .catch(() => { errors++ }),
      )
    }
  }
  await Promise.all(calls)

  return { activity, servers: bases.length, directories: directories.length, errors }
}

module.exports = { opencodeActivity, ACTIVITY_WINDOW_MS, MAX_DIRECTORIES, CALL_TIMEOUT_MS }
