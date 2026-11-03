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
 *
 * #192113 gives every other local server the same treatment: a token per start, published in
 * ~/.iris/servers/<port>.json (0600 in 0700). Same rules, plus a live pid, and only ever sent to a
 * loopback URL. No record means no header, which an older server never notices.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { pidAlive } = require('./acp-sessions')

const FILE = 'desktop-engine.json'
const SERVERS_DIR = 'servers'

const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : undefined)

/**
 * The parsed file if it may be used as a credential, else null. Never throws.
 *
 * Owned by us, readable by nobody else, and a real file. A world- or group-readable password is
 * not ours to use, and one planted by another user would point us at their server.
 *
 * WINDOWS: no POSIX mode and no uid (process.getuid is undefined, st.uid is 0), so those two checks
 * cannot run. The same as the CLI readers: the file is guarded by the ACL on the user's profile.
 */
function readOwnerOnly (file, uid) {
  let st
  try { st = fs.lstatSync(file) } catch { return null }
  if (!st.isFile()) return null
  if (uid !== undefined && st.uid !== uid) return null
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) return null
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function engine (port, username, password) {
  const user = typeof username === 'string' && username ? username : 'opencode'
  return {
    base: `http://127.0.0.1:${port}`,
    authorization: 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64')
  }
}

const validPort = (port) => Number.isInteger(port) && port >= 1 && port <= 65535

function desktopEngines (home, uid) {
  const data = readOwnerOnly(path.join(home, '.iris', FILE), uid)
  if (!data) return []
  const out = []
  for (const e of Array.isArray(data) ? data : [data]) {
    const port = Number(e && e.port)
    if (!validPort(port) || typeof e.password !== 'string' || !e.password) continue
    // A Desktop that has gone leaves its password behind; whoever holds the port now must not get it.
    if (e.pid !== undefined && !pidAlive(e.pid)) continue
    out.push(engine(port, e.username, e.password))
  }
  return out
}

/**
 * ~/.iris/servers/<port>.json, written by `iris serve` and friends (#192113). A record must name
 * its own port and a process that is alive: a server that died without tidying up leaves one, and
 * the next thing listening on that port is somebody else.
 */
function serverRecord (home, port, uid) {
  const r = readOwnerOnly(path.join(home, '.iris', SERVERS_DIR, `${port}.json`), uid)
  if (!r || Number(r.port) !== port || typeof r.password !== 'string' || !r.password) return null
  if (!pidAlive(r.pid)) return null
  return engine(port, r.username, r.password)
}

/**
 * Every engine and server this machine published, as { base, authorization }. Never throws.
 * Desktop stays first (it holds Desktop's sessions); a port's own record wins on credentials
 * because the server holding that port writes it, the order the CLI reads them in.
 */
function publishedEngines (home = os.homedir(), uid = currentUid()) {
  const byPort = new Map()
  const portOf = (e) => Number(e.base.split(':').pop())
  for (const e of desktopEngines(home, uid)) byPort.set(portOf(e), e)
  let names = []
  try { names = fs.readdirSync(path.join(home, '.iris', SERVERS_DIR)) } catch { /* none published */ }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue
    const port = Number(name.slice(0, -5))
    const e = validPort(port) ? serverRecord(home, port, uid) : null
    if (e) byPort.set(port, e)
  }
  return [...byPort.values()]
}

/** The port of a plain-http URL on this machine; null for anything else. Local secrets stop here. */
function loopbackPort (url) {
  let u
  try { u = new URL(String(url)) } catch { return null }
  if (u.protocol !== 'http:' || u.username || u.password) return null
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host !== 'localhost' && host !== '::1' && !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return null
  return Number(u.port || 80)
}

/**
 * Headers for a request to `url`: Authorization when it is on this machine and published, else
 * none. Read on every call so a restarted server's new token is picked up, and only this port's
 * record is opened: the fleet refresh makes dozens of these on the event loop the watchdog measures.
 */
function engineHeaders (url, engines) {
  const port = loopbackPort(url)
  if (port === null) return {}
  let list = engines
  if (!list) {
    const home = os.homedir()
    const uid = currentUid()
    list = [serverRecord(home, port, uid), ...desktopEngines(home, uid)].filter(Boolean)
  }
  const hit = list.find((e) => Number(e.base.split(':').pop()) === port)
  return hit ? { Authorization: hit.authorization } : {}
}

/**
 * Why a server turned this daemon away, in a sentence a person can act on, or null when `status`
 * is not a refusal. Decides nothing and retries nothing. Holds no secret: only the origin and port.
 */
function refusalReason (url, status) {
  if (status !== 401 && status !== 403) return null
  let origin = String(url)
  try { origin = new URL(origin).origin } catch { /* keep what we were given */ }
  if (status === 403) {
    return `${origin} refused this request (HTTP 403). A server reached by a name other than loopback must list it in OPENCODE_SERVER_ALLOWED_HOSTS.`
  }
  const port = loopbackPort(url)
  if (port === null) {
    return `${origin} requires a token (HTTP 401). This daemon only sends local credentials to servers on this machine.`
  }
  if (engineHeaders(url).Authorization) {
    return `${origin} refused the credentials published for it (HTTP 401). A record that outlived its server gets replaced when the server restarts; the next attempt reads it again.`
  }
  return `${origin} requires a token (HTTP 401) and this daemon found none it may use: ~/.iris/servers/${port}.json is missing, readable by others, or names a dead process.`
}

const LOG_EVERY_MS = 10 * 60 * 1000
const logged = new Map()

/** One log line per server per 10 minutes: refusals recur on every fleet refresh. */
function logRefusal (server, reason, log = console.warn, now = Date.now()) {
  if (now - (logged.get(server) || -Infinity) < LOG_EVERY_MS) return
  logged.set(server, now)
  log(`[opencode] ${reason}`)
}

module.exports = { publishedEngines, engineHeaders, loopbackPort, refusalReason, logRefusal, FILE, SERVERS_DIR }
