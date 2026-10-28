'use strict'

/**
 * Is this Linux node SUPERVISED — will anything restart the daemon if it crashes? (#191615)
 *
 * On iris-hive-001, the always-on node every business calls into, the answer was no: daemonctl
 * fell back to nohup, and a crash meant an outage until a person noticed. Both doctors
 * (`iris-daemon doctor` → lib/daemon-doctor.js, and doctor.js) ask this module, so the two can
 * never disagree about it.
 *
 * Split like lib/daemon-doctor.js: collect() touches systemctl/loginctl; verdict() is pure, so
 * the broken machines it exists for are testable on a healthy one.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const UNIT = 'iris-daemon.service'
const FIX = 'iris-daemon supervise'

// `systemctl --user` needs XDG_RUNTIME_DIR to find the user bus; cron and bare ssh sessions
// do not set it, and every --user call then fails as if systemd were absent.
function childEnv () {
  const env = { ...process.env }
  const uid = process.getuid ? process.getuid() : null
  if (!env.XDG_RUNTIME_DIR && uid != null && fs.existsSync(`/run/user/${uid}`)) env.XDG_RUNTIME_DIR = `/run/user/${uid}`
  return env
}

function sh (cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'], env: childEnv() }).trim()
  } catch {
    return null
  }
}

function pid (v) {
  const n = parseInt(v, 10)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Facts about every supervisor that could own the daemon here. Linux only. */
function collect ({ run = sh, home = os.homedir(), user = os.userInfo().username, env = process.env } = {}) {
  const userRun = (args) => run('systemctl', ['--user', ...args])
  const systemdAvailable = userRun(['show-environment']) != null
  const unitFile = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', UNIT)
  const userUnitInstalled = fs.existsSync(unitFile)
  let userActive = false
  let userPid = null
  if (systemdAvailable && userUnitInstalled) {
    userActive = userRun(['is-active', UNIT]) === 'active'
    userPid = userActive ? pid(userRun(['show', '-p', 'MainPID', '--value', UNIT])) : null
  }
  const systemUnitLoaded = run('systemctl', ['show', '-p', 'LoadState', '--value', UNIT]) === 'loaded'
  const systemActive = systemUnitLoaded && run('systemctl', ['is-active', UNIT]) === 'active'
  const systemPid = systemActive ? pid(run('systemctl', ['show', '-p', 'MainPID', '--value', UNIT])) : null
  const l = run('loginctl', ['show-user', user, '-p', 'Linger', '--value'])
  return {
    systemdAvailable,
    userUnitInstalled,
    userActive,
    userPid,
    systemUnitLoaded,
    systemActive,
    systemPid,
    linger: l === 'yes' ? true : l === 'no' ? false : null,
    user
  }
}

/**
 * Pure. `s` from collect(), `portHolderPid` = who listens on :3200.
 * Returns { status: pass|fail|unknown, detail }. Every failure names the command that fixes it.
 */
function verdict (s, portHolderPid) {
  if (!s) return { status: 'unknown', detail: 'supervision was not measured' }
  if (s.userActive && s.systemActive) {
    return {
      status: 'fail',
      detail: `TWO SUPERVISORS: the system unit (pid ${s.systemPid}) and the user unit (pid ${s.userPid}) both start ` +
        `the daemon, and each takes the socket from the other. Fix: ${FIX}`
    }
  }
  const kind = s.userActive ? 'systemd user unit' : s.systemActive ? 'systemd SYSTEM unit' : null
  const supPid = s.userActive ? s.userPid : s.systemActive ? s.systemPid : null

  if (portHolderPid == null) {
    return {
      status: 'unknown',
      detail: kind
        ? `the ${kind} is active but nothing listens on :3200 — it may be starting or crash-looping (journalctl --user -u ${UNIT})`
        : 'nothing listens on :3200 — the daemon is down. Start it: iris-daemon start'
    }
  }
  if (!kind) {
    return {
      status: 'fail',
      detail: s.systemdAvailable
        ? `UNSUPERVISED: pid ${portHolderPid} holds :3200 and nothing restarts it if it crashes. Fix: ${FIX}`
        : `UNSUPERVISED: pid ${portHolderPid} holds :3200 and systemd --user is not available here (a container or ` +
          'non-systemd init), so nothing restarts it if it crashes. Run it under this host\'s supervisor.'
    }
  }
  if (supPid !== portHolderPid) {
    return {
      status: 'fail',
      detail: `SPLIT BRAIN: the ${kind}'s child is pid ${supPid ?? 'none'} but pid ${portHolderPid} holds :3200 — ` +
        'the listener is not supervised, and a restart replaces the process that is not serving. Fix: iris-daemon restart'
    }
  }
  if (s.userActive && s.linger === false) {
    return {
      status: 'fail',
      detail: `linger is OFF for ${s.user}: systemd stops the daemon when ${s.user}'s last session logs out, and does not ` +
        `start it at boot. Fix: sudo loginctl enable-linger ${s.user}`
    }
  }
  return {
    status: 'pass',
    detail: `pid ${supPid} is the ${kind}'s child and the :3200 listener` +
      (s.systemActive ? ` (legacy system unit; move it to the user unit with: ${FIX})` : '')
  }
}

module.exports = { collect, verdict, UNIT, FIX }
