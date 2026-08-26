'use strict'

/**
 * Keep the daemon's IPC socket bindable (#182371).
 *
 * daemon.js had this, and it never worked:
 *
 *     function cleanupSocket () {
 *       try { fs.unlinkSync(SOCKET_PATH) } catch {}
 *     }
 *
 * SOCKET_PATH is not defined anywhere in that file — it defines SOCK_FILE. Every call threw
 * a ReferenceError straight into a bare `catch {}`, so the socket was NEVER removed, and the
 * next start failed to bind:
 *
 *     [ipc] Server error: listen EADDRINUSE ... ~/.iris/daemon.sock
 *
 * The node stayed "online" in the fleet view the whole time, because each restart heartbeats
 * once before wedging. Measured: one process alive eight hours with no heartbeat.
 *
 * The swallowing catch is the real lesson. A cleanup that silently does nothing is
 * indistinguishable from one that works, so both functions here RETURN what happened.
 */

const fs = require('fs')
const net = require('net')

/**
 * Remove a socket file ONLY if nothing is listening on it.
 *
 * The distinction matters in both directions. Unlinking a live socket would cut a running
 * daemon off from its CLI; refusing to unlink a dead one is the bug above. So the file's
 * existence is not the question — whether anything answers on it is.
 *
 * @returns {Promise<{freed:boolean, inUse:boolean, error:string|null}>}
 */
async function ensureSocketFree (sockPath) {
  if (typeof sockPath !== 'string' || sockPath === '') {
    return { freed: false, inUse: false, error: 'no socket path given' }
  }
  if (!fs.existsSync(sockPath)) {
    return { freed: false, inUse: false, error: null }
  }

  // Is anything LISTENING? A unix socket with no listener refuses immediately with
  // ECONNREFUSED; a live one connects. This has to be awaited — an earlier version used
  // net.createServer().listen() and read a synchronous throw that never comes, so it
  // concluded "dead" for a live socket and would have unlinked a running daemon out from
  // under its own CLI. Its test caught that, which is the only reason this is async.
  const inUse = await new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    const probe = net.connect({ path: sockPath })
    const timer = setTimeout(() => { probe.destroy(); done(false) }, 1000)
    probe.on('connect', () => { clearTimeout(timer); probe.destroy(); done(true) })
    probe.on('error', () => { clearTimeout(timer); probe.destroy(); done(false) })
  })

  if (inUse) {
    // Someone owns it. Leaving it is correct — the caller should report a duplicate
    // daemon rather than fight over the socket.
    return { freed: false, inUse: true, error: null }
  }

  try {
    fs.unlinkSync(sockPath)
  } catch (err) {
    return { freed: false, inUse: false, error: err && err.message ? err.message : String(err) }
  }

  return { freed: !fs.existsSync(sockPath), inUse: false, error: null }
}

/**
 * Delete the socket file and SAY whether it deleted anything.
 *
 * @returns {boolean} true if a file was removed
 */
function cleanupSocket (sockPath) {
  if (typeof sockPath !== 'string' || sockPath === '') return false
  if (process.platform === 'win32') return false // named pipes are not files
  try {
    if (!fs.existsSync(sockPath)) return false
    fs.unlinkSync(sockPath)
    return !fs.existsSync(sockPath)
  } catch {
    return false
  }
}

module.exports = { ensureSocketFree, cleanupSocket }
