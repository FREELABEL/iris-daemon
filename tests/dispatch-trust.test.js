// Hive dispatch you can trust (epic #191642, phase 0) — the node side. Each test reproduces a defect
// measured on 2026-10-28 between iris-hive-001 and iris-hive-002, on the code as it was.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { Daemon } = require('../daemon/index.js')
const { TaskExecutor } = require('../daemon/task-executor')

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function bareDaemon ({ fetchTask, acceptTask } = {}) {
  const d = Object.create(Daemon.prototype)
  d.recentlySeenTasks = new Map()
  d.recentlyRejectedTasks = new Map()
  d.pendingTaskIds = new Set()
  d.nodeId = 'node-1'
  d.keyLedger = { begin () {}, finish () {} }
  d._keyByTask = new Map()
  d.started = []
  d.results = []
  d.executor = {
    runningTasks: new Map(),
    gate: { visibleIds: () => [], isQueued: () => false },
    killTask: () => false,
    execute: async (task) => { d.started.push(task.id); await sleep(30) },
  }
  d.cloud = {
    acceptTask: acceptTask || (async () => ({})),
    // Two round trips (fetch, accept) before the task reaches the executor — where the race was.
    fetchTask: fetchTask || (async (id) => { await sleep(20); return { id, type: 'sandbox_execute', node_id: 'node-1', status: 'dispatched' } }),
    submitResult: async (id, r) => { d.results.push([id, r]) },
  }
  return d
}

describe('#191558 — one limit, enforced atomically', () => {
  it('runs at most MAX_CONCURRENT of 8 deliveries that arrive together', async () => {
    process.env.MAX_CONCURRENT = '3'
    const d = bareDaemon()
    let peak = 0
    d.executor.execute = async (task) => {
      d.executor.runningTasks.set(task.id, {})
      peak = Math.max(peak, d.executor.runningTasks.size)
      d.started.push(task.id)
      await sleep(50)
      d.executor.runningTasks.delete(task.id)
    }
    await Promise.all(Array.from({ length: 8 }, (_, i) => d.handleTaskDispatched({ task_id: `t${i}`, title: 'sleep' })))
    assert.equal(d.started.length, 3, `started ${d.started.length} of 8 on a 3-slot node`)
    assert.ok(peak <= 3, `peak ${peak} running at once`)
    assert.equal(d.results.filter(([, r]) => r.status === 'failed').length, 0, 'deferred deliveries must not be failed')
  })

  it('startup log, heartbeat and gate read the same number', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'index.js'), 'utf8')
    assert.equal(/MAX_CONCURRENT \|\| 4\b/.test(src), false, 'the startup log still prints a default of 4')
    assert.match(src, /Max concurrent: \$\{this\._maxConcurrent\(\)\}/)
  })
})

describe('#184886 — cancel reaches the process on the node', () => {
  it('kills the whole process tree, so a job\'s children cannot finish its work', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-'))
    const marker = path.join(dir, 'marker')
    // The shape of the stress-test job: a shell whose child sleeps, then writes a marker.
    const child = spawn('/bin/bash', ['-c', `(sleep 2; echo ran > ${marker}) & wait`], { stdio: 'ignore' })
    await sleep(300)
    const ex = new TaskExecutor({ reportProgress: async () => {}, submitResult: async () => {}, post: async () => ({}) }, { create: () => ({}), cleanup: () => {} })
    ex.runningTasks.set('task-c', child)

    assert.equal(ex.killTask('task-c', 'cancelled'), true)
    await sleep(2600)
    assert.equal(fs.existsSync(marker), false, 'the cancelled job still wrote its marker')
  })

  it('stops a task when the platform pushes task.cancelled — after re-reading its status', async () => {
    const killed = []
    const d = bareDaemon({ fetchTask: async (id) => ({ id, status: 'cancelled' }) })
    d.executor.runningTasks.set('t-run', {})
    d.executor.killTask = (id) => { killed.push(id); return true }
    assert.equal(typeof d.handleTaskCancelled, 'function', 'the daemon has no handler for task.cancelled')
    assert.equal(await d.handleTaskCancelled({ task_id: 't-run' }), true)
    assert.deepEqual(killed, ['t-run'])
  })

  it('ignores a cancel push the platform does not confirm', async () => {
    const killed = []
    const d = bareDaemon({ fetchTask: async (id) => ({ id, status: 'running' }) })
    d.executor.runningTasks.set('t-run', {})
    d.executor.killTask = (id) => { killed.push(id); return true }
    assert.equal(await d.handleTaskCancelled({ task_id: 't-run' }), false)
    assert.deepEqual(killed, [])
  })

  it('does not run a task the platform cancelled before this machine accepted it', async () => {
    const d = bareDaemon({
      acceptTask: async () => { throw Object.assign(new Error('HTTP 422: {"error":"Cannot accept task","message":"Task is in \'cancelled\' state"}'), { statusCode: 422 }) },
    })
    await d.handleTaskDispatched({ task_id: 't-late', title: 'sleep' })
    assert.deepEqual(d.started, [], 'a cancelled task was started because accept\'s 422 reads as "proceed"')
  })

  it('the pusher client delivers task.cancelled', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'pusher-client.js'), 'utf8')
    assert.match(src, /bind\('task\.cancelled'/)
    const idx = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'index.js'), 'utf8')
    assert.match(idx, /onTaskCancelled\(\(event\) => this\.handleTaskCancelled\(event\)/)
  })
})

