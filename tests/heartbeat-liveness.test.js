'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { Heartbeat } = require('../daemon/heartbeat')

/**
 * The heartbeat loop must not be killable, and a wedged daemon must not sit there (#182371).
 *
 * MEASURED on a real node 2026-08-26: one `node daemon.js` alive for 1 day 2 hours with its
 * last heartbeat log line reading "Failed (7/5)" and nothing after. Its /daemon/health
 * endpoint returned nothing and it did not answer SIGTERM. The fleet view had shown it
 * ONLINE and then simply stale — never "unhealthy", because nothing was left running to say
 * so.
 *
 * Two independent defects:
 *   1. `_tick()` awaited ping() and only then rescheduled. A single REJECTION skipped the
 *      reschedule and ended the loop forever, in a process that stayed alive.
 *   2. Nothing noticed. A daemon that cannot reach the hub for hours should exit and let
 *      launchd revive it — "silently dead" is the one state a supervisor cannot fix.
 */

function stubCloud (impl) {
  return { sendHeartbeat: impl }
}

test('a REJECTING ping does not end the loop', async () => {
  // The original bug: `await this.ping()` then reschedule. ping() swallows its own errors
  // today, but any future throw outside that catch silently retired the node.
  let calls = 0
  const hb = new Heartbeat(stubCloud(async () => { calls++; throw new Error('boom') }), 20)
  hb.ping = async () => { calls++; throw new Error('rejected outright') }

  hb.start()
  await new Promise((r) => setTimeout(r, 130))
  hb.stop()

  assert.ok(calls >= 3, `loop should have kept ticking through rejections, saw ${calls}`)
})

test('the loop keeps running through ordinary failures', async () => {
  let calls = 0
  const hb = new Heartbeat(stubCloud(async () => { calls++; throw new Error('network') }), 20)
  hb.start()
  await new Promise((r) => setTimeout(r, 130))
  hb.stop()
  assert.ok(calls >= 3, `expected repeated attempts, saw ${calls}`)
})

test('stop() still stops it — the guard must not become unstoppable', async () => {
  let calls = 0
  const hb = new Heartbeat(stubCloud(async () => { calls++; return {} }), 20)
  hb.start()
  await new Promise((r) => setTimeout(r, 60))
  hb.stop()
  const after = calls
  await new Promise((r) => setTimeout(r, 80))
  assert.strictEqual(calls, after, 'no ticks may fire after stop()')
})

test('WEDGED: no successful heartbeat within the deadline reports it, once', async () => {
  // A supervisor can restart a process that exits. It cannot do anything about one that
  // stays alive and does nothing, which is what ran for 26 hours.
  let wedged = 0
  const hb = new Heartbeat(stubCloud(async () => { throw new Error('down') }), 20)
  hb.wedgedAfterMs = 60
  hb.onWedged = () => { wedged++ }

  hb.start()
  await new Promise((r) => setTimeout(r, 220))
  hb.stop()

  assert.strictEqual(wedged, 1, `must report exactly once, saw ${wedged}`)
})

test('a healthy daemon is never reported wedged', async () => {
  let wedged = 0
  const hb = new Heartbeat(stubCloud(async () => ({ ok: true })), 20)
  hb.wedgedAfterMs = 60
  hb.onWedged = () => { wedged++ }
  hb.start()
  await new Promise((r) => setTimeout(r, 200))
  hb.stop()
  assert.strictEqual(wedged, 0)
})

test('recovery clears the wedge clock — a blip must not arm a later false alarm', async () => {
  let fail = true
  let wedged = 0
  const hb = new Heartbeat(stubCloud(async () => { if (fail) throw new Error('down'); return {} }), 20)
  hb.wedgedAfterMs = 90
  hb.onWedged = () => { wedged++ }
  hb.start()
  await new Promise((r) => setTimeout(r, 50))
  fail = false                       // hub comes back before the deadline
  await new Promise((r) => setTimeout(r, 160))
  hb.stop()
  assert.strictEqual(wedged, 0, 'a recovered daemon must not later be declared wedged')
})
