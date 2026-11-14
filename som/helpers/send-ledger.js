'use strict'
// Report every SOM send to the server, without ever getting in the way of a send (#193485).
//
// The per-day ledger lived only on the Mac that sends, so no server or other machine could say how
// many went out today per account, how close the 40/day cap is, or the reply rate per campaign.
// Each send the local journal records is now also posted to fl-api POST /api/v1/som/send-events.
//
//   buildEvent   the journal outcome -> the server's event shape (null for a dry run or no lead)
//   report       queue it on disk, then try to flush in the background. Never throws, never awaited
//                by the send path: a network blip, a 404 (endpoint not deployed yet) or a 500 just
//                leaves the event queued for the next flush.
//   flush        post the queue in batches of 100. The server dedupes on client_event_id, so posting
//                an event twice (a flush that died after the POST) still counts it once.
//
// The local journal and ledger stay exactly as they were; this is a copy, not a replacement.

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const DEFAULT_QUEUE = path.join(os.homedir(), '.iris', 'data', 'som-send-events-queue.jsonl')
const MAX_BATCH = 100
const MAX_QUEUE = 5000 // oldest dropped past this: the queue is a buffer, not an archive
const MAX_AGE_MS = 14 * 24 * 3600 * 1000
const STALE_CLAIM_MS = 10 * 60 * 1000

// Journal outcomes (lead-outcome.js / dm-guard.js) -> server statuses. 'delivered-unknown' pressed
// send and may have arrived, so it spends the cap like a send; 'dry-run' never leaves the machine.
const STATUS = {
  sent: 'sent',
  'delivered-unknown': 'sent',
  failed: 'failed',
  undeliverable: 'undeliverable',
  skipped: 'skipped',
}

const queueFile = () => process.env.SOM_SEND_QUEUE || DEFAULT_QUEUE
const nodeId = () => process.env.IRIS_NODE_ID || os.hostname()

/**
 * Stable id for one send: the same campaign, lead, step, account and local ledger timestamp always
 * hash to the same id, so a retried report is counted once by the server.
 */
function clientEventId ({ campaign, leadId, step, account, at }) {
  const key = JSON.stringify([String(campaign || ''), Number(leadId) || 0, Number(step) || 0, String(account || '').toLowerCase().replace(/^@/, ''), String(at || '')])
  return 'som1-' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 40)
}

/** The event the server stores, or null when there is nothing to report. */
function buildEvent ({ campaign, campaignId, bloqId, leadId, step, channel, account, outcome, error, at, node }) {
  const status = STATUS[outcome]
  if (!status || !leadId || !campaign || !account || !bloqId) return null
  const sentAt = at || new Date().toISOString()
  const ev = {
    client_event_id: clientEventId({ campaign, leadId, step: step || 1, account, at: sentAt }),
    bloq_id: Number(bloqId),
    campaign: String(campaign),
    lead_id: Number(leadId),
    step: Number(step) || 1,
    channel: channel || 'instagram',
    account: String(account).replace(/^@/, ''),
    status,
    sent_at: sentAt,
    node_id: node || nodeId(),
  }
  if (campaignId) ev.campaign_id = Number(campaignId)
  if (error) ev.error = String(error).slice(0, 500)
  return ev
}

function readLines (file) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* a line cut short by a crash */ }
  }
  return out
}

function appendLines (file, events) {
  if (!events.length) return
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.appendFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 })
}

/** Append one event to the queue. Returns false instead of throwing. */
function enqueue (file, event) {
  if (!event) return false
  try {
    appendLines(file, [{ ...event, _queued_at: event._queued_at || new Date().toISOString() }])
    return true
  } catch { return false }
}

const strip = e => { const o = {}; for (const [k, v] of Object.entries(e)) if (!k.startsWith('_')) o[k] = v; return o }

/**
 * Take the queue for this flush by renaming it, so sends appended meanwhile go to a fresh file and
 * are never lost to a rewrite. A claim left by a flush that crashed is picked up after 10 minutes.
 */
function claim (file, now) {
  const dir = path.dirname(file)
  const base = path.basename(file)
  const events = []
  const claims = []
  let names = []
  try { names = fs.readdirSync(dir) } catch { return { events, claims } }
  for (const n of names) {
    if (!n.startsWith(base + '.flushing-')) continue
    const p = path.join(dir, n)
    try { if (now - fs.statSync(p).mtimeMs < STALE_CLAIM_MS) continue } catch { continue }
    events.push(...readLines(p)); claims.push(p)
  }
  if (fs.existsSync(file)) {
    const p = `${file}.flushing-${process.pid}-${now}`
    try { fs.renameSync(file, p); events.push(...readLines(p)); claims.push(p) } catch { /* another flush took it */ }
  }
  return { events, claims }
}

