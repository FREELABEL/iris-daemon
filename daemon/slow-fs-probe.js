'use strict'

/**
 * Name the synchronous fs call that blocks the event loop (#182371).
 *
 * sample(1) proved WHAT is blocking — 7666 of 7666 main-thread samples in
 * node::fs::ReadDir -> uv_fs_scandir -> scandir -> opendir -> open, reached from a timer —
 * but a native profile cannot name the JS call site: the JIT frames render as
 * "??? (in <unknown binary>)".
 *
 * Reading the code did not settle it either. There are a dozen readdirSync call sites and the
 * obvious suspect (_dirSize, recursive and unbounded) is only reachable from HTTP routes,
 * while the stack says timer. So: instrument the real thing and let the machine answer.
 *
 * OFF unless IRIS_FS_PROBE_MS is set. This wraps hot fs calls, so it is a diagnostic, not
 * something to leave running.
 *
 * writeSync, not console.error: the process this is diagnosing gets SIGKILLed by the liveness
 * watchdog, and a buffered write dies with it — the same way the watchdog's own kill message
 * was lost until it was made synchronous.
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

const WRAPPED = ['readdirSync', 'statSync', 'lstatSync', 'readFileSync', 'existsSync']

function install () {
  const thresholdMs = Number(process.env.IRIS_FS_PROBE_MS || 0)
  if (!thresholdMs || Number.isNaN(thresholdMs)) return false

  const logPath = process.env.IRIS_FS_PROBE_LOG || path.join(os.homedir(), '.iris', 'logs', 'slow-fs.log')
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }) } catch { /* best effort */ }

  let fd
  try { fd = fs.openSync(logPath, 'a') } catch { return false }

  const write = (s) => { try { fs.writeSync(fd, s) } catch { /* nothing better */ } }
  write(`\n=== fs probe armed ${new Date().toISOString()} threshold=${thresholdMs}ms pid=${process.pid} ===\n`)

  // AGGREGATE, not per-call.
  //
  // The first version logged any single call over the threshold and caught NOTHING, while the
  // daemon was demonstrably still blocking. That matched the profile's other reading: the
  // sample's leaf caught a DIFFERENT open() every time, so this is thousands of individually
  // fast calls in a tight synchronous walk — not one slow call. A per-call threshold cannot
  // see that shape at all.
  //
  // So: accumulate time and counts SINCE THE EVENT LOOP LAST TURNED. A setImmediate can only
  // run when the loop is free, so it is a reliable "we yielded" marker. When the accumulator
  // crosses the threshold without a yield, dump the hottest call sites once.
  let sinceYieldMs = 0
  let sinceYieldCalls = 0
  let dumped = false
  const byFn = new Map()   // fs function -> { ms, n, sample }

  const armYield = () => {
    // unref'd: this re-arms itself forever, so without it the probe alone keeps the process
    // alive and nothing that loads it can ever exit. (It hung its own test suite.)
    const im = setImmediate(() => {
      sinceYieldMs = 0
      sinceYieldCalls = 0
      dumped = false
      byFn.clear()
      armYield()
    })
    if (typeof im.unref === 'function') im.unref()
  }
  armYield()

  for (const name of WRAPPED) {
    const orig = fs[name]
    if (typeof orig !== 'function') continue

    fs[name] = function probed (...args) {
      // hrtime, NOT Date.now(). Date.now() resolves to ~1ms, so tens of thousands of
      // sub-millisecond calls each measure 0 and the sum is 0 — the aggregate view goes blind
      // to exactly the shape it exists to catch. Measured: 40,000 calls spanning 423ms
      // summed to under the threshold and reported nothing.
      const t0 = process.hrtime.bigint()
      try {
        return orig.apply(this, args)
      } finally {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6
        sinceYieldMs += ms
        sinceYieldCalls++

        // Count by FUNCTION and remember one path. No per-call stack capture: building a
        // stack on every call costs more than the fs work it is measuring, which made the
        // aggregate look tiny — 40,000 calls spanning 522ms of wall time summed to well under
        // the threshold because most of that 522ms was the probe. The stack is captured ONCE,
        // at the dump, which is the only place it is needed.
        let e = byFn.get(name)
        if (!e) { e = { ms: 0, n: 0, sample: null }; byFn.set(name, e) }
        e.ms += ms
        e.n++
        if (!e.sample && typeof args[0] === 'string') e.sample = args[0]

        if (!dumped && sinceYieldMs >= thresholdMs) {
          dumped = true
          const top = [...byFn.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8)
          let out = `\n[BLOCKED ${Math.round(sinceYieldMs)}ms across ${sinceYieldCalls} sync fs calls WITHOUT yielding] ${new Date().toISOString()}\n`
          for (const [fnName, v] of top) {
            out += `   ${String(Math.round(v.ms)).padStart(6)}ms  ${String(v.n).padStart(6)}x  fs.${fnName}\n`
            if (v.sample) out += `           e.g. ${v.sample}\n`
          }
          out += '   --- JS stack, captured once, at the dump ---\n'
          out += (new Error().stack || '').split('\n').slice(2, 18).join('\n') + '\n'
          write(out)
        }
      }
    }
  }

  return true
}

module.exports = { install, WRAPPED }
