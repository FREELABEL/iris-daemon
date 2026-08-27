'use strict'

/**
 * Notice when the daemon's event loop stops turning (#182371).
 *
 * MEASURED with sample(1) on a node that had been "online then stale" for over an hour:
 * 7666 of 7666 main-thread samples inside
 *
 *     uv__run_timers -> RunTimers -> [JS] -> node::fs::ReadDir -> uv_fs_scandir
 *       -> scandir -> __opendir2 -> open$NOCANCEL
 *
 * A synchronous directory walk on a timer, holding the loop. While it ran the daemon could
 * not answer its own loopback health endpoint, processed no heartbeats, and ignored SIGTERM.
 * The fleet showed it ONLINE the whole time, because the last beat before the block was
 * genuine — and a node that reports healthy while dead is worse than one that reports
 * unhealthy, because nothing can tell the two apart.
 *
 * WHY THE HEARTBEAT WEDGE DETECTOR CANNOT SEE THIS: it runs ON the loop that is stuck, so it
 * never gets to fire. Detection has to come from something whose signal is its own LATENESS
 * rather than its execution — a timer that measures how late it was.
 *
 * This does not prevent the block. It converts "wedged silently until a human notices" into
 * "exits, and the supervisor restarts it", which is the difference between a machine that is
 * unavailable for an hour and one that is unavailable for thirty seconds.
 */
class EventLoopWatchdog {
  /**
   * @param {object} opts
   * @param {number} opts.intervalMs how often to check
   * @param {number} opts.thresholdMs lateness that counts as blocked
   * @param {(lateMs:number)=>void} opts.onBlocked
   */
  constructor ({ intervalMs = 1000, thresholdMs = 30000, onBlocked = null } = {}) {
    this.intervalMs = intervalMs
    this.thresholdMs = thresholdMs
    this.onBlocked = onBlocked
    this.timer = null
    this.expectedAt = 0
    // Latched so one block produces ONE report. Re-reporting every tick during a long block
    // would bury the signal in the log, which is how the original failure stayed invisible.
    this.reported = false
  }

  start () {
    this.expectedAt = Date.now() + this.intervalMs
    this.timer = setInterval(() => this._check(), this.intervalMs)
    // Never hold the process open on the watchdog's account.
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  stop () {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  _check () {
    const now = Date.now()
    // How late is this tick? A turning loop fires within a few ms of schedule; a blocked one
    // cannot fire at all, so the lateness measured on the FIRST tick after it recovers is the
    // duration of the block.
    const lateBy = now - this.expectedAt
    this.expectedAt = now + this.intervalMs

    if (lateBy >= this.thresholdMs) {
      if (!this.reported) {
        this.reported = true
        console.error(`[watchdog] EVENT LOOP BLOCKED for ${Math.round(lateBy)}ms — this daemon answered nothing while it was stuck.`)
        if (typeof this.onBlocked === 'function') {
          // A failing handler must not take the watchdog down with it.
          try { this.onBlocked(lateBy) } catch { /* keep watching */ }
        }
      }
      return
    }

    // Healthy tick — re-arm so a LATER block is also caught.
    this.reported = false
  }
}

module.exports = { EventLoopWatchdog }
