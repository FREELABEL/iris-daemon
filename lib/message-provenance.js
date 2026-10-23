'use strict'

/**
 * Structured provenance for a message the Hive puts into someone's live session (#190650).
 *
 * The bridge marked an injected message only with a visible "[via iris · <from>]" prefix (#182785).
 * A shared session (a Hive Room) needs more, per message: who sent it, from which session and node,
 * on which model, and whose usage paid for it — so the timeline can say who said what on whose bill.
 * The prefix stays (every renderer shows it today); this travels beside it as the text part's
 * `metadata.iris_provenance`, which the opencode engine stores with the part.
 *
 * WHITELISTED AND BOUNDED. Only these keys, strings clipped, ids as numbers or short ids — a sender
 * cannot use provenance to stuff arbitrary data into someone else's transcript.
 */

const ID = /^[A-Za-z0-9_.:-]{1,128}$/
const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined)
const id = (v) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : (typeof v === 'string' && ID.test(v) ? v : undefined))

/**
 * From the node task and its config. Task fields the daemon always knows (task id, requesting user,
 * time) are filled in; what only the sender knows (source session, model) is taken when given.
 */
function provenanceOf (task, config = {}, now = Date.now()) {
  const t = task || {}
  const c = config || {}
  const out = {
    v: 1,
    via: 'iris_hive',
    sender: str(c.from || c.sender, 64),
    task_id: id(t.id),
    requested_by_user_id: id(t.user_id ?? c.user_id),
    // Whose usage paid for the SENDER's turn. Defaults to the requester; a Room can say otherwise.
    usage_owner_user_id: id(c.usage_owner_user_id ?? t.user_id ?? c.user_id),
    source_session_id: id(c.source_session_id),
    source_node: str(c.source_node, 64),
    source_provider: str(c.source_provider, 40),
    model: str(c.model, 80),
    room_id: id(c.room_id),
    sent_at: new Date(now).toISOString()
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  return out
}

/** Re-check a provenance object at the bridge — it arrives over HTTP and is not trusted as-is. */
function cleanProvenance (p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null
  const c = provenanceOf(
    { id: p.task_id, user_id: p.requested_by_user_id },
    { from: p.sender, usage_owner_user_id: p.usage_owner_user_id, source_session_id: p.source_session_id, source_node: p.source_node, source_provider: p.source_provider, model: p.model, room_id: p.room_id },
    Date.parse(p.sent_at) || Date.now()
  )
  return c
}

module.exports = { provenanceOf, cleanProvenance }
