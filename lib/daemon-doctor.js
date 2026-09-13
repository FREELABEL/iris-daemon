'use strict'

/**
 * `iris-daemon doctor` — the self-check that did not exist (#185141), shared by
 * iris-daemon and iris-bridge because they are two control surfaces over ONE
 * process (#185142).
 *
 * It exists because of a specific failure on 2026-09-13: launchd's managed child
 * and the process holding :3200 were DIFFERENT processes, `launchctl kickstart -k`
 * returned 0 three times without replacing the one serving, and /health answered
 * 200 from the stale orphan throughout. A fix was then "verified live" against a
 * process that had never loaded it (#185150).
 *
 * Two design rules, both learned from that:
 *
 *  1. EVERY CHECK MUST BE ABLE TO SAY NO. `evaluate()` is pure and takes injected
 *     facts, so each check is tested against the broken machine it exists for —
 *     not only against a healthy one, where a check that always passes is
 *     indistinguishable from a check that works.
 *
 *  2. A GREEN /health MUST NOT MAKE THE VERDICT GREEN. Liveness is one fact among
 *     several, and it is the one that was green while everything else was wrong.
 *
 * Unmeasurable is `unknown`, never `pass`.
 */

const LOG_ROTATE_WARN_BYTES = 256 * 1024 * 1024

