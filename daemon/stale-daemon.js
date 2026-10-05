'use strict'

/**
 * Stop a daemon that should no longer be running (#188006).
 *
 * The socket lock is how one daemon finds another — but a daemon that has lost its
 * socket is invisible to it. Two ways that happened, both measured on a Mac on
 * 2026-10-04 with THREE daemons heartbeating as one node:
 *
 *   - a daemon still retrying cloud auth took a 'replace', removed its socket, and
 *     returned from shutdown() without exiting (it was not `running` yet), then its
 *     retry loop succeeded;
 *   - a newcomer whose handoff overran its deadline force-cleaned the socket and
 *     started anyway, leaving the holder alive.
 *
 * Each survivor kept heartbeating, launchd's own job kept failing to replace them,
 * and the hub reported "20 restarts in 15m — crash-looping" beside "up 3h 46m".
 *
 * So the newcomer kills the stale process by PID. A PID can be reused, so it only
 * ever signals a process whose command line is an IRIS daemon.
 */

const { execFileSync } = require('child_process')

/** The process's command line, or null if it is gone / unreadable. */
function commandOf (pid) {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf-8', timeout: 3000 }).trim() || null
  } catch {
    return null
  }
}

/** True only for a live process running the IRIS daemon entry point. */
function isDaemonCommand (cmd) {
  return !!cmd && /(^|[\s/])daemon\.js(\s|$)/.test(cmd)
}

function alive (pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * SIGTERM, wait up to graceMs, then SIGKILL.
 *
 * @returns {Promise<'not-running'|'not-a-daemon'|'self'|'terminated'|'killed'|'survived'>}
 */
async function stopStaleDaemon (pid, { graceMs = 5000, self = process.pid, commandOfFn = commandOf } = {}) {
  pid = Number(pid)
  if (!Number.isInteger(pid) || pid <= 1) return 'not-running'
  if (pid === self) return 'self'
  if (!alive(pid)) return 'not-running'
  if (!isDaemonCommand(commandOfFn(pid))) return 'not-a-daemon'

  try { process.kill(pid, 'SIGTERM') } catch { return 'not-running' }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    await sleep(100)
    if (!alive(pid)) return 'terminated'
  }
  try { process.kill(pid, 'SIGKILL') } catch { return 'terminated' }
  await sleep(200)
  return alive(pid) ? 'survived' : 'killed'
}

module.exports = { stopStaleDaemon, isDaemonCommand, commandOf }
