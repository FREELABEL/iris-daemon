'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// AdmissionGate — the single source of local admission control for the daemon.
//
// It enforces exactly TWO rules and nothing else:
//   1. Idempotency      — never run the same task id twice concurrently.
//   2. Resource exclusion — never let two tasks fight over the same real resource
//                           (a logged-in browser session, or the machine's Chromium
//                           RAM ceiling).
//
// The defining property: "is resource X busy?" is DERIVED FROM LIVE TRUTH on every
// call — the executor's runningTasks Map reconciled against the OS (tmux sessions).
// A holder whose process/tmux session is dead is NOT counted, so a leaked lock is
// structurally impossible: there is no boolean to get stuck, no reaper, no TTL.
//
// This replaces the prior spaghetti: _runningTasks (array), _browserRunning (bool),
// _browserQueue, _executedTaskIds, two divergent per-type singleton checks, and the
// recentlyRejected TTL map — all of which were hand-maintained caches of intent that
// could (and did) drift from reality and wedge the node.
// ─────────────────────────────────────────────────────────────────────────────

// Task types that drive a real Chromium browser. Kept in sync with
// TaskExecutor.BROWSER_TYPES — these consume the machine-wide 'browser' slot(s).
const BROWSER_TYPES = ['som_batch', 'som', 'inbox_scan', 'enrich_batch', 'venue_enrich', 'custom_playwright', 'discover']

// Task types that must not run two-at-once on this node. Each maps to an exclusive
// resource key below; for types with a known shared login that key models the real
// resource (e.g. discover → the one YouTube session), otherwise a generic
// singleton:<type> key preserves the historical one-at-a-time guarantee.
const SINGLETON_TYPES = ['som_batch', 'som', 'som_swarm', 'discover', 'enrich_batch', 'inbox_scan', 'comms_sync', 'clip_cutter', 'venue_enrich']

class AdmissionGate {
  /**
   * @param {object}  opts
   * @param {Map}     opts.runningTasks    executor.runningTasks (taskId → entry). Entries
   *                                        carry `_resourceKeys` (stamped at set time) and,
   *                                        for tmux tasks, `{ tmux:true, sessionName }`.
   * @param {object}  opts.tmux            tmux manager exposing isAlive(sessionName).
   * @param {number} [opts.browserCapacity=1]  max concurrent Chromium (RAM ceiling). 1 ⇒
   *                                        behaviour-identical to the old max-1 browser gate.
   * @param {number} [opts.queueLimit=3]   max tasks held in the local visible queue.
   */
  constructor ({ runningTasks, tmux, browserCapacity = 1, queueLimit = 3 }) {
    this.runningTasks = runningTasks
    this.tmux = tmux
    this.browserCapacity = Math.max(1, browserCapacity)
    this.queueLimit = Math.max(0, queueLimit)
    this._reservations = new Map() // taskId → keys[]  (admitted, not yet in runningTasks)
    this._queue = []               // [{ task, keys }] (waiting for a free resource)
  }

  // ── Resource keys: the REAL constrained resources a task needs to hold ──
  // 'browser'         — capacity-counted (the machine Chromium ceiling).
  // 'session:youtube' — exclusive: the one logged-in YouTube session.
  // 'session:ig:<a>'  — exclusive: a specific Instagram account's session.
  // 'session:ig:*'    — exclusive wildcard: unknown IG account ⇒ serialize all IG (safe).
  // 'singleton:<t>'   — exclusive: preserves one-at-a-time for types without a modelled login.
  resourceKeys (task) {
    const keys = []
    const type = task.type
    if (BROWSER_TYPES.includes(type)) keys.push('browser')

    switch (type) {
      case 'discover':
        keys.push('session:youtube')
        break
      case 'som_batch':
      case 'som':
      case 'inbox_scan':
      case 'enrich_batch': {
        const accts = this._resolveIgAccounts(task)
        if (accts.length) for (const a of accts) keys.push(`session:ig:${a}`)
        else keys.push('session:ig:*') // unknown account → conservatively serialize all IG
        break
      }
      default:
        if (SINGLETON_TYPES.includes(type)) keys.push(`singleton:${type}`)
    }

    // custom_playwright: one run per requirement at a time (was a separate dedup gate).
    const reqId = task.config && task.config.requirement_id
    if (type === 'custom_playwright' && reqId) keys.push(`req:${reqId}`)

    return keys
  }

  // Best-effort SYNCHRONOUS Instagram account resolution from task config/prompt.
  // Step 5 may make this authoritative; until then an unresolved account falls back
  // to the 'session:ig:*' wildcard (serialize), never a guess that could collide.
  _resolveIgAccounts (task) {
    const cfg = task.config || {}
    const direct = cfg.igAccount || cfg.ig_account || cfg.ig
    if (direct) return [String(direct).replace(/^@/, '')]
    const m = /(?:^|\s)ig=([^\s]+)/.exec(task.prompt || '')
    if (m && m[1]) return [m[1].replace(/^@/, '')]
    return []
  }

