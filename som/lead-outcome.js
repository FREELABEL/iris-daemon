// What happened to one lead in a SOM batch (#191681).
//
// The batch printed "✅ @handle" and recorded the lead as 'sent' at the end of every lead it got through
// without throwing, whether or not a DM went out. On 2026-10-28/29 @ballistic_shots_ (#30318) and
// @savvy_karan (#30315) showed "✅" after "✗ No Follow button either — cannot DM" and have no outbound
// message. Only a confirmed send is 'sent', and only 'sent' counts toward the daily DM cap.

//
// #192164: 'sent' now means the thread was read back after the send with no refusal in it. 'delivered-unknown'
// means it went out and we could not tell what happened: it may be a real DM, so it spends the cap and is never
// retried, but nothing records it as contact.
function leadOutcome ({ sent = false, dryRunTyped = false, undeliverableReason = '', deliveredUnknownReason = '' } = {}) {
  if (sent) return 'sent'
  if (dryRunTyped) return 'dry-run'
  if (deliveredUnknownReason) return 'delivered-unknown'
  if (undeliverableReason) return 'undeliverable'
  return 'failed'
}

function countsTowardDailyCap (outcome) {
  return outcome === 'sent' || outcome === 'delivered-unknown'
}

// The leadTimings status the batch summary and Discord alert read ('sent' lists the top sent leads).
function timingStatus (outcome) {
  if (outcome === 'sent' || outcome === 'dry-run') return 'sent'
  if (outcome === 'undeliverable' || outcome === 'delivered-unknown') return outcome
  return 'fail'
}

function undeliverableNote (igAccount, handle, reason) {
  return `[SOM UNDELIVERABLE] cannot DM @${String(handle || '').replace(/^@/, '')} from @${igAccount}: ${reason}`
}

function unconfirmedNote (igAccount, handle, reason) {
  return `[SOM UNCONFIRMED] DM to @${String(handle || '').replace(/^@/, '')} via @${igAccount}: ${reason}`
}

function outcomeLine (name, outcome, seconds, reason = '') {
  if (outcome === 'sent') return `✅ ${name} (${seconds}s)`
  if (outcome === 'dry-run') return `✅ ${name} [dry run, not sent] (${seconds}s)`
  if (outcome === 'undeliverable') return `🚫 ${name} undeliverable: ${reason} (${seconds}s)`
  if (outcome === 'delivered-unknown') return `❓ ${name} went out, delivery unknown: ${reason} (${seconds}s)`
  return `❌ ${name} not sent (${seconds}s)`
}

module.exports = { leadOutcome, countsTowardDailyCap, timingStatus, undeliverableNote, unconfirmedNote, outcomeLine }
