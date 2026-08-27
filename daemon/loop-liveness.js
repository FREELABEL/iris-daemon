'use strict'

/**
 * Keep a heartbeat stamp the worker can read, and start that worker (#182371).
 *
 * The stamp is written on a plain interval on the MAIN thread. That is deliberate: the value
 * of the signal is that it STOPS when the loop stops. A blocked loop cannot stamp, and the
 * worker — which has its own loop — notices.
 */

const path = require('path')

class LoopLiveness {
  /**
   * @param {number} thresholdMs how stale the stamp may get before the process is killed
   * @param {number} intervalMs how often to stamp, and how often the worker checks
   */
  constructor ({ thresholdMs = 60000, intervalMs = 1000 } = {}) {
    this.thresholdMs = thresholdMs
    this.intervalMs = intervalMs
    this.timer = null
    this.worker = null
    this.stamp = null
  }

  start () {
    let Worker
    try {
      ({ Worker } = require('worker_threads'))
    } catch {
      // No worker_threads (ancient node): stamping alone is harmless, and the daemon runs
      // exactly as it did before. Degrade, never fail to boot.
      return false
    }

    const sab = new SharedArrayBuffer(4)
    this.stamp = new Int32Array(sab)
    this.origin = Date.now()
    this._touch()

    // Stamp from the main loop. If it stops turning, the stamp goes stale — that IS the
    // signal, so this must not be moved anywhere cleverer.
    this.timer = setInterval(() => this._touch(), this.intervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()

    try {
      this.worker = new Worker(path.join(__dirname, 'loop-liveness-worker.js'), {
        workerData: {
          sab,
          thresholdMs: this.thresholdMs,
          intervalMs: this.intervalMs,
          pid: process.pid,
          origin: this.origin,
        },
      })
      // The watchdog must never be the reason the process stays alive, or the reason it dies.
      this.worker.unref()
      this.worker.on('error', (err) => {
        console.error(`[watchdog] liveness worker error (daemon continues): ${err && err.message}`)
      })
    } catch (err) {
      console.error(`[watchdog] could not start liveness worker (daemon continues): ${err && err.message}`)
      return false
    }

    console.log(`[watchdog] main-thread liveness armed — kill after ${this.thresholdMs / 1000}s blocked`)
    return true
  }

  /**
   * Milliseconds since this object was created, NOT seconds-since-epoch.
   *
   * The first version stored whole seconds, because ms-since-epoch overflows a signed 32-bit
   * int. But flooring to a second means a stamp written right now reads as up to 999ms stale,
   * so any threshold near a second fires on a perfectly healthy process — a test with a 1s
   * threshold killed one at 844ms. Milliseconds since a local origin fit an int32 for about
   * 24 days and carry no such error.
   */
  _touch () {
    if (this.stamp) Atomics.store(this.stamp, 0, Date.now() - this.origin)
  }

  stop () {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.worker) { try { this.worker.terminate() } catch { /* already gone */ } this.worker = null }
  }
}

module.exports = { LoopLiveness }
