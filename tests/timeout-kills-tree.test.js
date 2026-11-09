// See killTaskTree in daemon/task-stop.js. 2026-11-01: a hung `strace` and an `iris serve` outlived
// their task's timeout, because the timeout signalled the shell (or closed the tmux session) and
// nothing else. These start real processes and check, by pid, that nothing is left.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { killTaskTree } = require('../daemon/task-stop')

const posix = process.platform !== 'win32'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tree-kill-'))

async function readPid (file, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    const n = parseInt(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', 10)
    if (n > 0) return n
  }
  throw new Error(`no pid in ${file}`)
}

async function gone (pid, ms = 4000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (!alive(pid)) return true
  return !alive(pid)
}

test('the shell AND the child it started are gone', { skip: !posix }, async () => {
  const f = path.join(tmp(), 'pid')
  const parent = spawn('sh', ['-c', `sleep 300 & echo $! > ${f}; wait`], { stdio: 'ignore' })
  const child = await readPid(f)
  killTaskTree(parent.pid, 300)
  const ok = await gone(child)
  if (!ok) process.kill(child, 'SIGKILL')
  assert.ok(ok, `child ${child} survived`)
})

test('a child that ignores SIGTERM is SIGKILLed after the grace period', { skip: !posix }, async () => {
  const f = path.join(tmp(), 'pid')
  const parent = spawn('sh', ['-c', `sh -c 'trap "" TERM HUP; echo $$ > ${f}; while :; do sleep 1; done' & wait`], { stdio: 'ignore' })
  const child = await readPid(f)
  await sleep(200)
  killTaskTree(parent.pid, 300)
  const ok = await gone(child)
  if (!ok) process.kill(child, 'SIGKILL')
  assert.ok(ok, `child ${child} survived`)
})

test('a child already orphaned (re-parented to init) is reached through its process group', { skip: !posix }, async () => {
  // A tmux pane leads its own group. Its subshell exits and leaves `sleep` behind under init — no
  // walk from the pane finds it, but it is still in the pane's group.
  const f = path.join(tmp(), 'pid')
  const pane = spawn('sh', ['-c', `( sleep 300 & echo $! > ${f} ); sleep 300`], { stdio: 'ignore', detached: true })
  const orphan = await readPid(f)
  await sleep(200)
  killTaskTree(pane.pid, 300)
  const ok = await gone(orphan)
  if (!ok) process.kill(orphan, 'SIGKILL')
  assert.ok(ok, `orphan ${orphan} survived`)
})

test('never the daemon, its parents or its group', () => {
  // self=100 (group 100) under 50 under 1. The task 200 shares the daemon's group, as an undetached
  // child does; its child 201 leads group 201.
  const ps = () => ['1 0 1', '50 1 50', '100 50 100', '200 100 100', '201 200 201', '300 1 300'].join('\n')
  const sent = []
  const r = killTaskTree(200, 10, { platform: 'linux', ps, self: 100, kill: (pid, sig) => sent.push([pid, sig]) })
  assert.deepStrictEqual(r.pids.sort(), [200, 201])
  assert.deepStrictEqual(r.groups, [201])
  assert.ok(!sent.some(([p]) => [100, -100, 50, -50, 1, -1, 300, -300].includes(p)), JSON.stringify(sent))
  assert.deepStrictEqual(killTaskTree(100, 10, { platform: 'linux', ps, self: 100, kill: () => assert.fail('signalled itself') }), { pids: [], groups: [] })
})

test('end to end: a timed-out shell task leaves nothing running', { skip: !posix }, async () => {
  process.env.HOME = tmp()
  const { TaskExecutor } = require('../daemon/task-executor')
  const { WorkspaceManager } = require('../daemon/workspace-manager')
  const f = path.join(process.env.HOME, 'pid')
  const sent = []
  const cloud = { submitResult: async (id, body) => { sent.push(body) }, reportProgress: async () => {}, reportOutput: async () => {}, post: async () => ({}) }
  const ex = new TaskExecutor(cloud, new WorkspaceManager(path.join(process.env.HOME, 'data')))
  ex.tmux = { available: false, cleanup () {}, cleanupAll () {} }
  const quiet = ['log', 'warn', 'error'].map((k) => [k, console[k]])
  for (const [k] of quiet) console[k] = () => {}
  try {
    await ex.execute({ id: 'timeout-tree-0001', type: 'test_run', prompt: `sleep 300 & echo $! > ${f}; wait`, config: { timeout_seconds: 1 } })
  } finally { for (const [k, fn] of quiet) console[k] = fn }
  const child = await readPid(f)
  assert.match(JSON.stringify(sent.at(-1)), /timed out/i)
  const ok = await gone(child, 7000)
  if (!ok) process.kill(child, 'SIGKILL')
  assert.ok(ok, `the task's child ${child} outlived the timeout`)
})
