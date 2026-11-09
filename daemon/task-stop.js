'use strict'

/**
 * How a Hive task ENDS on this machine when something other than its own exit ends it —
 * a cancel, a daemon restart. Epic #191642 phase 0, measured 2026-10-28 between iris-hive-001
 * and iris-hive-002:
 *
 *  - #184886: `iris hive cancel` said "Task cancelled" and the job's marker file appeared on the
 *    node 25 s later. Killing only the direct child also left its children (a `sleep`) running.
 *  - #191560: `launchctl kickstart -k` killed a running task ("[executor] Killing task …") and the
 *    platform showed it "pending 1%" for 20+ minutes. The daemon exited without saying so.
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

/** Platform statuses that mean "this task is over — do not run it, stop it if running". */
const ENDED_STATUSES = new Set(['cancelled', 'failed', 'expired', 'completed', 'timeout'])

/**
 * The accept call refused the task because the platform already ended it — e.g. it was cancelled
 * while the push was in flight. Returns that status, or null.
 *
 * Needed because the dispatch path tolerates any accept error containing "422" as "already
 * running — proceed", so a task cancelled before it reached this machine still ran here.
 */
function endedAtAccept (err) {
  const msg = String((err && err.message) || '')
  if (!/\b422\b/.test(msg)) return null
  const m = /Task is in '([a-z_]+)' state/.exec(msg)
  return m && ENDED_STATUSES.has(m[1]) ? m[1] : null
}

/** Every descendant pid of `rootPid` (children, grandchildren, …), from one `ps` snapshot. */
function descendantPids (rootPid, { ps = defaultPs } = {}) {
  let rows
  try { rows = ps() } catch { return [] }
  const children = new Map()
  for (const line of rows.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (!pid || !Number.isFinite(ppid)) continue
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(pid)
  }
  const out = []
  const stack = [Number(rootPid)]
  const seen = new Set(stack)
  while (stack.length) {
    for (const c of children.get(stack.pop()) || []) {
      if (seen.has(c)) continue
      seen.add(c)
      out.push(c)
      stack.push(c)
    }
  }
  return out
}

function defaultPs () {
  return execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { encoding: 'utf8', timeout: 5000 })
}

function signalPid (pid, sig) {
  try { process.kill(pid, sig); return true } catch { return false }
}

/**
 * Stop a task's process AND everything it started. SIGTERM to the whole tree now, SIGKILL to
 * whatever of it is still alive after `graceMs`.
 *
 * The tree is read BEFORE anything is signalled: once the shell dies its children are re-parented
 * to init and can no longer be found from it. Not a process-group kill, on purpose — tasks are not
 * spawned detached, so they still die with the daemon's group when launchd/systemd stops it.
 */
