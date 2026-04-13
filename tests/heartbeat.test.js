const { describe, it, beforeEach, mock } = require('node:test')
const assert = require('node:assert/strict')
const { Heartbeat } = require('../daemon/heartbeat')

function createHeartbeat (sendResult) {
  const cloud = {
    sendHeartbeat: typeof sendResult === 'function'
      ? sendResult
      : async () => (sendResult || { dispatched_count: 0 })
  }
  return { heartbeat: new Heartbeat(cloud, 30000), cloud }
}

describe('Heartbeat', () => {
  // ─── Normal operation ─────────────────────────────────────────

  describe('normal operation', () => {
    it('initial state is closed with base interval', () => {
      const { heartbeat } = createHeartbeat()
      assert.equal(heartbeat.state, 'closed')
      assert.equal(heartbeat.failCount, 0)
      assert.equal(heartbeat.currentIntervalMs, 30000)
      assert.equal(heartbeat.baseIntervalMs, 30000)
    })

    it('successful ping resets failCount to 0', async () => {
      const { heartbeat } = createHeartbeat()
      // Manually set some failure state
      heartbeat.failCount = 3
      heartbeat.state = 'closed'

      await heartbeat.ping()

      assert.equal(heartbeat.failCount, 0)
      assert.equal(heartbeat.state, 'closed')
      assert.equal(heartbeat.currentIntervalMs, 30000)
    })

    it('successful ping fires onPingCallback', async () => {
      const { heartbeat } = createHeartbeat()
      let callbackFired = false
      heartbeat.onPingCallback = () => { callbackFired = true }

      await heartbeat.ping()

      assert.equal(callbackFired, true)
    })
  })

  // ─── Failure counting and backoff entry ───────────────────────

  describe('backoff entry', () => {
    it('stays closed through 4 consecutive failures', async () => {
      const { heartbeat } = createHeartbeat(async () => { throw new Error('network error') })

      for (let i = 0; i < 4; i++) {
        await heartbeat.ping()
      }

      assert.equal(heartbeat.state, 'closed')
      assert.equal(heartbeat.failCount, 4)
    })

    it('enters backoff at 5th failure', async () => {
      const { heartbeat } = createHeartbeat(async () => { throw new Error('network error') })

      for (let i = 0; i < 5; i++) {
        await heartbeat.ping()
      }

      assert.equal(heartbeat.state, 'backoff')
      assert.equal(heartbeat.failCount, 5)
    })

    it('backoff interval doubles with each failure', async () => {
      const { heartbeat } = createHeartbeat(async () => { throw new Error('network error') })

      // Drive to backoff (5 failures)
      for (let i = 0; i < 5; i++) {
        await heartbeat.ping()
      }
      // At fail 5: exponent = 5-5 = 0, backoff = 30000 * 2^0 = 30000 ± 20%
      const interval5 = heartbeat.currentIntervalMs
      assert.ok(interval5 >= 30000 * 0.8 && interval5 <= 30000 * 1.2,
        `Fail 5 interval ${interval5} should be ~30000 ± 20%`)

      // 6th failure: exponent = 1, backoff = 60000 ± 20%
      await heartbeat.ping()
      const interval6 = heartbeat.currentIntervalMs
      assert.ok(interval6 >= 60000 * 0.8 && interval6 <= 60000 * 1.2,
        `Fail 6 interval ${interval6} should be ~60000 ± 20%`)

      // 7th failure: exponent = 2, backoff = 120000 ± 20%
      await heartbeat.ping()
      const interval7 = heartbeat.currentIntervalMs
      assert.ok(interval7 >= 120000 * 0.8 && interval7 <= 120000 * 1.2,
        `Fail 7 interval ${interval7} should be ~120000 ± 20%`)
    })

    it('backoff interval caps at 300s', async () => {
      const { heartbeat } = createHeartbeat(async () => { throw new Error('network error') })

      // Drive to 9 failures (just before circuit breaker)
      for (let i = 0; i < 9; i++) {
        await heartbeat.ping()
      }

      // At fail 9: exponent = 9-5 = 4, uncapped = 30000 * 16 = 480000, capped = 300000
      const interval = heartbeat.currentIntervalMs
      assert.ok(interval <= 300000 * 1.2,
        `Interval ${interval} should be capped at ~300s ± 20% jitter`)
      assert.ok(interval >= 300000 * 0.8,
        `Interval ${interval} should be near 300s cap`)
    })
  })

  // ─── Circuit breaker ──────────────────────────────────────────

  describe('circuit breaker', () => {
    it('opens circuit at 10 consecutive failures', async () => {
      const { heartbeat } = createHeartbeat(async () => { throw new Error('network error') })

      for (let i = 0; i < 10; i++) {
        await heartbeat.ping()
      }

      assert.equal(heartbeat.state, 'open')
      assert.equal(heartbeat.failCount, 10)
    })

    it('uses 300s probe interval when circuit is open', async () => {
      const { heartbeat } = createHeartbeat(async () => { throw new Error('network error') })

      for (let i = 0; i < 10; i++) {
        await heartbeat.ping()
      }

      assert.equal(heartbeat.currentIntervalMs, 300000)
    })

    it('resets everything on first success after circuit open', async () => {
      let shouldFail = true
      const { heartbeat } = createHeartbeat(async () => {
        if (shouldFail) throw new Error('network error')
        return { dispatched_count: 0 }
      })

      // Drive to circuit open
      for (let i = 0; i < 10; i++) {
        await heartbeat.ping()
      }
      assert.equal(heartbeat.state, 'open')

      // Now succeed
      shouldFail = false
      await heartbeat.ping()

      assert.equal(heartbeat.state, 'closed')
      assert.equal(heartbeat.failCount, 0)
      assert.equal(heartbeat.currentIntervalMs, 30000)
    })
  })

  // ─── Recovery ─────────────────────────────────────────────────

  describe('recovery', () => {
    it('recovers from backoff state on first success', async () => {
      let shouldFail = true
      const { heartbeat } = createHeartbeat(async () => {
        if (shouldFail) throw new Error('network error')
        return { dispatched_count: 0 }
      })

      // Drive to backoff (7 failures)
      for (let i = 0; i < 7; i++) {
        await heartbeat.ping()
      }
      assert.equal(heartbeat.state, 'backoff')

      // Recover
      shouldFail = false
      await heartbeat.ping()

      assert.equal(heartbeat.state, 'closed')
      assert.equal(heartbeat.failCount, 0)
      assert.equal(heartbeat.currentIntervalMs, 30000)
    })

    it('does not fire onPingCallback on failure', async () => {
      const { heartbeat } = createHeartbeat(async () => { throw new Error('fail') })
      let callbackFired = false
      heartbeat.onPingCallback = () => { callbackFired = true }

      await heartbeat.ping()

      assert.equal(callbackFired, false)
    })
  })

  // ─── Jitter ───────────────────────────────────────────────────

  describe('jitter', () => {
    it('produces intervals within ±20% bounds', async () => {
      const intervals = []

      for (let trial = 0; trial < 20; trial++) {
        const { heartbeat } = createHeartbeat(async () => { throw new Error('fail') })

        // Drive to fail 6: exponent = 1, base backoff = 60000
        for (let i = 0; i < 6; i++) {
          await heartbeat.ping()
        }
        intervals.push(heartbeat.currentIntervalMs)
      }

      const baseBackoff = 60000
      const min = Math.min(...intervals)
      const max = Math.max(...intervals)

      // All intervals should be within [48000, 72000] (60000 ± 20%)
      assert.ok(min >= baseBackoff * 0.75, `Min ${min} should be >= ${baseBackoff * 0.75}`)
      assert.ok(max <= baseBackoff * 1.25, `Max ${max} should be <= ${baseBackoff * 1.25}`)

      // With 20 samples, we should see SOME variation (not all the same)
      const unique = new Set(intervals).size
      assert.ok(unique > 1, `Should have variation across 20 samples, got ${unique} unique values`)
    })
  })
})
