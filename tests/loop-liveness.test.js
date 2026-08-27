'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { execFileSync } = require('child_process')
const path = require('path')

/**
 * Killing a process whose main thread is blocked (#182371).
 *
 * The first attempt measured the loop's lateness FROM the loop. The machine disproved it in
 * 94 seconds: a timer on a blocked loop does not run, so it can only report a block after
 * recovery — and stays silent forever for a block that never ends, which is the only case
 * that matters.
 *
 * These spawn a real child that blocks its main thread the way readdirSync did, and assert
 * the process actually dies. Anything less would be testing the harness rather than the
 * guarantee.
 */

const ROOT = path.join(__dirname, '..')

function runChild (script, timeoutMs) {
  const started = Date.now()
  let code = 0
  let signal = null
  try {
    execFileSync(process.execPath, ['-e', script], { cwd: ROOT, timeout: timeoutMs, stdio: 'pipe' })
  } catch (err) {
    code = err.status
    signal = err.signal
  }
  return { ms: Date.now() - started, code, signal }
}

test('a process whose main thread blocks forever is KILLED', () => {
  // The real shape: synchronous work that never yields. SIGTERM would not help here, which
  // is why the worker sends SIGKILL.
  const script = `
    const { LoopLiveness } = require('./daemon/loop-liveness')
    new LoopLiveness({ thresholdMs: 2000, intervalMs: 200 }).start()
    setTimeout(() => { while (true) {} }, 300)   // block, and never come back
    setTimeout(() => {}, 60000)                  // keep the process alive otherwise
  `
  const r = runChild(script, 30000)
  assert.ok(r.signal === 'SIGKILL' || r.code, `expected the process to be killed, got ${JSON.stringify(r)}`)
  assert.ok(r.ms < 20000, `should die promptly once blocked, took ${r.ms}ms`)
})

test('a HEALTHY process is left alone', () => {
  const script = `
    const { LoopLiveness } = require('./daemon/loop-liveness')
    const l = new LoopLiveness({ thresholdMs: 1000, intervalMs: 100 })
    l.start()
    setTimeout(() => { l.stop(); process.exit(0) }, 3000)  // idle, loop turning
  `
  const r = runChild(script, 20000)
  assert.notStrictEqual(r.signal, 'SIGKILL', 'a healthy process must not be killed')
  assert.ok(r.ms >= 2500, `should have lived its full 3s, only ${r.ms}ms`)
})

test('a brief block under the threshold is survived', () => {
  // Real daemons stall briefly. Killing on every hiccup would be its own outage.
  const script = `
    const { LoopLiveness } = require('./daemon/loop-liveness')
    const l = new LoopLiveness({ thresholdMs: 3000, intervalMs: 100 })
    l.start()
    setTimeout(() => { const u = Date.now() + 1200; while (Date.now() < u) {} }, 200)
    setTimeout(() => { l.stop(); process.exit(0) }, 3000)
  `
  const r = runChild(script, 20000)
  assert.notStrictEqual(r.signal, 'SIGKILL', `a 1.2s stall under a 3s threshold must survive: ${JSON.stringify(r)}`)
})

test('start() reports whether the watchdog is actually armed', () => {
  const { LoopLiveness } = require('../daemon/loop-liveness')
  const l = new LoopLiveness({ thresholdMs: 60000, intervalMs: 1000 })
  const armed = l.start()
  // A guard that silently fails to arm is the defect this whole ticket is about.
  assert.strictEqual(armed, true)
  l.stop()
})
