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

test('the REASON survives the kill', () => {
  // console.error buffers; SIGKILL a microsecond later discards it. In production the daemon
  // restarted every ~100s with nothing in the log to say why, so the watchdog looked like it
  // had never fired. The kill is worthless if it cannot say what it killed.
  const script = `
    const { LoopLiveness } = require('./daemon/loop-liveness')
    new LoopLiveness({ thresholdMs: 1500, intervalMs: 200 }).start()
    setTimeout(() => { while (true) {} }, 300)
    setTimeout(() => {}, 60000)
  `
  let stderr = ''
  try {
    execFileSync(process.execPath, ['-e', script], { cwd: ROOT, timeout: 25000, stdio: 'pipe' })
  } catch (err) {
    stderr = String(err.stderr || '')
  }
  assert.match(stderr, /MAIN THREAD BLOCKED/, `the kill must explain itself; got: ${stderr.slice(0, 200)}`)
})

test('start() reports whether the watchdog is actually armed', () => {
  const { LoopLiveness } = require('../daemon/loop-liveness')
  const l = new LoopLiveness({ thresholdMs: 60000, intervalMs: 1000 })
  const armed = l.start()
  // A guard that silently fails to arm is the defect this whole ticket is about.
  assert.strictEqual(armed, true)
  l.stop()
})

/**
 * A machine that SLEPT is not a process that HUNG.
 *
 * Sleep freezes every thread, the watchdog's included, while the wall clock keeps going. On
 * wake the watchdog's first check compared the clock to a stamp from before the sleep and
 * killed a perfectly healthy daemon. Measured on a MacBook that sleeps after one idle minute:
 * 254 such kills, 62–353 s each, each one dropping its in-flight task and its MeshLLM.
 *
 * SIGSTOP is the faithful stand-in: it freezes every thread of the process while time passes,
 * exactly as sleep does.
 */
const { spawn } = require('child_process')

function startWatched (script) {
  const child = spawn(process.execPath, ['-e', script], { cwd: ROOT, stdio: 'pipe' })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  return { child, exited, stderr: () => stderr }
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

test('a process frozen by SLEEP is not killed when it wakes', async () => {
  const w = startWatched(`
    const { LoopLiveness } = require('./daemon/loop-liveness')
    new LoopLiveness({ thresholdMs: 2000, intervalMs: 200 }).start()
    setTimeout(() => process.exit(0), 60000)
  `)
  await pause(800)                    // armed and stamping
  w.child.kill('SIGSTOP')             // "the lid closes"
  await pause(4000)                   // twice the threshold
  w.child.kill('SIGCONT')             // "the lid opens"
  await pause(2500)                   // longer than the threshold again, now awake
  const alive = w.child.exitCode === null && w.child.signalCode === null
  w.child.kill('SIGKILL')
  await w.exited
  assert.ok(alive, `a healthy process must survive a sleep; watchdog said: ${w.stderr().slice(0, 200)}`)
})

test('…but a main thread that is STILL stuck after the wake is killed', async () => {
  const w = startWatched(`
    const { LoopLiveness } = require('./daemon/loop-liveness')
    new LoopLiveness({ thresholdMs: 2000, intervalMs: 200 }).start()
    process.on('SIGCONT', () => { while (true) {} })   // wakes up, then hangs for real
    setTimeout(() => {}, 60000)
  `)
  await pause(800)
  w.child.kill('SIGSTOP')
  await pause(4000)
  w.child.kill('SIGCONT')
  const r = await Promise.race([w.exited, pause(12000).then(() => null)])
  if (!r) w.child.kill('SIGKILL')
  assert.ok(r && r.signal === 'SIGKILL', `a real hang after waking must still be killed; got ${JSON.stringify(r)}`)
  assert.match(w.stderr(), /MAIN THREAD BLOCKED/)
})
