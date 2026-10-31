/**
 * Record a one-off reply to someone already talking to us (#191637).
 *
 * A reply is not a campaign step: it is recorded as kind=reply, tied to the message it answers,
 * and labelled by account. The DM has already gone out by the time this runs, so if the server
 * refuses the link (422: nothing stored) it is recorded as a plain message instead. Any other
 * failure may have stored the reply already, so it is reported, never retried.
 */

/** The label a reply is logged under: the account it went from, never a campaign's name. */
function replyCampaign(account, override) {
  return override || `reply:${account}`;
}

async function recordReply(api, leadId, base) {
  let rec = await api.recordDmSent(leadId, { ...base, kind: 'reply' });
  if (rec.success) return { rec, recordedAs: 'reply' };
  if (rec.status !== 422) return { rec, recordedAs: 'not recorded (check the lead)' };
  rec = await api.recordDmSent(leadId, base);
  return { rec, recordedAs: 'message (reply link refused)' };
}

module.exports = { recordReply, replyCampaign };
