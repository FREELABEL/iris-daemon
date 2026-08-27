'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { EventLoopWatchdog } = require('../daemon/event-loop-watchdog')

/**
 * Detect a blocked event loop (#182371).
 *
 * MEASURED on a real node with `sample(1)`: 7666 of 7666 main-thread samples inside
 *
 *     uv__run_timers -> RunTimers -> [JS] -> node::fs::ReadDir -> uv_fs_scandir
 *       -> scandir -> __opendir2 -> open$NOCANCEL
 *
 * A synchronous directory walk, called from a TIMER, holding the loop for over an hour. While
 * it ran the daemon could not answer its own loopback health endpoint, did not process
 * heartbeats, and ignored SIGTERM — yet the fleet showed it ONLINE, because the last beat
 * before the block was genuine.
 *
 * The 30-minute heartbeat wedge detector cannot see this: it runs ON the loop that is stuck,
 * so it never gets to fire. Detection has to come from something that keeps its own clock —
 * a timer whose LATENESS is the signal, not its execution.
 */

test('a healthy loop is never reported blocked', async () => {
  let blocked = 0
  const w = new EventLoopWatchdog({ intervalMs: 20, thresholdMs: 200, onBlocked: () => blocked++ })
  w.start()
  await new Promise((r) => setTimeout(r, 250))
  w.stop()
  assert.strictEqual(blocked, 0)
})

test('a SYNCHRONOUSLY blocked loop is detected', async () => {
  let blocked = 0
  let reportedMs = 0
  const w = new EventLoopWatchdog({
    intervalMs: 20,
    thresholdMs: 150,
    onBlocked: (ms) => { blocked++; reportedMs = ms },
  })
  w.start()
  // Block the loop the way readdirSync does — busy, synchronous, uninterruptible.
  const until = Date.now() + 300
  while (Date.now() < until) { /* spin */ }
  await new Promise((r) => setTimeout(r, 60))
  w.stop()

  assert.strictEqual(blocked, 1, `expected exactly one report, got ${blocked}`)
  assert.ok(reportedMs >= 150, `should report how long it was blocked, got ${reportedMs}`)
})

test('it reports ONCE per block, not once per tick', async () => {
  // A supervisor needs a clean signal. Re-reporting every 20ms during a long block would
  // bury it, which is how the original failure stayed invisible in a busy log.
  let blocked = 0
  const w = new EventLoopWatchdog({ intervalMs: 10, thresholdMs: 80, onBlocked: () => blocked++ })
  w.start()
  const until = Date.now() + 400
  while (Date.now() < until) { /* spin */ }
  await new Promise((r) => setTimeout(r, 60))
  w.stop()
  assert.strictEqual(blocked, 1)
})

test('recovery re-arms it, so a second block is also caught', async () => {
  let blocked = 0
  const w = new EventLoopWatchdog({ intervalMs: 10, thresholdMs: 80, onBlocked: () => blocked++ })
  w.start()
  let until = Date.now() + 200
  while (Date.now() < until) { /* spin */ }
  await new Promise((r) => setTimeout(r, 120))      // recover
  until = Date.now() + 200
  while (Date.now() < until) { /* spin */ }
  await new Promise((r) => setTimeout(r, 60))
  w.stop()
  assert.strictEqual(blocked, 2, `both blocks must be reported, got ${blocked}`)
})

test('stop() ends it — a watchdog that cannot be stopped is its own outage', async () => {
  let blocked = 0
  const w = new EventLoopWatchdog({ intervalMs: 10, thresholdMs: 50, onBlocked: () => blocked++ })
  w.start()
  w.stop()
  const until = Date.now() + 150
  while (Date.now() < until) { /* spin */ }
  await new Promise((r) => setTimeout(r, 60))
  assert.strictEqual(blocked, 0)
})

test('a throwing handler does not kill the watchdog', async () => {
  let calls = 0
  const w = new EventLoopWatchdog({
    intervalMs: 10, thresholdMs: 60,
    onBlocked: () => { calls++; throw new Error('handler blew up') },
  })
  w.start()
  let until = Date.now() + 150
  while (Date.now() < until) { /* spin */ }
  await new Promise((r) => setTimeout(r, 100))
  until = Date.now() + 150
  while (Date.now() < until) { /* spin */ }
  await new Promise((r) => setTimeout(r, 60))
  w.stop()
  assert.strictEqual(calls, 2, 'must keep watching after a handler throws')
})

test('the timer does not hold the process open', () => {
  const w = new EventLoopWatchdog({ intervalMs: 10, thresholdMs: 50, onBlocked: () => {} })
  w.start()
  assert.strictEqual(typeof w.timer.unref, 'function')
  w.stop()
})
