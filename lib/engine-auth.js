'use strict'

/**
 * Credentials for the session servers this machine runs (#190647).
 *
 * IRIS Desktop's engine listened on 127.0.0.1 with NO password: GET /session answered 200 to any
 * local process, which is also the only reason this bridge could find and drive Desktop sessions
 * (findLiveSessionServer scans loopback ports and calls them unauthenticated). Desktop is moving
 * to a per-launch password, published for local clients in ~/.iris/desktop-engine.json (0600):
 *
 *   { "version": 1, "port": 49244, "username": "opencode", "password": "…", "pid": 123, "data_home": "…" }
 *
 * This reads that file so delivery, listing and history keep working once the password is on.
 * No file — today's Desktop — means no header and exactly the old behaviour. A file another user
 * owns, or one others can read, is ignored: it would hand this machine's agent to whoever wrote it.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const FILE = 'desktop-engine.json'

/** The engines Desktop published, as { base, authorization }. Never throws. */
function publishedEngines (home = os.homedir(), uid = typeof process.getuid === 'function' ? process.getuid() : undefined) {
  const file = path.join(home, '.iris', FILE)
  let st
  try { st = fs.statSync(file) } catch { return [] }
  // Owned by us, readable by nobody else. A world- or group-readable password is not ours to use,
  // and one planted by another user would point us at their server.
  if (uid !== undefined && st.uid !== uid) return []
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) return []
  let data
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return [] }
  const list = Array.isArray(data) ? data : [data]
  const out = []
  for (const e of list) {
    const port = Number(e && e.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof e.password !== 'string' || !e.password) continue
    const user = typeof e.username === 'string' && e.username ? e.username : 'opencode'
    out.push({
      base: `http://127.0.0.1:${port}`,
      authorization: 'Basic ' + Buffer.from(`${user}:${e.password}`).toString('base64')
    })
  }
  return out
}

/** Headers for a request to `url`: Authorization when it is a published engine, else none. */
function engineHeaders (url, engines = publishedEngines()) {
  const u = String(url)
  for (const e of engines) {
    // localhost and 127.0.0.1 are the same server; compare on the port.
    const port = e.base.split(':').pop()
    if (new RegExp(`^http://(127\\.0\\.0\\.1|localhost):${port}(/|$)`).test(u)) return { Authorization: e.authorization }
  }
  return {}
}

module.exports = { publishedEngines, engineHeaders, FILE }
