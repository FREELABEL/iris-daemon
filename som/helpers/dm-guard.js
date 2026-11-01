'use strict'
// Nobody wasted, nobody messaged twice (#192164).
//
//   journal   one line before pressing send, one after. A crash between them leaves an intent with no
//             outcome, which reads as "may have gone out" and is never re-sent. Also the source of the
//             per-campaign numbers. Ids and counts only: no handles, no message text.
//   dmGate    may we message this lead from this account, right now?
//   mark      an undeliverable lead keeps its place: dated, per account, with the routes still open.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { undeliverableNote } = require('../lead-outcome')

const DEFAULT_JOURNAL = path.join(os.homedir(), '.iris', 'data', 'som-dm-journal.jsonl')
const NO_ROUTE_COOLDOWN_MS = 14 * 24 * 3600 * 1000
const FAIL_COOLDOWN_MS = 6 * 3600 * 1000
const MAX_FAILED = 3
const TAG = { name: 'DM Undeliverable', color: '#b45309' }
const WENT_OUT = new Set(['sent', 'delivered-unknown', 'undeliverable'])

const journalFile = () => process.env.SOM_JOURNAL || DEFAULT_JOURNAL
const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase()
const noteText = n => String((n && (n.content || n.message)) || '')

// Throws when it cannot write. The intent is what makes a re-send impossible, so no journal, no send.
function append (file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.appendFileSync(file, JSON.stringify({ ...entry, at: entry.at || new Date().toISOString() }) + '\n', { mode: 0o600 })
}

function writeIntent (file, { leadId, account, campaign, boardId }) {
  append(file, { event: 'intent', lead_id: leadId, account, campaign, board_id: boardId })
}

function writeOutcome (file, { leadId, account, campaign, boardId, outcome, kind }) {
  append(file, { event: 'outcome', lead_id: leadId, account, campaign, board_id: boardId, outcome, ...(kind ? { kind } : {}) })
}

function readJournal (file) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* a line cut short by a crash */ }
  }
  return out
}

/** Accounts Instagram or the profile page turned this lead away from: { account: { kind, at } }. */
function undeliverableAccounts (lead, notes) {
  const out = {}
  const cf = (lead && lead.custom_fields && lead.custom_fields.dm_undeliverable) || {}
  for (const [acct, v] of Object.entries(cf)) out[acct.toLowerCase()] = { kind: (v && v.kind) || 'refused', at: v && v.at }
  for (const n of notes || []) {
    const m = noteText(n).match(/^\[SOM UNDELIVERABLE\] cannot DM @\S* from @(\S+?): (.*)$/s)
    if (!m) continue
    const acct = m[1].toLowerCase()
    const kind = /can.t receive/i.test(m[2]) ? 'refused' : 'no-route'
    if (!out[acct] || kind === 'refused') out[acct] = { kind, at: n.created_at }
  }
  return out
}

function dmGate ({ lead = {}, notes = [], messages = [], account, firstContact = true, journal = [], leadId, crossAccount = false, now = Date.now() }) {
  const block = (code, reason) => ({ allow: false, code, reason })
  if (messages === null) return block('history-unreadable', 'could not read what we have already sent')
  const here = String(account || '').toLowerCase()

  if (lead.has_replied || messages.some(m => m.direction === 'inbound')) return block('replied', 'they already replied')

  const mine = journal.filter(e => e.lead_id === leadId && eq(e.account, account))
  const lastEvent = mine[mine.length - 1]
  if (lastEvent && lastEvent.event === 'intent') return block('unresolved-send', 'an earlier run pressed send and never finished')
  if (mine.some(e => e.event === 'outcome' && WENT_OUT.has(e.outcome) && e.kind !== 'no-route')) return block('already-attempted', 'this account already sent to them')
  if (mine.filter(e => e.event === 'outcome' && e.outcome === 'failed').length >= MAX_FAILED) return block('failed-repeatedly', `failed ${MAX_FAILED} times from this account`)

  const turnedAway = undeliverableAccounts(lead, notes)
  const own = turnedAway[here]
  if (own && own.kind === 'refused') return block('undeliverable-this-account', 'Instagram refused it from this account')
  if (own && (!own.at || now - new Date(own.at).getTime() < NO_ROUTE_COOLDOWN_MS)) return block('undeliverable-cooldown', 'no way to message them last time')

  for (const n of notes) {
    const text = noteText(n)
    const fromHere = text.toLowerCase().includes(`via @${here}`)
    if (text.startsWith('[SOM UNCONFIRMED]') && fromHere) return block('unconfirmed', 'an earlier send may have arrived')
    if (text.startsWith('[SOM FAIL]') && fromHere) {
      if (/not confirmed/i.test(text)) return block('unconfirmed', 'an earlier send may have arrived')
      if (now - new Date(n.created_at).getTime() < FAIL_COOLDOWN_MS) return block('fail-cooldown', 'failed a few hours ago')
    }
  }

  const elsewhere = Object.entries(turnedAway).filter(([a, v]) => a !== here && v.kind === 'refused').map(([a]) => a)
  if (elsewhere.length && (!crossAccount || elsewhere.length > 1)) return block('undeliverable-other-account', 'refused from another account; retrying from another is off or already used')

  if (firstContact) {
    const counts = a => !elsewhere.includes(String(a || '').toLowerCase())
    if (messages.some(m => m.direction === 'outbound' && m.type === 'instagram_dm' && m.status !== 'archived' && counts(m.channel_account))) return block('reached', 'already messaged')
    for (const n of notes) {
      const m = noteText(n).match(/\[SOM DM\].*?via @([\w.]+)/s)
      if (noteText(n).includes('[SOM DM]') && (!m || counts(m[1]))) return block('reached', 'already messaged')
    }
  }
  return { allow: true, code: 'ok', reason: '' }
}

