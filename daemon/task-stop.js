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

module.exports = { ENDED_STATUSES, endedAtAccept, descendantPids, killTree, InflightLedger, reportInterrupted }
