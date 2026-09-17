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

function normalizeHistoryRequest (query = {}) {
  const id = String(query.id ?? '').trim()
  if (!id) return { error: 'id is required' }
  if (!ID.test(id)) return { error: 'id must be a session id — letters, digits, dash or underscore only' }

  const raw = String(query.provider ?? '').trim().toLowerCase()
  const slug = ALIASES[raw] || (PROVIDER_SLUGS.includes(raw) ? raw : null)

  const asked = Number.parseInt(String(query.limit ?? ''), 10)
  const limit = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), MAX_MESSAGES) : DEFAULT_MESSAGES

  return { id, providers: slug ? [slug] : PROVIDER_SLUGS, limit }
}

/** The tail is what "what is happening in this session" means; each message is bounded. */
function tailMessages (messages, limit) {
  if (!Array.isArray(messages)) return { messages: [], omitted: 0 }
  const tail = messages.slice(-limit)
  return {
    messages: tail.map((m) => (m && typeof m.text === 'string' && m.text.length > MAX_TEXT ? { ...m, text: m.text.slice(0, MAX_TEXT) } : m)),
    omitted: Math.max(0, messages.length - tail.length),
  }
}

module.exports = { normalizeHistoryRequest, tailMessages, PROVIDER_SLUGS, MAX_MESSAGES, DEFAULT_MESSAGES }