/** Created this run and nothing went out: put the lead back in the fresh pool. A refused lead stays out of it. */
function shouldReleaseSteps ({ createdSteps, submitted, kind, dryRun }) {
  return !!createdSteps && !submitted && kind !== 'refused' && !dryRun
}

function nextRoutes (lead, account, { crossAccount = false } = {}) {
  if (lead.has_replied) return []
  const email = lead.email || (lead.contact_info && lead.contact_info.email)
  return [...(email ? ['email'] : []), 'comment', ...(crossAccount ? ['other-account'] : [])]
}

/**
 * Note first (append-only, read by the gate), then the field and tag other routes filter on. custom_fields
 * merge on the server; tags replace, so existing ones are sent back. A failed note stops here so nothing half-applies.
 */
async function markUndeliverable (api, lead, { account, handle, reason, kind = 'refused', tagId, at, crossAccount = false }) {
  const noted = !!(await api.addNote(lead.id, undeliverableNote(account, handle, reason))).success
  if (!noted) return { noted, updated: false }
  const entry = { at: at || new Date().toISOString(), reason, kind, routes: nextRoutes(lead, account, { crossAccount }) }
  const existing = (lead.custom_fields && lead.custom_fields.dm_undeliverable) || {}
  const body = { custom_fields: { dm_undeliverable: { ...existing, [account]: entry } } }
  if (tagId) body.tags = [...new Set([...(lead.tags || []).map(t => (t && t.id) || t), tagId])]
  const updated = !!(await api.updateLead(lead.id, body)).success
  return { noted, updated }
}

function summarize (entries) {
  const rows = new Map()
  const row = e => {
    const date = String(e.at || '').slice(0, 10)
    const k = `${date}|${e.campaign}|${e.account}`
    if (!rows.has(k)) rows.set(k, { date, campaign: e.campaign, account: e.account, attempted: 0, sent: 0, undeliverable: 0, delivered_unknown: 0, failed: 0 })
    return rows.get(k)
  }
  const open = new Map()
  for (const e of entries) {
    const k = `${e.lead_id}|${e.account}`
    if (e.event === 'intent') { open.set(k, e); continue }
    if (e.event !== 'outcome') continue
    open.delete(k)
    const r = row(e)
    r.attempted++
    if (e.outcome === 'sent') r.sent++
    else if (e.outcome === 'undeliverable') r.undeliverable++
    else if (e.outcome === 'delivered-unknown') r.delivered_unknown++
    else r.failed++
  }
  for (const e of open.values()) { const r = row(e); r.attempted++; r.delivered_unknown++ }
  return [...rows.values()].map(r => {
    const out = r.attempted - r.failed
    return { ...r, delivery_rate: out > 0 ? Math.round((r.sent / out) * 1000) / 1000 : null }
  }).sort((a, b) => (a.date + a.campaign).localeCompare(b.date + b.campaign))
}

// `results.failed` includes undeliverable and unknown, so the batch's other counters keep their meaning.
function summaryLine ({ sent = 0, failed = 0, undeliverable = 0, deliveredUnknown = 0 }) {
  const out = sent + undeliverable + deliveredUnknown
  const rate = out > 0 ? `${Math.round((sent / out) * 100)}% (of ${out} that went out)` : 'n/a'
  return `Attempted: ${sent + failed}  |  Sent: ${sent}  |  Undeliverable: ${undeliverable}  |  Unknown: ${deliveredUnknown}  |  Failed: ${failed - undeliverable - deliveredUnknown}  |  Delivery rate: ${rate}`
}

module.exports = { DEFAULT_JOURNAL, TAG, journalFile, writeIntent, writeOutcome, readJournal, undeliverableAccounts, dmGate, shouldReleaseSteps, nextRoutes, markUndeliverable, summarize, summaryLine }
