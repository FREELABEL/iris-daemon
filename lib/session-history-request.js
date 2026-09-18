'use strict'

/**
 * What `GET /api/sessions/history` accepts, and what it returns (epic #185632).
 *
 * The transcript is read over bridge_call, not the CLI: `run_iris_command` shells out through
 * tmux, and measured 2026-09-17 the same command returned exit 1 with no output twice and exit 0
 * twice on one machine. bridge_call runs inside the daemon — no shell, no PATH, no tmux — and its
 * arguments arrive as query strings, hence the parsing here.
 *
 * The id is shape-checked because it is used to build a filename; `..` and separators are refused
 * rather than escaped.
 */

const PROVIDER_SLUGS = ['claude-code', 'opencode', 'ollama']
const ALIASES = { claude_code: 'claude-code', claudecode: 'claude-code', claude: 'claude-code', open_code: 'opencode' }
const ID = /^[A-Za-z0-9_-]{4,200}$/

const MAX_MESSAGES = 100
const DEFAULT_MESSAGES = 20
const MAX_TEXT = 2000
/** What a provider route hands back when the caller names no limit. */
const HISTORY_PAGE = 200

function normalizeHistoryRequest (query = {}) {
  const id = String(query.id ?? '').trim()
  if (!id) return { error: 'id is required' }
  if (!ID.test(id)) return { error: 'id must be a session id — letters, digits, dash or underscore only' }

  const raw = String(query.provider ?? '').trim().toLowerCase()
  const slug = ALIASES[raw] || (PROVIDER_SLUGS.includes(raw) ? raw : null)

  const asked = Number.parseInt(String(query.limit ?? ''), 10)
  const limit = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), MAX_MESSAGES) : DEFAULT_MESSAGES

  // A byte cursor from a previous read. ABSENT and 0 are different requests: absent is a first
  // open (page + totals), 0 is "I have nothing, read me forward from the start of the file".
  const rawSince = Number.parseInt(String(query.since ?? ''), 10)
  const since = Number.isFinite(rawSince) && rawSince >= 0 ? rawSince : undefined

  return { id, providers: slug ? [slug] : PROVIDER_SLUGS, limit, since }
}

/**
 * The NEWEST `limit` messages, with the whole session's size alongside them.
 *
 * `slice(0, limit)` is the shape of this bug: it hands back the OLDEST page, and a caller that
 * then takes a tail gets the newest of the oldest — a transcript frozen hours before the session
 * last spoke, in a response whose own `updated_at` says otherwise (measured 2026-09-17).
 */
function newestMessages (messages, limit) {
  if (!Array.isArray(messages)) return { messages: [], total: 0, omitted: 0 }
  const size = Number.isFinite(limit) && limit > 0 ? limit : HISTORY_PAGE
  const page = messages.slice(-size)
  return { messages: page, total: messages.length, omitted: Math.max(0, messages.length - page.length) }
}

/**
 * How many messages the reader is NOT seeing — counted against the SESSION, not against whatever
 * page the machine happened to send. `sliceOmitted` is the fallback for a machine that does not
 * report a total; a total that cannot be true (below what was shown) is not believed.
 */
function omittedFrom (sessionTotal, sliceOmitted, shown) {
  return Number.isFinite(sessionTotal) && sessionTotal >= shown ? sessionTotal - shown : sliceOmitted
}

/** The tail is what "what is happening in this session" means; each message is bounded. */
function tailMessages (messages, limit) {
  const page = newestMessages(messages, limit)
  return {
    messages: page.messages.map((m) => (m && typeof m.text === 'string' && m.text.length > MAX_TEXT ? { ...m, text: m.text.slice(0, MAX_TEXT) } : m)),
    omitted: page.omitted,
  }
}

module.exports = { normalizeHistoryRequest, tailMessages, newestMessages, omittedFrom, PROVIDER_SLUGS, MAX_MESSAGES, DEFAULT_MESSAGES, HISTORY_PAGE }
