const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { Daemon } = require('../daemon/index.js')
const { Heartbeat } = require('../daemon/heartbeat.js')

/**
 * "A promise the code does not keep is worse than no promise."
 *
 * A full node used to report the task FAILED — "Node at capacity … Will retry on next schedule" —
 * and refuse its id for 5 minutes. Nothing retried it: the server marks a failed task failed for good.
 * Now a full node leaves the task dispatched, and picks it up itself at the first heartbeat with a
 * free slot (the pending poll, #187457).
 */
function fullDaemon (running = 3) {
  const d = Object.create(Daemon.prototype)
  d.recentlySeenTasks = new Map()
  d.recentlyRejectedTasks = new Map()
  d.pendingTaskIds = new Set()
  d.executor = { runningTasks: new Map(Array.from({ length: running }, (_, i) => [`busy-${i}`, {}])) }
  d.calls = []
  d.cloud = { submitResult: async (id, r) => { d.calls.push([id, r]) } }
  return d
}

describe('a node at capacity', () => {
  it('does not report the task failed', async () => {
    process.env.MAX_CONCURRENT = '3'
    const d = fullDaemon(3)
    await d.handleTaskDispatched({ task_id: 'task-1', title: 'echo' })
    assert.equal(d.calls.filter(([, r]) => r.status === 'failed').length, 0, 'a full node reported the task failed')
  })

  it('does not blacklist the id, and lets the next delivery through at once', async () => {
    process.env.MAX_CONCURRENT = '3'
    const d = fullDaemon(3)
    await d.handleTaskDispatched({ task_id: 'task-2', title: 'echo' })
    assert.equal(d.recentlyRejectedTasks.has('task-2'), false, 'the id was refused for 5 minutes')
    assert.equal(d.recentlySeenTasks.has('task-2'), false, 'a re-delivery within 60 s would be dropped as a duplicate')
    assert.equal(d.pendingTaskIds.has('task-2'), false)
  })
})

describe('one number for capacity', () => {
  it('the slots the daemon enforces and the slots it reports are the same setting', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'index.js'), 'utf8')
    assert.equal(/MAX_CONCURRENT \|\| '4'/.test(src), false, 'the capacity check still defaults to 4 while the heartbeat reports 3')
    delete process.env.MAX_CONCURRENT
    assert.equal(Object.create(Daemon.prototype)._maxConcurrent(), 3)
  })
})

describe('the heartbeat tells the daemon it succeeded', () => {
  it('calls onHeartbeatOk with the reply after a successful ping', async () => {
    const hb = new Heartbeat({ sendHeartbeat: async () => ({ ok: true, dispatched_count: 0 }) }, 30000)
    let got = null
    hb.onHeartbeatOk = (r) => { got = r }
    await hb.ping()
    assert.deepEqual(got, { ok: true, dispatched_count: 0 })
  })

  it('the daemon wires it to the pending poll', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'index.js'), 'utf8')
    assert.match(src, /onHeartbeatOk\s*=/)
    assert.match(src, /shouldPollPending\(/)
  })
})
