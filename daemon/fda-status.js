'use strict'

/**
 * Full Disk Access, reported so a person can fix it in one step.
 *
 * Two questions, because they have different answers right after someone grants access:
 *
 *   process — can THIS running daemon read protected files? macOS settles that when the process
 *             starts, so a grant made afterwards does not show up here until a restart.
 *   fresh   — can a NEW process of the same binary read them? We spawn one from the daemon, so it
 *             is judged as the same app the grant was given to. This shows a just-made grant
 *             without restarting anything, which lets `iris-daemon grant-access` watch for the
 *             switch and restart exactly once.
 *
 * Both reuse probeFullDiskAccess, which reads chat.db's header rather than checking a path
 * exists. An existence check reports "granted" on a Mac where every read is refused.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')
const { probeFullDiskAccess } = require('./permission-probe')

const SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
const FIX_COMMAND = 'iris-daemon grant-access'

/** The file ~/.iris/daemon-node pins the daemon to, or null. Never throws. */
function readPinned (home = os.homedir()) {
  try {
    const v = fs.readFileSync(path.join(home, '.iris', 'daemon-node'), 'utf8').split('\n')[0].trim()
    return v || null
  } catch { return null }
}

/**
 * Run the same probe in a child of the same binary. Anything that is not a clean answer is
 * UNKNOWN, never false: "the child could not run" is not "access is denied".
 */
function freshFullDiskAccess ({ execPath = process.execPath, timeoutMs = 5000, run = execFile } = {}) {
  const probePath = path.join(__dirname, 'permission-probe.js')
  const script = `process.stdout.write(JSON.stringify(require(${JSON.stringify(probePath)}).probeFullDiskAccess()))`
  return new Promise((resolve) => {
    run(execPath, ['-e', script], { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout) => {
      if (err) return resolve({ available: null, reason: `fresh check could not run: ${err.code || err.message}` })
      try {
        const r = JSON.parse(String(stdout).trim())
        resolve({ available: r.available === true ? true : r.available === false ? false : null, reason: r.reason || null })
      } catch {
        resolve({ available: null, reason: 'fresh check returned no result' })
      }
    })
  })
}

/**
 * The report `GET /daemon/permissions` returns. Callers decide from `restart_needed` and the two
 * tristates; the text fields exist so a CLI can say what to do without knowing any of this.
 */
async function permissionsReport ({
  platform = process.platform,
  execPath = process.execPath,
  ppid = process.ppid,
  home = os.homedir(),
  probeProcess = () => probeFullDiskAccess(),
  probeFresh = () => freshFullDiskAccess({ execPath }),
} = {}) {
  const base = {
    platform,
    binary: execPath,
    pinned: readPinned(home),
    launchd: ppid === 1,
    // A daemon started from a terminal inherits the TERMINAL's access, so its answer says
    // nothing about the launchd daemon people actually run. Say whose access this measured.
    measured_as: ppid === 1 ? 'daemon' : 'terminal-started process (inherits the terminal\'s access, not the daemon\'s)',
    fix: { command: FIX_COMMAND, settings_url: SETTINGS_URL },
  }
  if (platform !== 'darwin') {
    const na = { available: null, reason: 'Full Disk Access is a macOS setting' }
    return { ...base, process: na, fresh: na, restart_needed: false }
  }
  const proc = probeProcess()
  const fresh = await probeFresh()
  return {
    ...base,
    process: { available: proc.available, reason: proc.reason || null },
    fresh,
    restart_needed: fresh.available === true && proc.available !== true,
  }
}

module.exports = { permissionsReport, freshFullDiskAccess, readPinned, SETTINGS_URL, FIX_COMMAND }
