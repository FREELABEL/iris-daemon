/**
 * Record a one-off reply to someone already talking to us (#191637).
 *
 * A reply is not a campaign step: it is recorded as kind=reply, tied to the message it answers,
 * and labelled by account. The DM has already gone out by the time this runs, so if the server
 * cannot tie it to an inbound message and refuses, it is recorded as a plain message instead.
 */

/** The label a reply is logged under: the account it went from, never a campaign's name. */
function replyCampaign(account, override) {
  return override || `reply:${account}`;
}

async function recordReply(api, leadId, base) {
  let rec = await api.recordDmSent(leadId, { ...base, kind: 'reply' });
  if (rec.success) return { rec, recordedAs: 'reply' };
  rec = await api.recordDmSent(leadId, base);
  return { rec, recordedAs: 'message (reply link refused)' };
}

module.exports = { recordReply, replyCampaign };
