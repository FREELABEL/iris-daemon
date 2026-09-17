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

/**
 * A session's status and measured activity (epic #185632, step 4b).
 *
 * opencode's /session/status can say a session is WORKING (busy) or RETRYING — facts from the server
 * running it (see lib/opencode-activity.js). Those make it `active` regardless of `updated_at`, which a
 * long tool call does not touch. With no measurement the status stays derived from the timestamp and
 * `activity` is null: "not measured", never "waiting" — absence from every status map proves nothing.
 */
function sessionActivity (s, now = Date.now()) {
  const activity = s && (s.activity === 'working' || s.activity === 'retrying') ? s.activity : null
  return {
    status: activity ? 'active' : deriveSessionStatus(s && s.updated_at, now),
    activity
  }
}

/**
 * How many sessions the daemon asks each provider for. One constant, used by both the fetch and
 * the truncation check, so "hit the cap" cannot drift from the cap itself.
 */
const SESSIONS_PER_PROVIDER_LIMIT = 25

/**
 * The session fields of a heartbeat (epic #185632, step 1).
 *
 * The list alone cannot say whether it is complete. Measured: two live Macs reported exactly 50
 * — 25 per provider × 2 — and the platform had no way to tell that from a real count, because
 * the daemon knew which providers it had cut or could not reach and only logged it.
 *
 * Presence rules, which the server relies on:
 *   - not reportable  → {} — "no update, keep what you have". No truncation facts either: they
 *                        would describe a list that was not refreshed.
 *   - reportable      → the list AND both provider lists, [] meaning "checked, none". Omitting
 *                        them would read as an older daemon that cannot tell.
 */
function sessionReportFields ({ reportable, sessions, truncated, unreachable } = {}) {
  if (reportable !== true) return {}
  return {
    active_sessions: Array.isArray(sessions) ? sessions : [],
    sessions_truncated: Array.isArray(truncated) ? [...truncated] : [],
    sessions_unreachable: Array.isArray(unreachable) ? [...unreachable] : [],
    sessions_limit_per_provider: SESSIONS_PER_PROVIDER_LIMIT
  }
}

module.exports = { deriveSessionStatus, sessionActivity, ACTIVE_MS, IDLE_MS, SESSIONS_PER_PROVIDER_LIMIT, sessionReportFields }
