'use strict'

/**
 * portal-checkpoint.js — "resume at the record that failed" (#187919, GAP J).
 *
 * WHY THIS EXISTS. A portal pull walks 50 or 500 patient records through a slow, fragile web
 * portal. Before this, a crash at record 25 meant the retry started at record 1 again: 24 records
 * re-pulled (duplicate submissions on a portal that writes), an hour lost, and the same fragile
 * page hit twice as often. Hive's task-level idempotency (#187471) covers whole tasks; nothing
 * covered per-record progress. RTILA's best reliability feature is exactly this, so we copy it.
 *
 * THE SHAPE.
 *   - The checkpoint lives ON THE NODE (~/.iris/portal-runs/<run_key>/checkpoint.json, 0600), not
 *     in the task workspace — the workspace is per task id and a retry is a new task id.
 *   - It is keyed by a RUN KEY that is the same for the first attempt and every retry:
 *     config.run_key when the caller gives one, else a hash of the script + its record list.
 *   - Each record is identified by a HASH of its key (record.id / key / record_id, or the whole
 *     record). The checkpoint therefore holds no identifiers even on the node, and a retry with
 *     the list re-ordered still skips what was finished: idempotent per record, not per position.
 *   - A record is marked `started` before its work and `done` after, each write atomic
 *     (tmp + rename). A record left `started` by a crash is re-run — that is the record that
 *     failed — and the callback is told so (`ctx.resumed`) so a portal that writes can check
 *     before writing twice.
 *   - summary() is counts and INDEXES only. It is the one thing that may go to the server, even
 *     for a PHI task (#187918): "25 of 50 done, record 26 failed" says nothing about a patient.
 *
 * HOW A SCRIPT USES IT (custom_playwright / hive_script / user_script; the executor sets the env):
 *
 *   const { forEachRecord, loadRecords } = require(process.env.IRIS_PORTAL_LIB)
 *   await forEachRecord(loadRecords(), async (record, i, ctx) => { ... })
 *
 * Zero dependencies (CommonJS): it is required both by the daemon and by the robot's own process.
 */

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const PROGRESS_PREFIX = '@@iris-portal '
const MAX_FAILED_INDEXES = 100
const SUMMARY_INT_KEYS = ['total', 'done', 'failed', 'pending', 'skipped_done', 'next_index', 'resumed_from', 'attempt']

function runsDir () {
  return process.env.IRIS_PORTAL_RUNS_DIR || path.join(os.homedir(), '.iris', 'portal-runs')
}

function sha256 (s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex')
}

/** A run key safe as a directory name. Same input → same key, so a retry finds its checkpoint. */
function runKeyFor (task) {
  const cfg = (task && task.config) || {}
  const given = cfg.run_key || cfg.portal_run_key
  if (given && /^[A-Za-z0-9._-]{1,80}$/.test(String(given))) return String(given)
  if (given) return 'k-' + sha256(given).slice(0, 32)
  // No key given: the script and its inputs ARE the run. A changed script or a different record
  // list is a different run and starts fresh, which is the safe direction.
  const material = JSON.stringify([
    task && task.type,
    cfg.script_content || cfg.script_slug || (task && task.prompt) || '',
    cfg.records || null,
    cfg.records_file || null,
  ])
  return 'h-' + sha256(material).slice(0, 32)
}

/** Does this task run over records? Only then does it get a checkpoint. */
function isPortalRun (task) {
  const cfg = (task && task.config) || {}
  return Array.isArray(cfg.records) || typeof cfg.records_file === 'string' || cfg.portal_run === true
}

function defaultKeyOf (record, index) {
  if (record && typeof record === 'object') {
    for (const k of ['id', 'key', 'record_id']) {
      if (record[k] !== undefined && record[k] !== null && record[k] !== '') return `${k}:${record[k]}`
    }
    return 'json:' + JSON.stringify(record)
  }
  if (record === undefined || record === null) return `index:${index}`
  return 'value:' + String(record)
}