let inFlight = null
let again = null // a flush asked for while one runs: run once more after it, so nothing waits a whole run

/**
 * Post the queue. `post(events)` resolves to { ok, status } (LeadgenApiClient.postSendEvents).
 * Resolves to a tally; never rejects.
 */
function flush ({ file = queueFile(), post, now = Date.now(), log = () => {} } = {}) {
  if (inFlight) {
    again = { file, post, log }
    return inFlight.then(() => inFlight || { status: 'merged' })
  }
  inFlight = doFlush({ file, post, now, log }).catch(e => {
    log(`send ledger flush failed: ${e && e.message}`)
    return { posted: 0, duplicates: 0, kept: 0, dropped: 0, status: 'error' }
  }).finally(() => {
    inFlight = null
    if (again) { const next = again; again = null; flush(next) }
  })
  return inFlight
}

async function doFlush ({ file, post, now, log }) {
  const tally = { posted: 0, duplicates: 0, kept: 0, dropped: 0, status: 'empty' }
  if (typeof post !== 'function') { tally.status = 'no-poster'; return tally }
  const { events: claimed, claims } = claim(file, now)
  if (!claimed.length) { for (const c of claims) try { fs.unlinkSync(c) } catch {} return tally }

  // One copy per id, nothing older than 14 days, at most MAX_QUEUE (newest kept).
  const seen = new Set()
  let pending = []
  for (const e of claimed) {
    if (!e || !e.client_event_id || seen.has(e.client_event_id)) continue
    seen.add(e.client_event_id)
    const age = now - new Date(e._queued_at || e.sent_at || now).getTime()
    if (age > MAX_AGE_MS) { tally.dropped++; continue }
    pending.push(e)
  }
  if (pending.length > MAX_QUEUE) { tally.dropped += pending.length - MAX_QUEUE; pending = pending.slice(-MAX_QUEUE) }

  const keep = []
  let stopped = false
  for (let i = 0; i < pending.length; i += MAX_BATCH) {
    const batch = pending.slice(i, i + MAX_BATCH)
    if (stopped) { keep.push(...batch); continue }
    const r = await safePost(post, batch.map(strip))
    if (r.ok) {
      tally.posted += batch.length
      tally.duplicates += Number(r.duplicates) || 0
      continue
    }
    if (r.status === 422) {
      // One malformed event must not hold the rest hostage: post them one by one, drop only refusals.
      for (const e of batch) {
        const one = await safePost(post, [strip(e)])
        if (one.ok) tally.posted++
        else if (one.status === 422) { tally.dropped++; log(`send ledger dropped ${e.client_event_id}: refused as invalid`) }
        else keep.push(e)
      }
      continue
    }
    // 401/403/404 (not deployed yet)/429/5xx/network: keep everything for the next flush.
    tally.status = `kept (HTTP ${r.status || 'network'})`
    keep.push(...batch)
    stopped = true
  }

  try {
    appendLines(file, keep.map(e => ({ ...e, _attempts: (e._attempts || 0) + 1 })))
    for (const c of claims) try { fs.unlinkSync(c) } catch {}
  } catch (e) {
    log(`send ledger could not requeue: ${e.message}`) // the claim files stay and are retried later
  }
  tally.kept = keep.length
  if (tally.status === 'empty') tally.status = keep.length ? 'partial' : 'ok'
  return tally
}

async function safePost (post, events) {
  try {
    const r = await post(events)
    return r || { ok: false, status: 0 }
  } catch (e) {
    return { ok: false, status: 0, message: e && e.message }
  }
}

/**
 * Queue one event and flush in the background. Synchronous, never throws, returns whether it was
 * queued. The send path calls this and moves on; it never awaits the network.
 */
function report (event, { file = queueFile(), post, log = () => {} } = {}) {
  try {
    if (!event) return false
    const queued = enqueue(file, event)
    if (queued && typeof post === 'function') {
      flush({ file, post, log }).catch(() => {})
    }
    return queued
  } catch { return false }
}

/** Wait for a flush, but never longer than `ms`. For the end of a run. */
function flushWithin (ms, opts) {
  let timer
  const limit = new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'timeout' }), ms) })
  return Promise.race([flush(opts), limit]).finally(() => clearTimeout(timer))
}

module.exports = { DEFAULT_QUEUE, MAX_BATCH, STATUS, queueFile, clientEventId, buildEvent, enqueue, readLines, report, flush, flushWithin }
