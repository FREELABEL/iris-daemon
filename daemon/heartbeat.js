/**
 * Heartbeat — Sends periodic keepalive pings to the cloud.
 *
 * The cloud marks a node as offline if it misses heartbeats.
 * Also picks up any pending tasks dispatched between heartbeats.
 * Includes capacity data so the hub can route tasks intelligently.
 *
 * Resilience features:
 *   - Exponential backoff after consecutive failures (30s → 60s → 120s → 300s cap)
 *   - Circuit breaker after sustained failures (probes every 5 min)
 *   - ±20% jitter to prevent thundering herd across nodes
 *   - Auto-recovery on first successful ping
 */

class Heartbeat {
  constructor (cloudClient, intervalMs = 30000) {
    this.cloud = cloudClient
    this.baseIntervalMs = intervalMs
    this.currentIntervalMs = intervalMs
    this.timer = null
    this.failCount = 0
    this.maxFails = 5 // enter backoff after this many consecutive failures
    this.circuitBreakerThreshold = 10 // enter circuit-open after this many
    this.maxBackoffMs = 300000 // 5 minute cap
    this.circuitProbeMs = 300000 // 5 minute probe interval when circuit open

    // State machine: closed → backoff → open
    this.state = 'closed'

    // Callback to get current daemon state (set by Daemon)
    this.getStateCallback = null

    // Callback to write status file (set by Daemon)
    this.onPingCallback = null

    // LIVENESS (#182371). A daemon that cannot reach the hub for this long is not
    // "degraded", it is gone — and the one state a supervisor cannot fix is a process that
    // stays alive doing nothing. Measured on a real node: alive 1 day 2 hours, last log line
    // "Failed (7/5)", /daemon/health silent, unresponsive to SIGTERM, and ONLINE in the fleet
    // view the whole time. Exiting lets launchd revive it; sitting there cannot be recovered
    // from without a human noticing.
    this.wedgedAfterMs = 30 * 60 * 1000
    this.lastSuccessAt = Date.now()
    this.wedgedReported = false
    this.onWedged = null
  }

  start () {
    this._scheduleNext()
    console.log(`[heartbeat] Started — every ${this.baseIntervalMs / 1000}s`)
  }

  stop () {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    console.log('[heartbeat] Stopped')
  }

  _scheduleNext () {
    this.timer = setTimeout(() => this._tick(), this.currentIntervalMs)
  }

  async _tick () {
    // The reschedule lives in `finally` ON PURPOSE. This used to be
    //     await this.ping(); if (this.timer !== null) this._scheduleNext()
    // so a single REJECTION from ping() skipped the reschedule and ended the loop forever,
    // inside a process that stayed alive and kept reporting itself as a healthy node. One
    // unexpected throw retired a machine from the fleet silently (#182371).
    try {
      await this.ping()
    } catch (err) {
      // ping() handles its own failures; anything reaching here is a bug in that handling.
      // It must never be the reason the loop stops.
      console.error(`[heartbeat] tick error (loop continues): ${err && err.message}`)
    } finally {
      this._checkWedged()
      // Only schedule next if we haven't been stopped.
      if (this.timer !== null) {
        this._scheduleNext()
      }
    }
  }

  /**
   * Has this daemon been unable to reach the hub for long enough to count as dead?
   *
   * Reported ONCE per wedge, so a supervisor gets a clean signal rather than a repeating
   * alarm, and the clock resets on any success — a transient outage must not arm a false
   * alarm hours later.
   */
  _checkWedged () {
    if (this.wedgedReported) return
    if (Date.now() - this.lastSuccessAt < this.wedgedAfterMs) return

    this.wedgedReported = true
    const mins = Math.round((Date.now() - this.lastSuccessAt) / 60000)
    console.error(`[heartbeat] WEDGED — no successful heartbeat in ${mins}m. This node is not reachable by the hub and cannot be recovered in place.`)
    if (typeof this.onWedged === 'function') {
      try { this.onWedged(mins) } catch { /* a failing handler must not stop the loop */ }
    }
  }

