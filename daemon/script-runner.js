'use strict'

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

/**
 * Run a pushed script, with a timeout that is actually enforceable.
 *
 * WHY THIS IS A MODULE. The logic used to live inline in daemon/index.js and the test suite kept
 * a hand-copied duplicate of it ("copied from daemon/index.js"). The copy had already drifted —
 * no env merge, duration hardcoded to 0 — so the tests were green against a fiction while the
 * real handler carried the bugs below. One implementation, imported by both, or the tests are
 * decoration.
 *
 * THE BUG THIS EXISTS TO FIX (measured 2026-08-05). `spawn` without `detached` puts the child in
 * the daemon's process group, so `child.kill('SIGKILL')` reaches ONLY the direct child. Any
 * grandchild survives, inherits the stdout pipe, and keeps it open — and node's `close` event
 * waits for stdio EOF, not for the child to die. So:
 *
 *   timeout_ms: 3000  ->  actual duration 25266ms, and the grandchild's output still arrived.
 *
 * The timeout was unenforceable. A `railway ssh` that hung turned a documented 30s cap into a
 * 206s one, and a runaway script could not be stopped at all. The fix is a process GROUP: give
 * the child its own group with `detached`, then signal `-pid` to take the whole tree.
 *
 * THE SECOND BUG. Output was accumulated unbounded (`stdout += chunk`) and only truncated at the
 * very end with `.slice(-50000)`. A script that prints a few GB therefore OOMs the daemon long
 * before anything gets trimmed — the cap protected the RESPONSE, never the node. Buffering here
 * is bounded as chunks arrive, and truncation is REPORTED rather than silent, because output
 * that vanishes without a marker is indistinguishable from output that was never produced.
 */

const DEFAULT_TIMEOUT_MS = 30_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 300_000

const STDOUT_CAP = 50_000
const STDERR_CAP = 10_000

// After SIGTERM, how long a script gets to clean up before the group is SIGKILLed.
const TERM_GRACE_MS = 2_000
// After the group is killed, how long to wait for stdio to drain before resolving anyway. A
// process we cannot kill must not be able to hold the HTTP request open forever.
const REAP_GRACE_MS = 1_000

const INTERPRETERS = { '.py': 'python3', '.js': 'node', '.ts': 'npx' }

/** Keep only the last `cap` bytes, but remember how much really came through. */
class TailBuffer {
  constructor (cap) {
    this.cap = cap
    this.text = ''
    this.total = 0
  }

  push (chunk) {
    const s = String(chunk)
    this.total += s.length
    this.text = this.text.length + s.length <= this.cap
      ? this.text + s
      : (this.text + s).slice(-this.cap)
  }

  get truncated () {
    return this.total > this.text.length
  }

  /**
   * Truncation is announced in-band. A caller reading only `stdout` still sees that something
   * was dropped — the marker is the whole point, so it must survive being printed naively.
   */
  render () {
    if (!this.truncated) return this.text
    const dropped = this.total - this.text.length
    return `[... ${dropped} bytes of earlier output truncated, ${this.total} total ...]\n${this.text}`
  }
}