  // ── Live holders, derived from truth on every call ──
  // Returns Map<resourceKey, Set<taskId>>. The reservation map is the single record of
  // "task → keys it holds" (set at admit, cleared only in the one finally release). A
  // reserved task is counted UNLESS it has a runningTasks entry whose tmux session is
  // dead — that's the reconciliation that auto-frees a leaked lock (no boolean, no reaper).
  _liveHolders () {
    const holders = new Map()
    const add = (key, id) => {
      let s = holders.get(key)
      if (!s) { s = new Set(); holders.set(key, s) }
      s.add(id)
    }
    for (const [taskId, keys] of this._reservations) {
      const entry = this.runningTasks.get(taskId)
      if (entry && this._isDeadTmux(entry)) continue // dead process → not a holder
      for (const k of keys) add(k, taskId)
    }
    return holders
  }

  _isDeadTmux (entry) {
    return !!(entry && entry.tmux && entry.sessionName &&
      this.tmux && typeof this.tmux.isAlive === 'function' && !this.tmux.isAlive(entry.sessionName))
  }

  // Is this task id currently live (holds a reservation whose process isn't dead)?
  isLive (taskId) {
    if (!this._reservations.has(taskId)) return false
    const entry = this.runningTasks.get(taskId)
    return !(entry && this._isDeadTmux(entry))
  }

  isQueued (taskId) {
    return this._queue.some(i => i.task.id === taskId)
  }

  queuedCount () {
    return this._queue.length
  }

  // Can a task holding `keys` start right now, given live holders? Pure, side-effect free.
  // `excludeId` ignores a specific holder (used when re-checking a task against itself).
  canStart (keys, excludeId = null) {
    if (!keys.length) return { ok: true }
    const holders = this._liveHolders()
    const sizeExcluding = (set) => {
      if (!set) return 0
      if (excludeId && set.has(excludeId)) return set.size - 1
      return set.size
    }

    for (const k of keys) {
      if (k === 'browser') {
        if (sizeExcluding(holders.get('browser')) >= this.browserCapacity) {
          return { ok: false, reason: 'browser-capacity' }
        }
        continue
      }
      // Exclusive session/singleton keys: blocked if anyone else holds the same key.
      if (sizeExcluding(holders.get(k)) > 0) return { ok: false, reason: 'busy', key: k }

      // IG wildcard exclusivity: a concrete ig key conflicts with the wildcard and
      // vice-versa, so an unknown-account batch never overlaps a known one.
      if (k === 'session:ig:*') {
        for (const [hk, hs] of holders) {
          if (hk.startsWith('session:ig:') && sizeExcluding(hs) > 0) return { ok: false, reason: 'busy', key: hk }
        }
      } else if (k.startsWith('session:ig:')) {
        if (sizeExcluding(holders.get('session:ig:*')) > 0) return { ok: false, reason: 'busy', key: 'session:ig:*' }
      }
    }
    return { ok: true }
  }

  // ── Admission decision for a freshly-arrived task ──
  // Returns one of:
  //   { verdict: 'run',  keys }           — reserved; caller must execute it now.
  //   { verdict: 'queue', keys }          — held in the visible queue; will drain later.
  //   { verdict: 'duplicate' }            — already live or queued; drop silently.
  //   { verdict: 'reject', reason }       — queue full; caller fails it (server re-dispatches).
  admit (task) {
    const taskId = task.id
    if (this.isLive(taskId) || this.isQueued(taskId)) return { verdict: 'duplicate' }

    const keys = this.resourceKeys(task)
    if (this.canStart(keys).ok) {
      this._reservations.set(taskId, keys)
      return { verdict: 'run', keys }
    }
    if (this._queue.length >= this.queueLimit) return { verdict: 'reject', reason: 'queue-full' }
    this._queue.push({ task, keys })
    return { verdict: 'queue', keys }
  }

  // Keys reserved for a task (set by admit('run') or drain). Lets the executor run a
  // drained task WITHOUT re-entering admit() (which would see its own reservation).
  reservedKeys (taskId) {
    return this._reservations.get(taskId) || null
  }

  // Release a task's hold (the ONE finally). Idempotent.
  release (taskId) {
    this._reservations.delete(taskId)
  }

  // After a release, dequeue every queued task whose resources are now free, in FIFO
  // order, reserving each as we go (so the next canStart accounts for it). Returns the
  // task objects the caller should execute (with reservedKeys already set).
  drain () {
    if (!this._queue.length) return []
    const ready = []
    const remaining = []
    for (const item of this._queue) {
      if (this.canStart(item.keys).ok) {
        this._reservations.set(item.task.id, item.keys)
        ready.push(item.task)
      } else {
        remaining.push(item)
      }
    }
    this._queue = remaining
    return ready
  }

  // Every task id the node is responsible for (running ∪ reserved ∪ queued) — so the
  // heartbeat reports queued tasks and the server doesn't orphan or double-dispatch them.
  visibleIds () {
    const ids = new Set()
    for (const id of this.runningTasks.keys()) ids.add(id)
    for (const id of this._reservations.keys()) ids.add(id)
    for (const { task } of this._queue) ids.add(task.id)
    return [...ids]
  }

  // Lightweight snapshot for /queue + /health observability.
  snapshot () {
    return {
      browserCapacity: this.browserCapacity,
      running: [...this.runningTasks.keys()],
      reserved: [...this._reservations.keys()],
      queued: this._queue.map(i => ({ id: i.task.id, type: i.task.type, keys: i.keys })),
      holders: Object.fromEntries([...this._liveHolders()].map(([k, s]) => [k, [...s]]))
    }
  }
}

module.exports = { AdmissionGate, BROWSER_TYPES, SINGLETON_TYPES }
