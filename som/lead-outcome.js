// What happened to one lead in a SOM batch (#191681).
//
// The batch printed "✅ @handle" and recorded the lead as 'sent' at the end of every lead it got through
// without throwing, whether or not a DM went out. On 2026-10-28/29 @ballistic_shots_ (#30318) and
// @savvy_karan (#30315) showed "✅" after "✗ No Follow button either — cannot DM" and have no outbound
// message. Only a confirmed send is 'sent', and only 'sent' counts toward the daily DM cap.

function leadOutcome ({ sent = false, dryRunTyped = false, undeliverableReason = '' } = {}) {
  if (sent) return 'sent'
  if (dryRunTyped) return 'dry-run'
  if (undeliverableReason) return 'undeliverable'
  return 'failed'
}

function countsTowardDailyCap (outcome) {
  return outcome === 'sent'
}

// The leadTimings status the batch summary and Discord alert read ('sent' lists the top sent leads).
function timingStatus (outcome) {
  if (outcome === 'sent' || outcome === 'dry-run') return 'sent'
  if (outcome === 'undeliverable') return 'undeliverable'
  return 'fail'
}

function undeliverableNote (igAccount, handle, reason) {
  return `[SOM UNDELIVERABLE] cannot DM @${String(handle || '').replace(/^@/, '')} from @${igAccount}: ${reason}`
}

function outcomeLine (name, outcome, seconds, reason = '') {
  if (outcome === 'sent') return `✅ ${name} (${seconds}s)`
  if (outcome === 'dry-run') return `✅ ${name} [dry run, not sent] (${seconds}s)`
  if (outcome === 'undeliverable') return `🚫 ${name} undeliverable: ${reason} (${seconds}s)`
  return `❌ ${name} not sent (${seconds}s)`
}

module.exports = { leadOutcome, countsTowardDailyCap, timingStatus, undeliverableNote, outcomeLine }
