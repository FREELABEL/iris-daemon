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

  for (const name of WRAPPED) {
    const orig = fs[name]
    if (typeof orig !== 'function') continue

    fs[name] = function probed (...args) {
      const t0 = Date.now()
      try {
        return orig.apply(this, args)
      } finally {
        const ms = Date.now() - t0
        if (ms >= thresholdMs) {
          // The stack is the whole point — it is what a native profile cannot give.
          const stack = (new Error().stack || '').split('\n').slice(2, 12).join('\n')
          const target = typeof args[0] === 'string' ? args[0] : String(args[0])
          write(`\n[SLOW fs.${name}] ${ms}ms  ${target}\n${stack}\n`)
        }
      }
    }
  }

  return true
}

module.exports = { install, WRAPPED }
