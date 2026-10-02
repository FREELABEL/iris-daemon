'use strict'

/**
 * The Hive task contract, node side (#187568, proposal #187471).
 *
 * The server owns "created once" (a unique key per account) and "never dispatched late". Two
 * rules only the machine can keep, because only the machine knows what it actually ran:
 *
 *   RAN ONCE   — a task whose key already completed here is answered with the stored result,
 *                not run again. A retry after a false failure (#187456) is exactly that case:
 *                the work ran, the report was wrong, and the swarm simulator measured 7–8
 *                commands running twice when retries had no key.
 *   NOT LATE   — a task is not started after its deadline by THIS machine's clock. The server
 *                checks its own clock at accept; a task that then waited here for a free slot
 *                can still go stale before it starts.
 *
 * Pure where it can be (no network, no daemon state), so the swarm simulator can load this
 * exact file instead of keeping its own copy of the rules (#187568 layer 4).
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

function deadlineMs (task) {
  const raw = task && task.not_after
  if (!raw) return null
  const t = Date.parse(raw)
  return Number.isFinite(t) ? t : null
}

function isPastDeadline (task, nowMs = Date.now()) {
  const d = deadlineMs(task)
  return d !== null && nowMs > d
}

/**
 * The server refuses an accept that arrives after the deadline with HTTP 409 and status
 * `expired`. That is not an error to report: the task is already expired on the server, and
 * reporting it "failed" would overwrite the truer status.
 */
function isExpiredRefusal (err) {
  const msg = (err && err.message) || ''
  return /HTTP 409/.test(msg) && /expired/i.test(msg)
}

/**
 * What to do with a task that just arrived. One decision, in one place:
 *   { action: 'expire' }            — past its deadline here; report expired, do not run
 *   { action: 'replay', entry }     — its key already completed here; send the stored result
 *   { action: 'skip', entry }       — its key is running here right now; do not start a twin
 *   { action: 'run' }
 */
function decide (task, ledger, nowMs = Date.now()) {
  if (isPastDeadline(task, nowMs)) return { action: 'expire' }
  const key = task && task.idempotency_key
  if (key && ledger) {
    const entry = ledger.get(key)
    if (entry && entry.state === 'done') return { action: 'replay', entry }
    if (entry && entry.state === 'running' && entry.task_id !== task.id) return { action: 'skip', entry }
  }
  return { action: 'run' }
}

/**
 * Keys this machine has run, kept on disk so a daemon restart does not forget them — a restart
 * is exactly when re-delivery happens. Only SUCCESSES are remembered as done: a failed key is
 * forgotten so its retry runs, which is the point of retrying.
 */
class KeyLedger {
  constructor ({ file, maxEntries = 5000, ttlMs = 7 * 24 * 3600 * 1000 } = {}) {
    this.file = file || path.join(os.homedir(), '.iris', 'daemon', 'task-keys.json')
    this.maxEntries = maxEntries
    this.ttlMs = ttlMs
    this.entries = {}
    this._load()
  }

  _load () {
    try {
      this.entries = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}
    } catch {
      this.entries = {}
    }
  }

  _save () {
    try {
      const now = Date.now()
      const kept = Object.entries(this.entries)
        .filter(([, e]) => e && now - (e.at || 0) < this.ttlMs)
        .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
        .slice(0, this.maxEntries)
      this.entries = Object.fromEntries(kept)
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.entries))
      fs.renameSync(tmp, this.file)
    } catch (e) {
      // Never break a task over bookkeeping — but say so, because a ledger that silently stops
      // saving is a ran-once guarantee that silently stopped holding.
      console.warn(`[contract] could not save key ledger ${this.file}: ${e.message}`)
    }
  }

  get (key) {
    const e = this.entries[key]
    if (!e) return null
    if (Date.now() - (e.at || 0) >= this.ttlMs) return null
    return e
  }

  begin (key, taskId) {
    if (!key) return
    this.entries[key] = { state: 'running', task_id: taskId, at: Date.now() }
    this._save()
  }

  finish (key, taskId, result) {
    if (!key) return
    const ok = result && (result.status === 'completed' || result.status === 'completed_with_warnings')
    if (ok) {
      this.entries[key] = { state: 'done', task_id: taskId, at: Date.now(), result: trimResult(result) }
    } else {
      delete this.entries[key]
    }
    this._save()
  }
}

// The stored result is replayed to the server, not re-read by a person: keep it bounded.
function trimResult (result) {
  const out = { status: result.status }
  for (const k of ['output', 'stdout', 'stderr', 'error']) {
    if (typeof result[k] === 'string') out[k] = result[k].slice(0, 20000)
  }
  if (result.data && typeof result.data === 'object') out.data = result.data
  if (result.metadata && typeof result.metadata === 'object') out.metadata = result.metadata
  return out
}

module.exports = { deadlineMs, isPastDeadline, isExpiredRefusal, decide, KeyLedger }
