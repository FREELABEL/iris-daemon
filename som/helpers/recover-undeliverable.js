'use strict'
// Leads already burned by the "can't receive your message" banner (#192164): the pure half of
// recover-undeliverable.spec.ts. Reports by default; only --apply writes, and it deletes nothing.

const { dmGate, undeliverableAccounts, markUndeliverable } = require('./dm-guard')

const REASON = "this account can't receive your message"
const isOurDm = (m, account) => m.direction === 'outbound' && (!m.type || m.type === 'instagram_dm') && String(m.channel_account || '').toLowerCase() === String(account).toLowerCase() && m.status !== 'archived'

/** Threads → the leads worth checking. A thread with their message in it is left alone. */
function planRecovery (threads, leadByHandle) {
  const counts = { threads: threads.length, banner: 0, replied: 0, unmatched: 0, reclassify: 0, alreadyMarked: 0 }
  const toCheck = []
  for (const t of threads) {
    const meta = t.rawMetadata || {}
    if (!meta.cantReceive) continue
    counts.banner++
    if (meta.hasTheirMessage) { counts.replied++; continue }
    const lead = leadByHandle.get(String(t.username).toLowerCase())
    if (!lead) { counts.unmatched++; continue }
    toCheck.push({ leadId: lead.id, handle: t.username, at: meta.cantReceiveAt || null })
  }
  return { counts, toCheck }
}

function decide (lead, messages, account) {
  if (dmGate({ lead, messages: messages || [], notes: [], account, journal: [], leadId: lead.id, firstContact: false }).code === 'replied') return 'replied'
  if (undeliverableAccounts(lead, lead.notes || [])[String(account).toLowerCase()]?.kind === 'refused') return 'already-marked'
  return 'reclassify'
}

/**
 * Note and mark the lead, archive this account's message so nothing reads it as contact, and reopen the
 * completed steps when no other account's message stands. The note goes first: if it fails, nothing else runs.
 */
async function applyRecovery (api, lead, messages, { account, handle, at, tagId, crossAccount }) {
  const res = { noted: false, archived: 0, reopened: 0 }
  const probe = await markWithNote(api, lead, { account, handle, at, tagId, crossAccount })
  if (!probe) return res
  res.noted = true
  const ours = messages.filter(m => isOurDm(m, account))
  for (const m of ours) {
    if ((await api.updateMessage(lead.id, m.id, m.message, 'archived')).success) res.archived++
  }
  const othersStand = messages.some(m => m.direction === 'outbound' && m.status !== 'archived' && !isOurDm(m, account))
  if (!othersStand && res.archived === ours.length) {
    for (const s of await api.getSteps(lead.id)) {
      if (s.is_completed && (await api.reopenStep(lead.id, s.id)).success) res.reopened++
    }
  }
  return res
}

async function markWithNote (api, lead, opts) {
  const r = await markUndeliverable(api, lead, { ...opts, reason: REASON, kind: 'refused' })
  return r.noted
}

function report ({ account, apply, counts, applied }) {
  return { account, mode: apply ? 'apply' : 'dry-run', ...counts, ...(applied ? { applied } : {}) }
}

function parseApply (argv) {
  return argv.includes('--apply')
}

module.exports = { REASON, planRecovery, decide, applyRecovery, report, parseApply }
