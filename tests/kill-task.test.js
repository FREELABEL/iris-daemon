// #188699: the platform times a task out (or a person cancels it) and the node keeps running it,
// because nothing ever told the node. The heartbeat response now names those tasks
// (cancel_task_ids) and the daemon stops each one with killTask.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { TaskExecutor } = require('../daemon/task-executor')

function executor () {
  const cloud = { reportProgress: async () => {}, submitResult: async () => {}, post: async () => ({}) }
  return new TaskExecutor(cloud, { create: () => ({}), cleanup: () => {} })
}

test('killTask stops a running child process and reports that it did', async () => {
  const ex = executor()
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'])
  ex.runningTasks.set('task-a', child)
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve(signal)))

  assert.strictEqual(ex.killTask('task-a', 'timed out'), true)
  assert.strictEqual(await exited, 'SIGTERM')
})

test('killTask on an id this node is not running is a no-op', () => {
  assert.strictEqual(executor().killTask('not-here'), false)
})

test('the heartbeat handler acts on cancel_task_ids', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'index.js'), 'utf-8')
  assert.match(src, /onHeartbeatOk = \(result\) =>/)
  assert.match(src, /result\?\.cancel_task_ids/)
  assert.match(src, /this\.executor\.killTask\(String\(id\)/)
})
