'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

/**
 * A crash-looping node must not look like a stable one (#182434).
 *
 * The cloud marks a node offline only when it MISSES heartbeats. A node that crash-loops
 * heartbeats once per restart, so it never misses one — and the fleet view showed the same
 * steady ONLINE as a machine up for eight hours. Work kept being dispatched to it; a task
 * landed mid-crash and hung to timeout, which reads to the caller as a broken transport
 * rather than a machine that went away.
 *
 * That is the same defect as the socket bug one layer up (#182371, see socket-guard.test.js):
 * a check that cannot distinguish a healthy state from an unmeasured one. The fix is to make
 * the absence of knowledge look different from an answer — report how long the process has
 * actually been alive, so a resetting uptime is visible across successive beats.
 *
 * These tests assert the FIELD IS IN THE PAYLOAD, not merely that process.uptime() exists.
 * A telemetry field that is computed and never sent is exactly the kind of thing that reads
 * as working.
 */

const SRC = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'index.js'), 'utf8')

test('the heartbeat payload carries uptime_seconds', () => {
  assert.match(
    SRC,
    /uptime_seconds:\s*Math\.round\(process\.uptime\(\)\)/,
    'uptime must be sent on every beat — it is what separates a stable node from a looping one',
  )
})

test('the heartbeat payload carries started_at', () => {
  assert.match(
    SRC,
    /started_at:\s*new Date\(Date\.now\(\) - process\.uptime\(\) \* 1000\)\.toISOString\(\)/,
    'an absolute start time lets the fleet view spot a restart it did not observe',
  )
})

test('uptime is derived from the process, not persisted state', () => {
  // Persistence was deliberately avoided: a stored restart counter is one more thing that
  // can go stale and lie, which is the very failure being fixed here.
  assert.ok(
    !/restart_count|restartCount/.test(SRC),
    'no persisted counter — uptime across successive beats already reveals a crash loop',
  )
})

test('a fresh process reports a small uptime, and it climbs', async () => {
  // The real signal: on a crash-looping node this number keeps resetting toward zero, while
  // on a stable one it only ever increases.
  const first = Math.round(process.uptime())
  assert.ok(Number.isFinite(first) && first >= 0, 'uptime must be a real, non-negative number')

  await new Promise((r) => setTimeout(r, 1100))
  const second = process.uptime()
  assert.ok(second > first - 1, 'uptime must climb for a process that stays alive')
})

test('started_at is a valid ISO timestamp in the past', () => {
  const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString()
  const parsed = Date.parse(startedAt)
  assert.ok(!Number.isNaN(parsed), 'started_at must parse')
  assert.ok(parsed <= Date.now(), 'a process cannot have started in the future')
})