function emptyState (runKey) {
  return { version: 1, run_key: runKey, total: null, attempt: 0, records: {} }
}

function readState (file, runKey) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (s && typeof s === 'object' && s.records && typeof s.records === 'object') return s
  } catch { /* missing or torn: start empty — never guess that a record was done */ }
  return emptyState(runKey)
}

function writeState (file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
  fs.renameSync(tmp, file) // atomic: a kill mid-write leaves the previous checkpoint, not half of one
}

/** Counts and indexes only — the server-safe view (#187919: "no identifiers for PHI tasks"). */
function summarize (state) {
  const entries = Object.values(state.records || {})
  const total = Number.isInteger(state.total) ? state.total : entries.length
  const done = entries.filter(e => e.status === 'done').length
  const failedIdx = entries.filter(e => e.status === 'failed' || e.status === 'started')
    .map(e => e.index).filter(Number.isInteger).sort((a, b) => a - b)
  const doneIdx = new Set(entries.filter(e => e.status === 'done').map(e => e.index))
  let next = null
  for (let i = 0; i < total; i++) if (!doneIdx.has(i)) { next = i; break }
  return {
    total,
    done,
    failed: failedIdx.length,
    pending: Math.max(0, total - done),
    next_index: next,
    resumed_from: Number.isInteger(state.resumed_from) ? state.resumed_from : null,
    skipped_done: Number.isInteger(state.skipped_done) ? state.skipped_done : 0,
    attempt: Number.isInteger(state.attempt) ? state.attempt : 0,
    failed_indexes: failedIdx.slice(0, MAX_FAILED_INDEXES),
  }
}

/**
 * Re-validate a summary before it leaves the node: only the known integer keys and a bounded
 * integer list survive. Anything a script put there by mistake (a name, an MRN) is dropped.
 */
function safeSummary (s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null
  const out = {}
  for (const k of SUMMARY_INT_KEYS) {
    const v = s[k]
    out[k] = Number.isInteger(v) && v >= 0 ? v : null
  }
  out.failed_indexes = Array.isArray(s.failed_indexes)
    ? s.failed_indexes.filter(v => Number.isInteger(v) && v >= 0).slice(0, MAX_FAILED_INDEXES)
    : []
  return out
}

class PortalCheckpoint {
  constructor ({ file, runKey } = {}) {
    this.file = file || process.env.IRIS_PORTAL_CHECKPOINT
    if (!this.file) throw new Error('portal checkpoint: no checkpoint file (IRIS_PORTAL_CHECKPOINT unset)')
    this.runKey = runKey || process.env.IRIS_PORTAL_RUN_KEY || path.basename(path.dirname(this.file))
    this.state = readState(this.file, this.runKey)
  }

  static forTask (task, { dir = runsDir() } = {}) {
    const runKey = runKeyFor(task)
    return new PortalCheckpoint({ file: path.join(dir, runKey, 'checkpoint.json'), runKey })
  }

  hashOf (key) { return sha256(`${this.runKey}\u0000${key}`).slice(0, 40) }
  entry (key) { return this.state.records[this.hashOf(key)] || null }
  isDone (key) { const e = this.entry(key); return !!e && e.status === 'done' }

  mark (key, index, status) {
    const h = this.hashOf(key)
    const prev = this.state.records[h] || { attempts: 0 }
    this.state.records[h] = {
      index,
      status,
      attempts: prev.attempts + (status === 'started' ? 1 : 0),
      at: new Date().toISOString(),
    }
    writeState(this.file, this.state)
  }

  summary () { return summarize(this.state) }
}

function emitProgress (summary, out = process.stdout) {
  try { out.write(PROGRESS_PREFIX + JSON.stringify(safeSummary(summary)) + '\n') } catch { /* never fail a record on logging */ }
}