  async ping () {
    try {
      // Gather daemon state to send with heartbeat
      const extra = this.getStateCallback ? this.getStateCallback() : {}
      const result = await this.cloud.sendHeartbeat(extra)

      // Success — reset everything
      if (this.state !== 'closed') {
        console.log(`[heartbeat] Recovered — resuming normal ${this.baseIntervalMs / 1000}s heartbeat`)
      }
      this.failCount = 0
      this.state = 'closed'
      this.currentIntervalMs = this.baseIntervalMs
      // Reset the wedge clock AND its latch: a node that recovered is healthy again, and
      // must be able to report a NEW wedge later rather than staying permanently armed.
      this.lastSuccessAt = Date.now()
      this.wedgedReported = false

      // Trigger status file write after successful heartbeat
      if (this.onPingCallback) this.onPingCallback()

      // ── Status summary — log active tasks + capacity every heartbeat ──
      const state = this.getStateCallback ? this.getStateCallback() : {}
      const runningIds = state.running_task_ids || []
      const capacity = state.capacity || {}
      const activeTasks = result.active_tasks ?? runningIds.length
      const paused = state.paused ? ' [PAUSED]' : ''

      const ts = new Date().toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' })
      if (activeTasks > 0 || result.dispatched_count > 0) {
        const parts = [
          `[heartbeat] [${ts}] ${capacity.level || '?'}${paused}`,
          `tasks: ${activeTasks} active`,
        ]
        if (result.dispatched_count > 0) {
          parts.push(`${result.dispatched_count} new`)
        }
        // Show running task titles
        if (runningIds.length > 0 && this.getStateCallback) {
          const state = this.getStateCallback()
          const executor = state._executor
          // Just show count + IDs for brevity
        }
        console.log(parts.join(' | '))
      } else {
        // Quiet heartbeat — only log every 5th one when idle
        if (!this._idleCount) this._idleCount = 0
        this._idleCount++
        if (this._idleCount % 5 === 0) {
          console.log(`[heartbeat] [${ts}] idle | ready for tasks`)
        }
      }

      // Log if tasks were dispatched during heartbeat
      if (result.dispatched_count > 0) {
        console.log(`[heartbeat] ${result.dispatched_count} task(s) dispatched via heartbeat`)
      }
    } catch (err) {
      this.failCount++
      console.error(`[heartbeat] Failed (${this.failCount}/${this.maxFails}): ${err.message}`)

      if (this.failCount >= this.circuitBreakerThreshold && this.state !== 'open') {
        // Circuit breaker — sustained failures, switch to slow probe
        this.state = 'open'
        this.currentIntervalMs = this.circuitProbeMs
        console.error(`[heartbeat] Circuit OPEN — probing every ${this.circuitProbeMs / 1000}s`)
      } else if (this.failCount >= this.maxFails && this.state === 'closed') {
        // Enter backoff
        this.state = 'backoff'
        this._applyBackoff()
      } else if (this.state === 'backoff') {
        // Already in backoff — increase interval
        this._applyBackoff()
      }
    }
  }

  _applyBackoff () {
    // Exponential: baseInterval * 2^(failCount - maxFails), capped at maxBackoffMs
    const exponent = this.failCount - this.maxFails
    const backoffMs = Math.min(this.baseIntervalMs * Math.pow(2, exponent), this.maxBackoffMs)

    // Add jitter: ±20% to prevent thundering herd
    const jitter = backoffMs * 0.2 * (Math.random() * 2 - 1)
    this.currentIntervalMs = Math.round(backoffMs + jitter)

    console.log(`[heartbeat] Backing off — next ping in ${(this.currentIntervalMs / 1000).toFixed(1)}s`)
  }
}

module.exports = { Heartbeat }