function killTree (child, graceMs = 3000, { platform = process.platform, ps = defaultPs, exec = execFileSync } = {}) {
  if (!child || !child.pid) return []
  if (child.exitCode !== null && child.exitCode !== undefined) return []
  if (platform === 'win32') {
    try { exec('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000, stdio: 'ignore' }) } catch { /* already gone */ }
    return [child.pid]
  }
  const pids = [...descendantPids(child.pid, { ps }), child.pid]
  for (const pid of pids) signalPid(pid, 'SIGTERM')
  const t = setTimeout(() => { for (const pid of pids) signalPid(pid, 'SIGKILL') }, graceMs)
  if (typeof t.unref === 'function') t.unref()
  return pids
}

/**
 * A TIMED-OUT task ends with everything it started (#192109). On 2026-11-01 a hung `strace` and an
 * `iris serve` outlived their task's timeout: the timeout signalled only the direct child (or only
 * closed the tmux session, which a process ignoring SIGHUP survives), and what the task had started
 * ran on, re-parented to init where no walk from the task can find it any more.
 *
 * So, from ONE `ps` snapshot taken before anything is signalled:
 *   - every pid under the root (the walk — finds children that moved to a group of their own), and
 *   - every process GROUP those pids are in. A tmux pane leads its own group, so killing that group
 *     also reaches a child that was already orphaned before the timeout fired.
 * SIGTERM to all of it now; after `graceMs` SIGKILL to the same groups and pids, plus anything the
 * survivors started in the meantime. The daemon's own group, the daemon and its ancestors are never
 * signalled: a task spawned without `detached` shares the daemon's group, and there the walk alone
 * does the work.
 */
function killTaskTree (rootPid, graceMs = 5000, { platform = process.platform, ps = psWithGroups, kill = signal, self = process.pid, exec = execFileSync } = {}) {
  rootPid = Number(rootPid)
  if (!rootPid || rootPid === self) return { pids: [], groups: [] }
  if (platform === 'win32') {
    try { exec('taskkill', ['/PID', String(rootPid), '/T', '/F'], { timeout: 5000, stdio: 'ignore' }) } catch { /* already gone */ }
    return { pids: [rootPid], groups: [] }
  }
  const snapshot = () => { try { return processTable(ps()) } catch { return new Map() } }
  const table = snapshot()
  // The daemon, everything above it, and the groups they are in: never ours to kill.
  const spare = new Set()
  const spareGroups = new Set([0, 1])
  for (let pid = self; pid > 1 && !spare.has(pid); pid = table.get(pid)?.ppid ?? 0) {
    spare.add(pid)
    if (table.has(pid)) spareGroups.add(table.get(pid).pgid)
  }
  const pids = [rootPid, ...walk(table, rootPid)].filter(pid => !spare.has(pid))
  const groups = [...new Set(pids.map(pid => table.get(pid)?.pgid).filter(g => g && !spareGroups.has(g)))]

  for (const g of groups) kill(-g, 'SIGTERM')
  for (const pid of pids) kill(pid, 'SIGTERM')
  const t = setTimeout(() => {
    const now = snapshot()
    const late = pids.filter(pid => now.has(pid)).flatMap(pid => walk(now, pid)).filter(pid => !spare.has(pid))
    for (const g of groups) kill(-g, 'SIGKILL')
    for (const pid of new Set([...pids, ...late])) kill(pid, 'SIGKILL')
  }, graceMs)
  if (typeof t.unref === 'function') t.unref()
  return { pids, groups }
}

// `ps` columns pid ppid pgid, one process a line. Same flags on macOS and Linux.
function psWithGroups () {
  return execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid='], { encoding: 'utf8', timeout: 5000 })
}

function processTable (rows) {
  const table = new Map()
  for (const line of String(rows).split('\n')) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number)
    if (pid && Number.isFinite(ppid)) table.set(pid, { ppid, pgid: Number.isFinite(pgid) ? pgid : 0 })
  }
  return table
}

// Every pid below `root` in a process table.
function walk (table, root) {
  const children = new Map()
  for (const [pid, { ppid }] of table) {
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(pid)
  }
  const out = []
  const seen = new Set([root])
  const stack = [root]
  while (stack.length) {
    for (const c of children.get(stack.pop()) || []) {
      if (seen.has(c)) continue
      seen.add(c)
      out.push(c)
      stack.push(c)
    }
  }
  return out
}

function signal (pid, sig) {
  try { process.kill(pid, sig); return true } catch { return false }
}

/**
 * The tasks this daemon has started and not yet reported on, kept ON DISK (#191560).
 *
 * A daemon that is SIGKILLed, crashes or loses power cannot report on the way out. The next one
 * reads this file at startup and tells the platform those tasks were interrupted, so nobody waits
 * on work that died with the previous process.
 */
class InflightLedger {
  constructor (file = path.join(os.homedir(), '.iris', 'state', 'inflight-tasks.json')) {
    this.file = file
    this.ids = new Map() // taskId → started_at
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      for (const [id, at] of Object.entries(raw.tasks || {})) this.ids.set(id, at)
    } catch { /* none yet */ }
  }

  add (taskId) { this.ids.set(String(taskId), new Date().toISOString()); this._save() }
  remove (taskId) { if (this.ids.delete(String(taskId))) this._save() }
  list () { return [...this.ids.keys()] }
  clear () { this.ids.clear(); this._save() }

  _save () {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ tasks: Object.fromEntries(this.ids) }))
      fs.renameSync(tmp, this.file)
    } catch { /* a ledger that cannot be written must never stop a task */ }
  }
}

/**
 * Tell the platform these tasks were interrupted on this machine. Bounded by `timeoutMs` in
 * total, because it runs on the way out of a shutting-down process. Returns the ids reported.
 */
async function reportInterrupted (cloud, taskIds, reason, timeoutMs = 3000) {
  if (!taskIds.length) return []
  const done = []
  const all = Promise.all(taskIds.map(async (id) => {
    try {
      await cloud.submitResult(id, {
        status: 'failed',
        error: `Interrupted: ${reason}`,
        metadata: { interrupted: true, interrupted_reason: 'daemon_stopped' },
      })
      done.push(id)
    } catch { /* the platform's own orphan check still ends it */ }
  }))
  await Promise.race([all, new Promise((resolve) => { const t = setTimeout(resolve, timeoutMs); if (t.unref) t.unref() })])
  return done
}

module.exports = { ENDED_STATUSES, endedAtAccept, descendantPids, killTree, killTaskTree, processTable, InflightLedger, reportInterrupted }