/**
 * Run fn over every record that is not already done, in order, checkpointing each one.
 *
 * stopOnError (default true): the first failure ends the run with a thrown error, and the next
 * attempt resumes AT that record. false: keep going, and the retry only re-runs the failures.
 * @returns {Promise<object>} summary()
 */
async function forEachRecord (records, fn, opts = {}) {
  if (!Array.isArray(records)) throw new Error('forEachRecord: records must be an array')
  const cp = opts.checkpoint || new PortalCheckpoint({ file: opts.file, runKey: opts.runKey })
  const keyOf = opts.keyOf || defaultKeyOf
  const stopOnError = opts.stopOnError !== false
  const progress = opts.onProgress || (s => emitProgress(s, opts.out))

  cp.state.total = records.length
  cp.state.attempt = (cp.state.attempt || 0) + 1
  cp.state.resumed_from = null
  cp.state.skipped_done = 0
  writeState(cp.file, cp.state)

  for (let i = 0; i < records.length; i++) {
    const key = keyOf(records[i], i)
    if (cp.isDone(key)) { cp.state.skipped_done++; continue }
    if (cp.state.resumed_from === null && cp.state.attempt > 1) cp.state.resumed_from = i
    const prev = cp.entry(key)
    cp.mark(key, i, 'started')
    try {
      await fn(records[i], i, { resumed: !!prev, attempts: cp.entry(key).attempts })
      cp.mark(key, i, 'done')
    } catch (err) {
      cp.mark(key, i, 'failed')
      progress(cp.summary())
      if (stopOnError) {
        // The message names the INDEX, never the record: a PHI task's error must not quote it.
        const e = new Error(`portal run stopped at record index ${i}`)
        e.cause = err
        e.portalIndex = i
        throw e
      }
      continue
    }
    progress(cp.summary())
  }
  const s = cp.summary()
  progress(s)
  return s
}

/** The records this run is over, written by the executor next to the task (IRIS_PORTAL_RECORDS). */
function loadRecords (file = process.env.IRIS_PORTAL_RECORDS) {
  if (!file) throw new Error('loadRecords: IRIS_PORTAL_RECORDS unset')
  const v = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(v)) throw new Error('loadRecords: records file is not a JSON array')
  return v
}

/**
 * Executor side: prepare the env a portal run's process needs, or null if the task is not one.
 * Records come from config.records (sample data) or config.records_file (a file ALREADY on this
 * node — the PHI case, where the list itself never travels through the cloud).
 */
function preparePortalRun (task, workspaceDir, { dir = runsDir() } = {}) {
  if (!isPortalRun(task)) return null
  const cp = PortalCheckpoint.forTask(task, { dir })
  const env = {
    IRIS_PORTAL_LIB: __filename,
    IRIS_PORTAL_CHECKPOINT: cp.file,
    IRIS_PORTAL_RUN_KEY: cp.runKey,
  }
  const cfg = task.config || {}
  if (Array.isArray(cfg.records)) {
    const recFile = path.join(workspaceDir, 'portal-records.json')
    fs.mkdirSync(workspaceDir, { recursive: true })
    fs.writeFileSync(recFile, JSON.stringify(cfg.records), { mode: 0o600 })
    env.IRIS_PORTAL_RECORDS = recFile
  } else if (typeof cfg.records_file === 'string') {
    env.IRIS_PORTAL_RECORDS = cfg.records_file
  }
  return { file: cp.file, runKey: cp.runKey, env }
}

/** Read a run's checkpoint from outside the robot (progress timer, final result). */
function readSummary (file) {
  if (!file || !fs.existsSync(file)) return null
  return summarize(readState(file, null))
}

module.exports = {
  PortalCheckpoint,
  forEachRecord,
  loadRecords,
  preparePortalRun,
  readSummary,
  safeSummary,
  runKeyFor,
  isPortalRun,
  defaultKeyOf,
  emitProgress,
  PROGRESS_PREFIX,
}
