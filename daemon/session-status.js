'use strict'

/**
 * Derive a session's status from when it was last touched.
 *
 * THE BUG THIS REPLACES: `status: s.status || 'active'`. Whenever a provider gave no status —
 * which is always, for opencode — the daemon stamped 'active'. Measured on the live fleet:
 * 40 sessions across two machines, ONE distinct status value ('active'), oldest last touched
 * 15 DAYS ago and still reported as running.
 *
 * That is not "sessions never expire". It is absence being recorded as activity, which is the
 * same defect as everything else in this codebase: a field that cannot distinguish two states,
 * and therefore answers the only question anyone asks it ("what is running right now?")
 * wrongly and confidently.
 *
 * The thresholds are deliberately coarse. The point is not precision, it is that a
 * fortnight-old session must not look like a live one.
 */

const ACTIVE_MS = 30 * 60 * 1000        // touched within half an hour
const IDLE_MS = 24 * 60 * 60 * 1000     // touched today

/**
 * @param {string|null|undefined} updatedAt ISO timestamp from the provider
 * @param {number} [now] epoch ms, injectable so this is testable without faking clocks
 * @returns {'active'|'idle'|'stale'|'unknown'}
 */
function deriveSessionStatus (updatedAt, now = Date.now()) {
  if (!updatedAt) return 'unknown'

  const t = Date.parse(updatedAt)
  // An unparseable timestamp is NOT a fresh session. Returning 'active' here would
  // reintroduce the bug through the back door for any provider with a malformed date.
  if (Number.isNaN(t)) return 'unknown'

  // A timestamp in the future is a clock problem, not activity. Treat it as unknown rather
  // than crediting it — clock skew across a fleet is normal and must not read as "running".
  if (t > now + ACTIVE_MS) return 'unknown'

  const age = now - t
  if (age <= ACTIVE_MS) return 'active'
  if (age <= IDLE_MS) return 'idle'
  return 'stale'
}

module.exports = { deriveSessionStatus, ACTIVE_MS, IDLE_MS }
