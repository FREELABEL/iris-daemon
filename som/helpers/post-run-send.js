'use strict'
// `iris reachr post-run --send` (#192163): the pure half of som/post-run-send.spec.ts.
//
// What one send attempt turned into, what it costs against the daily cap, when a run must stop, and
// the ledger that outlives a crash. No browser here, so every rule is pinned by
// tests/post-run-send.test.js without logging into anything.

const fs = require('fs')
const os = require('os')
const path = require('path')

const DEFAULT_LEDGER_FILE = path.join(os.homedir(), '.iris', 'reachr', 'post-run-ledger.jsonl')
const DEFAULT_DAILY_CAP = 40 // same default as batch-with-login.spec.ts DAILY_DM_CAP
const MAX_CONSECUTIVE_MISSES = 3

// Instagram shows this in the thread AFTER the message is sent (#192164), so the message is on screen
// and the old "appeared in the thread" check calls it delivered.
const CANT_RECEIVE = /can.t receive your message|don.t allow new message requests/i
// The human check sends every page here. Profiles then show no buttons, which would otherwise read as
// "this person can't be messaged" for everyone after it.
const ACCOUNT_STOP_URL = /\/accounts\/(login|suspended)|\/challenge\//
const NOT_REACHABLE = /could not open DM view|no DM input|account not found/i
const NOT_CONFIRMED = /not confirmed/i

function normalizeHandle (h) {
  return String(h || '').trim().replace(/^@/, '').toLowerCase()
}

/**
 * One attempt → one outcome.
 *   sent          confirmed in the thread, and Instagram did not refuse it
 *   undeliverable nobody will read it: Instagram refused it, or no way to message them
 *   unconfirmed   typed and submitted, could not confirm; may well have arrived, so never retried
 *   failed        did not reach the person, and says nothing about them (session, crash)
 */
function classifySend (result, { url = '', pageText = '' } = {}) {
  const r = result || {}
  const error = String(r.error || '')
  if (ACCOUNT_STOP_URL.test(url)) return { outcome: 'failed', reason: 'session expired or Instagram asked for a human check', stop: true }
  if (/session expired|challenge/i.test(error)) return { outcome: 'failed', reason: error, stop: true }
  if (CANT_RECEIVE.test(pageText)) return { outcome: 'undeliverable', reason: "this account can't receive your message" }
  if (r.status === 'sent' && r.delivered) return { outcome: 'sent', reason: '' }
  if (NOT_REACHABLE.test(error)) return { outcome: 'undeliverable', reason: error }
  if (NOT_CONFIRMED.test(error)) return { outcome: 'unconfirmed', reason: error }
  return { outcome: 'failed', reason: error || 'unknown' }
}

/**
 * A confirmed send counts, and so does an unconfirmed one: it may be a real DM, and the cap protects
 * the account. A refused message and a failure do not (#191681, #192164).
 */
function countsTowardCap (outcome) {
  return outcome === 'sent' || outcome === 'unconfirmed'
}

/** What the lead's record should say. `sent` is logged through record-dm, which writes its own note. */
function noteFor (outcome, { account, handle, reason }) {
  const { undeliverableNote } = require('../lead-outcome')
  if (outcome === 'undeliverable') return undeliverableNote(account, handle, reason)
  if (outcome === 'unconfirmed' || outcome === 'failed') return `[SOM FAIL] DM to @${normalizeHandle(handle)} via @${account}: ${reason}`
  return null
}

/** Several misses in a row looks like a restriction, not a run of unlucky people. */
function shouldStopAfterMisses (outcomes, max = MAX_CONSECUTIVE_MISSES) {
  if (outcomes.length < max) return false
  return outcomes.slice(-max).every(o => o !== 'sent')
}

// ── The daily cap: the same file batch-with-login.spec.ts reads and writes, so both see each other ──

function capFile (somDir, account, now = new Date()) {
  return path.join(somDir, '../../test-results', `.dm-sent-${account}-${now.toISOString().slice(0, 10)}.json`)
}

function readCap (file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const leadIds = Array.isArray(raw.leadIds) ? raw.leadIds : []
    return { count: raw.count || leadIds.length, leadIds, updated: raw.updated || '' }
  } catch {
    return { count: 0, leadIds: [], updated: '' }
  }
}

function remainingToday (file, cap = DEFAULT_DAILY_CAP) {
  return Math.max(0, cap - readCap(file).count)
}

function recordCapSend (file, leadId) {
  const data = readCap(file)
  if (leadId && !data.leadIds.includes(leadId)) data.leadIds.push(leadId)
  data.count = data.leadIds.length || data.count + 1
  data.updated = new Date().toISOString()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data))
  return data
}

// ── The ledger: one line per attempt, written straight after it, so a crash forgets nobody ──

function appendLedger (file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 })
}

function readLedger (file) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* a line cut short by a crash */ }
  }
  return out
}

/** Handles that must not get another DM. Only a failure, which never reached them, may be retried. */
function blockedHandles (entries) {
  const out = new Set()
  for (const e of entries || []) if (e && e.outcome !== 'failed') out.add(normalizeHandle(e.handle))
  return out
}

/**
 * The list a person approved. The count they typed must match it exactly, and each row must carry the
 * exact message and the lead it is logged on.
 */
function validateApproved (items, confirmCount) {
  if (!Array.isArray(items) || !items.length) return 'the approved list is empty'
  if (Number(confirmCount) !== items.length) return `confirmed ${confirmCount} but the approved list has ${items.length}`
  for (const it of items) {
    if (!normalizeHandle(it && it.handle)) return 'a row has no handle'
    if (!(Number(it.leadId) > 0)) return `@${normalizeHandle(it.handle)} has no lead to log on`
    if (!String(it.message || '').trim()) return `@${normalizeHandle(it.handle)} has no message`
  }
  return null
}

module.exports = {
  DEFAULT_LEDGER_FILE,
  DEFAULT_DAILY_CAP,
  MAX_CONSECUTIVE_MISSES,
  normalizeHandle,
  classifySend,
  countsTowardCap,
  noteFor,
  shouldStopAfterMisses,
  capFile,
  readCap,
  remainingToday,
  recordCapSend,
  appendLedger,
  readLedger,
  blockedHandles,
  validateApproved,
}
