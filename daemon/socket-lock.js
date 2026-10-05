'use strict'

const fs = require('fs')
const net = require('net')

/**
 * Who started this process, as launchd knows it.
 *
 * launchd sets XPC_SERVICE_NAME to the job's Label for everything it launches. A
 * process started from a terminal sees "0" or nothing. Null means "not a launchd
 * job" — a manual run, `iris daemon restart`, a test.
 */
function supervisorLabel (env = process.env) {
  const v = String(env.XPC_SERVICE_NAME || '').trim()
  if (!v || v === '0') return null
  return v
}

/**
 * Should the running daemon hand its socket to a newcomer?
 *
 * Handing over is right for a restart: the same launchd job relaunched, or a person
 * running the daemon by hand. It is wrong when TWO DIFFERENT launchd jobs both
 * supervise a daemon. Each start replaces the other, launchd's KeepAlive restarts
 * the loser, and it replaces the winner — forever. Measured 2026-10-02 on a Mac
 * with io.heyiris.daemon AND io.heyiris.daemon.cli loaded: 20 restarts in 15
 * minutes, the hub flagged the node crash-looping, and whenever a handoff overran
 * its 5 s deadline both daemons ran at once — two heartbeats, two Pusher
 * subscriptions, every task executed twice.
 */
function shouldYield (holderLabel, requesterLabel) {
  if (!holderLabel || !requesterLabel) return true
  return holderLabel === requesterLabel
}

/** What the newcomer is told when it is refused, and what a person should do about it. */
function duplicateAgentMessage (holderLabel, requesterLabel) {
  return `Two launch agents both start the IRIS daemon: ${holderLabel} (running) and ${requesterLabel} (this one). ` +
    `Only one may run. Remove the extra one: launchctl bootout gui/$(id -u)/${requesterLabel} && ` +
    `rm ~/Library/LaunchAgents/${requesterLabel}.plist`
}

/**
 * Take the IPC socket, asking a running daemon to hand over if there is one.
 *
 * @param {Object} o
 * @param {string}   o.sockPath
 * @param {Function} o.onAcquired     called once, when this process owns the socket
 * @param {Function} o.cleanupSocket  removes a stale socket file
 * @param {string?}  o.label          this process's launchd label (supervisorLabel())
 * @param {Function} [o.onStandby]    called once with the refusal message
 * @param {number}   [o.standbyPollMs]
 * @param {number}   [o.releaseTimeoutMs]
 * @param {Object}   [o.log]
 * @param {Function} [o.stopStale]    (pid) => Promise — stops a holder that overran its handoff
 * @returns {{ stop: Function }} stop() cancels a standby poll (tests, shutdown)
 */
function acquireSocketLock (o) {
  const log = o.log || console
  const pollMs = o.standbyPollMs || 30000
  const releaseTimeoutMs = o.releaseTimeoutMs || 5000
  let acquired = false
  let standbyTimer = null
  const acquire = () => {
    if (acquired) return
    acquired = true
    if (standbyTimer) clearTimeout(standbyTimer)
    o.onAcquired()
  }

  if (process.platform !== 'win32' && !fs.existsSync(o.sockPath)) {
    acquire()
    return { stop () {} }
  }

  // Standby: the running daemon is legitimate and refused to yield. Do nothing — no
  // heartbeat, no subscriptions — and take over only once it is really gone. Exiting
  // instead would just have launchd restart us every ThrottleInterval.
  const standby = () => {
    const probe = net.createConnection(o.sockPath, () => {
      probe.end()
      standbyTimer = setTimeout(standby, pollMs)
    })
    probe.on('error', () => {
      log.log('[startup] The running daemon has gone — taking over from standby')
      o.cleanupSocket()
      acquire()
    })
  }

  const probe = net.createConnection(o.sockPath, () => {
    log.log('[startup] Requesting handoff from running daemon...')
    probe.write(JSON.stringify({ cmd: 'replace', label: o.label || null }) + '\n')
  })

  probe.on('data', (data) => {
    let resp = {}
    try { resp = JSON.parse(data.toString().trim()) } catch { /* old daemon, plain text */ }
    probe.end()

    if (resp.status === 'refused') {
      const msg = resp.message || 'The running daemon refused to hand over.'
      log.error(`[startup] ${msg}`)
      log.error(`[startup] Standing by — checking every ${Math.round(pollMs / 1000)}s, taking no work until it stops.`)
      if (o.onStandby) o.onStandby(msg)
      standbyTimer = setTimeout(standby, pollMs)
      return
    }

    log.log(`[startup] ${resp.message || 'Previous daemon acknowledged'}`)
    const deadline = Date.now() + releaseTimeoutMs
    const waitForRelease = () => {
      const check = net.createConnection(o.sockPath, () => {
        check.end()
        if (Date.now() < deadline) {
          setTimeout(waitForRelease, 200)
        } else if (resp.pid && o.stopStale) {
          // Cleaning the socket alone left the holder running and invisible (#188006).
          log.error(`[startup] Previous daemon (PID ${resp.pid}) did not exit in time. Stopping it.`)
          Promise.resolve(o.stopStale(resp.pid)).catch(() => {}).then((outcome) => {
            log.log(`[startup] Previous daemon: ${outcome || 'stop attempted'}`)
            o.cleanupSocket()
            acquire()
          })
        } else {
          log.error('[startup] Previous daemon did not exit in time. Force-cleaning socket.')
          o.cleanupSocket()
          acquire()
        }
      })
      check.on('error', () => {
        o.cleanupSocket()
        log.log('[startup] Previous daemon stopped')
        acquire()
      })
    }
    setTimeout(waitForRelease, 500)
  })

  probe.on('error', (err) => {
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
      log.log('[startup] Cleaning stale socket')
    } else {
      log.error(`[startup] Socket probe failed: ${err.message}`)
    }
    o.cleanupSocket()
    acquire()
  })

  return { stop () { if (standbyTimer) clearTimeout(standbyTimer) } }
}

module.exports = { supervisorLabel, shouldYield, duplicateAgentMessage, acquireSocketLock }
