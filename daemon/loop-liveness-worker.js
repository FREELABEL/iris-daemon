'use strict'

/**
 * Watch the main thread from OFF the main thread (#182371).
 *
 * The first attempt at this was a setInterval on the main loop that measured its own
 * lateness. It cannot work, and the machine proved it within 94 seconds: a timer on a blocked
 * loop does not run, so it reports a block only AFTER the loop recovers. For a block that
 * never ends — which is the case that matters — it is silent forever, exactly like the bug it
 * was meant to catch.
 *
 * So the check runs in a worker thread with its own event loop. The main thread stamps a
 * SharedArrayBuffer on every tick; this worker reads it. Shared memory is the only channel
 * that survives, because postMessage would be delivered TO the loop that is stuck.
 *
 * When the stamp goes stale the worker sends SIGKILL to its own process. SIGKILL is the one
 * signal a blocked thread cannot ignore — the real incident took SIGKILL by hand after
 * SIGTERM was ignored for an hour.
 */

const { workerData, parentPort } = require('worker_threads')

const stamp = new Int32Array(workerData.sab)
const thresholdMs = workerData.thresholdMs
const intervalMs = workerData.intervalMs
const pid = workerData.pid
const origin = workerData.origin

setInterval(() => {
  // Milliseconds since a shared origin. Storing whole seconds instead made a fresh stamp
  // read as up to 999ms stale, which killed healthy processes on short thresholds.
  const last = Atomics.load(stamp, 0)
  if (last === 0) return // main thread has not stamped yet

  const staleMs = (Date.now() - origin) - last
  if (staleMs < thresholdMs) return

  const msg = `[watchdog] MAIN THREAD BLOCKED for ${Math.round(staleMs / 1000)}s — it answered nothing while stuck. Killing pid ${pid} so the supervisor restarts it. (#182371)\n`

  // writeSync, NOT console.error. console.error buffers, and SIGKILL a microsecond later
  // discards the buffer — measured in production: the process restarted every ~100s with
  // NOTHING in the log to say why, so the watchdog was killing silently and looked like it
  // had never fired. A watchdog whose reason dies with the process is the same
  // cannot-distinguish defect it exists to fix.
  try { require('fs').writeSync(2, msg) } catch { /* nothing better available */ }
  try { parentPort && parentPort.postMessage({ blocked: true, staleMs }) } catch { /* main thread is stuck; expected */ }

  // SIGKILL, not SIGTERM. A blocked thread never runs a SIGTERM handler — measured: the real
  // incident ignored SIGTERM and required kill -9.
  try { process.kill(pid, 'SIGKILL') } catch { /* nothing left to do */ }
}, intervalMs)
// NOT unref'd. This interval is the worker's only handle, so unref'ing it leaves the worker's
// event loop with nothing to keep it alive and the thread exits immediately — the watchdog
// then never runs at all. Measured: a deliberately-blocked child survived its full 30s.
// The parent unrefs the WORKER, which is what keeps this from holding the process open.
