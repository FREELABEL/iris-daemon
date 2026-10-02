const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { shouldPollPending } = require('../daemon/pending-poll')

/**
 * #187457 — "Work that was never pushed is still work."
 *
 * A node whose push subscription has silently died (measured 2026-10-01: three tasks idle for 54 s,
 * then started together at a heartbeat; a single `iris hive run` took 85 s) only got its work through
 * the server's 60 s orphan path. The heartbeat reply's dispatched_count does NOT reveal it: that counts
 * tasks the heartbeat itself dispatched, and a dead-push task was dispatched at creation.
 *
 * So after each successful heartbeat the daemon asks for its own assigned/dispatched tasks — when it
 * has room, and not more often than the interval.
 */
describe('shouldPollPending', () => {
  const base = { now: 100000, lastPollAt: 0, active: 0, max: 3, intervalMs: 25000 }

  it('polls after a heartbeat when it has room and has not polled recently', () => {
    assert.equal(shouldPollPending(base), true)
  })
  it('does not poll when every slot is busy — it could not take the work anyway', () => {
    assert.equal(shouldPollPending({ ...base, active: 3 }), false)
  })
  it('does not poll more often than the interval', () => {
    assert.equal(shouldPollPending({ ...base, lastPollAt: base.now - 10000 }), false)
    assert.equal(shouldPollPending({ ...base, lastPollAt: base.now - 26000 }), true)
  })
  it('treats a missing or broken max as one slot, never as unlimited or zero', () => {
    assert.equal(shouldPollPending({ ...base, max: undefined }), true)
    assert.equal(shouldPollPending({ ...base, max: undefined, active: 1 }), false)
  })
  it('does not poll while paused', () => {
    assert.equal(shouldPollPending({ ...base, paused: true }), false)
  })
})