const CHECKS = [
  {
    id: 'launchd_pid_is_port_holder',
    title: 'launchd supervises the process that is actually serving',
    run (f) {
      if (f.launchdPid == null || f.portHolderPid == null) {
        return {
          status: 'unknown',
          detail: `could not read both pids (launchd=${fmt(f.launchdPid)}, :3200=${fmt(f.portHolderPid)}) — ` +
            'if nothing is listening the daemon is down; start it and re-run'
        }
      }
      if (f.launchdPid !== f.portHolderPid) {
        return {
          status: 'fail',
          detail: `SPLIT BRAIN: launchd's child is pid ${f.launchdPid} but pid ${f.portHolderPid} holds :3200. ` +
            'They are different processes, so `restart` replaces the one that is not serving and reports success. ' +
            `Fix: kill ${f.portHolderPid}, then restart so launchd owns the listener.`
        }
      }
      return { status: 'pass', detail: `pid ${f.launchdPid} is both launchd's child and the :3200 listener` }
    }
  },
  {
    id: 'single_executor',
    title: 'exactly one task executor is running',
    run (f) {
      const pids = f.bridgeProcessPids || []
      if (pids.length === 0) return { status: 'unknown', detail: 'no bridge process found — the daemon is not running' }
      if (pids.length > 1) {
        return {
          status: 'fail',
          detail: `${pids.length} bridge processes are running (${pids.join(', ')}). index.js starts an EMBEDDED ` +
            'task executor, so each one claims tasks for this same node id — which races on dispatch and makes ' +
            'each report a capacity that excludes the others\' active tasks.'
        }
      }
      return { status: 'pass', detail: `one process (pid ${pids[0]})` }
    }
  },
  {
    id: 'running_code_is_current',
    title: 'the running process loaded the code that is on disk',
    run (f) {
      if (f.processStartedMs == null || f.newestCodeMs == null) {
        return { status: 'unknown', detail: 'could not compare process start time to file mtimes' }
      }
      if (f.newestCodeMs > f.processStartedMs) {
        const mins = Math.round((f.newestCodeMs - f.processStartedMs) / 60000)
        return {
          status: 'fail',
          detail: `STALE: the newest file under the bridge is ${mins} minute(s) NEWER than the running process ` +
            `(started ${new Date(f.processStartedMs).toISOString()}, newest code ${new Date(f.newestCodeMs).toISOString()}). ` +
            'It is serving code you have already changed. Restart, then verify the pid CHANGED — a /health 200 ' +
            'proves a daemon is running, not that it restarted.'
        }
      }
      return { status: 'pass', detail: `process started after the newest file (${new Date(f.processStartedMs).toISOString()})` }
    }
  },
  {
    id: 'health_responds',
    title: '/health answers 200',
    run (f) {
      if (f.healthStatus == null) return { status: 'unknown', detail: 'no response from :3200/health' }
      return f.healthStatus === 200
        ? { status: 'pass', detail: 'HTTP 200' }
        : { status: 'fail', detail: `HTTP ${f.healthStatus}` }
    }
  },
  {
    id: 'config_valid',
    title: 'config.json parses, is complete, and is 0600',
    run (f) {
      const c = f.config
      if (!c) return { status: 'unknown', detail: 'config.json was not read' }
      if (!c.parsed) {
        return {
          status: 'fail',
          detail: 'config.json is not valid JSON — the daemon cannot read its own config. ' +
            '`iris-daemon register` used to write `"user_id":abc` when IRIS_USER_ID was non-numeric (#185145).'
        }
      }
      const required = ['node_api_key', 'user_id', 'node_id']
      const missing = required.filter(k => !(c.keys || []).includes(k))
      if (missing.length) {
        return {
          status: 'fail',
          detail: `config.json is missing: ${missing.join(', ')}. A truncating write in register destroyed ` +
            'fields it did not set (#185145); node_id is this node\'s identity.'
        }
      }
      if (c.mode != null && (c.mode & 0o777) !== 0o600) {
        return { status: 'fail', detail: `mode is ${(c.mode & 0o777).toString(8)}, must be 600 — it holds a live node key` }
      }
      return { status: 'pass', detail: `${(c.keys || []).length} fields, mode 600` }
    }
  },
  {
    id: 'watchdog_quiet',
    title: 'the watchdog has not had to kill the daemon since this boot',
    run (f) {
      const k = f.watchdogKills
      if (k == null) return { status: 'unknown', detail: 'could not read the daemon stderr log' }
      const sinceStart = k.sinceStart
      const historical = k.historical || 0

      // A LIFETIME count cannot tell "killed 54 times before you fixed it" from
      // "killed 54 times today", so it stays red after a fix that worked — and a
      // red that never goes green is one nobody reads. The watchdog message
      // carries an ISO timestamp precisely so this can be bounded to the boot.
      if (sinceStart == null) {
        return {
          status: 'unknown',
          detail: `${historical} kill(s) are recorded but carry no timestamp, so they cannot be bounded to ` +
            'this boot. These predate the timestamped watchdog message; they will age out of the log. ' +
            'Unbounded is unknown, not fine.'
        }
      }
      if (sinceStart > 0) {
        return {
          status: 'fail',
          detail: `${sinceStart} main-thread kill(s) SINCE THIS PROCESS STARTED. The daemon blocked its own ` +
            'event loop for over 60s and answered nothing while stuck. Look for synchronous work on the loop ' +
            `(execSync, a headed browser, a large readFileSync).${historical ? ` (${historical} more predate this boot.)` : ''}`
        }
      }
      return {
        status: 'pass',
        detail: historical
          ? `none since this boot; ${historical} earlier kill(s) remain in the log as history`
          : 'no kills recorded'
      }
    }
  },
  {
    id: 'log_rotation',
    title: 'the daemon log is not growing without bound',
    run (f) {
      if (f.stdoutLogBytes == null) return { status: 'unknown', detail: 'could not stat the stdout log' }
      if (f.stdoutLogBytes > LOG_ROTATE_WARN_BYTES) {
        return {
          status: 'fail',
          detail: `daemon.stdout.log is ${mb(f.stdoutLogBytes)} with no rotation. Past a few hundred MB every ` +
            'diagnostic grep over it is slow enough that people stop running them.'
        }
      }
      return { status: 'pass', detail: mb(f.stdoutLogBytes) }
    }
  }
]

function fmt (v) { return v == null ? 'unreadable' : String(v) }
function mb (b) { return `${(b / 1024 / 1024).toFixed(1)} MB` }

/**
 * Pure. Facts in, verdict out. Never reads the filesystem, so the broken-machine
 * cases are testable on a healthy machine.
 */
function evaluate (facts) {
  const checks = CHECKS.map(c => {
    const r = c.run(facts)
    return { id: c.id, title: c.title, status: r.status, detail: r.detail }
  })
  // `unknown` is not a pass. A daemon that cannot be measured is not healthy.
  const ok = checks.every(c => c.status === 'pass')
  return { ok, checks, exitCode: ok ? 0 : 1 }
}

module.exports = { evaluate, CHECKS, LOG_ROTATE_WARN_BYTES }