describe('#191560 — a task killed by a daemon restart ends', () => {
  it('reports the tasks it kills on shutdown as interrupted', async () => {
    const d = Object.create(Daemon.prototype)
    d.nodeName = 'iris-hive-002'
    const reported = []
    d.cloud = { submitResult: async (id, r) => { reported.push([id, r]) }, markOffline: async () => ({}) }
    d.executor = { runningTasks: new Map([['t-1', {}]]), killAll () { this.runningTasks.clear() } }
    const exit = process.exit
    process.exit = () => {}
    const write = fs.writeFileSync
    fs.writeFileSync = (f, ...rest) => (String(f).endsWith('status.json') ? undefined : write(f, ...rest))
    try { await d.shutdown('SIGTERM') } finally { process.exit = exit; fs.writeFileSync = write }
    assert.equal(reported.length, 1, 'the killed task was never reported')
    assert.equal(reported[0][0], 't-1')
    assert.equal(reported[0][1].status, 'failed')
    assert.match(reported[0][1].error, /Interrupted/)
    assert.match(reported[0][1].error, /SIGTERM/)
  })

  it('a restarted daemon reports what the previous process left running', async () => {
    const { InflightLedger, reportInterrupted } = require('../daemon/task-stop')
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inflight-')), 'inflight.json')
    const before = new InflightLedger(file)
    before.add('t-killed')                              // the process then dies with SIGKILL
    const after = new InflightLedger(file)              // the next daemon
    assert.deepEqual(after.list(), ['t-killed'])
    const sent = []
    const done = await reportInterrupted({ submitResult: async (id, r) => { sent.push([id, r.status]) } }, after.list(), 'restarted')
    assert.deepEqual(sent, [['t-killed', 'failed']])
    assert.deepEqual(done, ['t-killed'])
  })

  it('records a task before it runs and forgets it once its result is sent', async () => {
    const d = bareDaemon()
    const seen = []
    d.inflight = { add: (id) => seen.push(['add', id]), remove: (id) => seen.push(['remove', id]), list: () => [] }
    await d.handleTaskDispatched({ task_id: 't-l', title: 'x' })
    assert.deepEqual(seen[0], ['add', 't-l'], 'a started task is not on the on-disk ledger')
  })
})

describe('#191560 — a killed task says why it ended', () => {
  it('a task killed by shutdown reports "Interrupted: …", not "Process exited with code null"', async () => {
    const sent = []
    const ex = new TaskExecutor({ reportProgress: async () => {}, submitResult: async (id, r) => { sent.push(r) }, post: async () => ({}) }, { create: () => ({ dir: os.tmpdir(), projectDir: os.tmpdir() }), get: () => null, cleanup: () => {} })
    ex.killAll('the IRIS daemon on n was stopped (SIGTERM) while this task ran; it did not finish')
    assert.equal(ex._stopReason, 'the IRIS daemon on n was stopped (SIGTERM) while this task ran; it did not finish')
    const src = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'task-executor.js'), 'utf8')
    assert.match(src, /error: stopReason \? `Interrupted: \$\{stopReason\}` : err\.message/)
  })
})