function clampTimeout (ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(n, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
}

/** Reject path separators and traversal — a filename is a plain name. */
function isPlainFilename (name) {
  return typeof name === 'string' &&
    name.length > 0 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..')
}

/**
 * Signal an entire process group, tolerating the race where it has already exited.
 * Returns true if the signal was delivered.
 */
function killGroup (pid, signal) {
  try {
    process.kill(-pid, signal)
    return true
  } catch (err) {
    if (err.code === 'ESRCH') return false // already gone — the good case
    // EPERM means it is alive and not ours. Fall back to the direct child so a timeout still
    // does SOMETHING rather than silently doing nothing.
    try { process.kill(pid, signal); return true } catch { return false }
  }
}

/**
 * @returns {Promise<{status:string, exit_code:number|null, signal:string|null, stdout:string,
 *   stderr:string, stdout_truncated:boolean, stderr_truncated:boolean, duration_ms:number,
 *   timed_out:boolean, script_path:string|null}>}
 */
function runScript (opts) {
  const {
    scriptsDir,
    filename,
    content,
    args = [],
    timeoutMs,
    persist = false,
    env = {}
  } = opts

  if (!filename || !content) {
    const err = new Error('filename and content required')
    err.statusCode = 400
    return Promise.reject(err)
  }
  if (!isPlainFilename(filename)) {
    const err = new Error('filename must be a plain name (no paths)')
    err.statusCode = 400
    return Promise.reject(err)
  }

  if (!fs.existsSync(scriptsDir)) fs.mkdirSync(scriptsDir, { recursive: true })
  const scriptPath = path.join(scriptsDir, filename)
  fs.writeFileSync(scriptPath, content, 'utf-8')
  fs.chmodSync(scriptPath, '755')

  const ext = path.extname(filename).toLowerCase()
  const cmd = INTERPRETERS[ext] || '/bin/bash'
  const spawnArgs = ext === '.ts'
    ? ['ts-node', scriptPath, ...args]
    : [scriptPath, ...args]

  const timeout = clampTimeout(timeoutMs)
  const startTime = Date.now()

  return new Promise((resolve) => {
    const child = spawn(cmd, spawnArgs, {
      cwd: scriptsDir,
      env: { ...process.env, ...(env && typeof env === 'object' ? env : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      // The entire fix. Its own process group, so a timeout can take the whole tree.
      detached: true
    })

    const out = new TailBuffer(STDOUT_CAP)
    const errb = new TailBuffer(STDERR_CAP)
    child.stdout.on('data', d => out.push(d))
    child.stderr.on('data', d => errb.push(d))

    let timedOut = false
    let settled = false
    let termTimer = null
    let killTimer = null
    let reapTimer = null

    const finish = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(termTimer)
      clearTimeout(killTimer)
      clearTimeout(reapTimer)

      if (!persist && fs.existsSync(scriptPath)) {
        try { fs.unlinkSync(scriptPath) } catch { /* best effort */ }
      }

      resolve({
        status: timedOut ? 'timeout' : (code === 0 ? 'completed' : 'failed'),
        exit_code: code,
        signal: signal || null,
        stdout: out.render(),
        stderr: errb.render(),
        stdout_truncated: out.truncated,
        stderr_truncated: errb.truncated,
        duration_ms: Date.now() - startTime,
        timed_out: timedOut,
        script_path: persist ? '/scripts/' + filename : null
      })
    }

    termTimer = setTimeout(() => {
      timedOut = true
      // Ask nicely first so a script can clean up, then take the group.
      killGroup(child.pid, 'SIGTERM')
      killTimer = setTimeout(() => {
        killGroup(child.pid, 'SIGKILL')
        // Even a group kill can leave something we are not allowed to signal. Resolve anyway:
        // an unkillable grandchild must not hold the request open, which is the 206s failure.
        reapTimer = setTimeout(() => finish(null, 'SIGKILL'), REAP_GRACE_MS)
      }, TERM_GRACE_MS)
    }, timeout)

    // `exit` fires when the CHILD dies; `close` waits for stdio EOF, which an orphan can hold
    // open indefinitely. Prefer close for clean runs (all output flushed), but never depend on
    // it once we have started killing.
    child.on('close', (code, signal) => finish(code, signal))
    child.on('exit', (code, signal) => {
      if (timedOut) setTimeout(() => finish(code, signal), REAP_GRACE_MS)
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(termTimer)
      clearTimeout(killTimer)
      clearTimeout(reapTimer)
      if (!persist && fs.existsSync(scriptPath)) {
        try { fs.unlinkSync(scriptPath) } catch { /* best effort */ }
      }
      const e = new Error(err.message)
      e.statusCode = 500
      resolve({ status: 'failed', exit_code: null, signal: null, stdout: '', stderr: err.message, stdout_truncated: false, stderr_truncated: false, duration_ms: Date.now() - startTime, timed_out: false, script_path: null, error: err.message })
    })
  })
}

module.exports = {
  runScript,
  clampTimeout,
  isPlainFilename,
  TailBuffer,
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  STDOUT_CAP,
  STDERR_CAP
}
