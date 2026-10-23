'use strict'

/**
 * opencode sessions asked of the servers RUNNING them, not read from files (epic #189446, K2).
 *
 * The lister read ~/.local/share/opencode/storage/session/*\/*.json — the legacy JSON store the
 * 1.3.x CLI writes. IRIS Desktop (opencode 1.18.23) keeps sessions in SQLite
 * (`opencode-<channel>.db`), and a second account gets its own XDG_DATA_HOME. So the chats people
 * have open in Desktop never reached the fleet: the machine you sit at was the one the fleet knew
 * least about.
 *
 * The fix is not a SQLite reader. Every running server already answers
 * `GET /experimental/session?roots=true&limit=N` with the sessions in ITS store, whatever the store
 * is. The daemon already discovers those servers (lsof → loopback ports) for the live-activity
 * check, so this asks the same list one more question.
 *
 * - A server that does not know the route (the 1.3.x CLI) answers 200 with the web UI's HTML;
 *   `fetchJson` returns null for non-JSON, so that server simply contributes nothing.
 * - Several servers can share a store (CLI servers share the JSON store), so rows are de-duplicated
 *   by id, freshest `updated_at` winning.
 * - Root sessions only: sub-agent children are not something a person opens, and counting them would
 *   spend the per-provider cap on them.
 *
 * Pure apart from the injected `fetchJson(url, timeoutMs)` → parsed body | null. Never throws.
 */

const CALL_TIMEOUT_MS = 1500

const iso = (ms) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null)

/** One GlobalSession row from opencode's server → the lister's row shape. null if unusable. */
function rowFromServerSession (s, base) {
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || s.id === '') return null
  const m = s.model && typeof s.model === 'object' ? s.model : null
  const model = m ? [m.providerID, m.modelID || m.id].filter(Boolean).join('/') || null : null
  return {
    session_id: s.id,
    name: s.title || s.slug || 'OpenCode Session',
    project_path: s.directory || (s.project && s.project.worktree) || null,
    git_branch: null,
    model,
    created_at: iso(s.time && s.time.created),
    updated_at: iso(s.time && s.time.updated),
    message_count: null,
    provider: 'opencode',
    summary: null,
    parent_id: s.parentID || null,
    // Which server holds it. Not reported upward; used to read and deliver without re-discovery.
    server: base
  }
}

/** Ask every server for its sessions. Returns {rows, asked, answered}. */
async function listServerSessions ({ servers, fetchJson, limit = 25 } = {}) {
  const bases = Array.isArray(servers) ? servers : []
  let answered = 0
  const results = await Promise.all(bases.map((base) => {
    const url = `${String(base).replace(/\/+$/, '')}/experimental/session?roots=true&limit=${limit}`
    return Promise.resolve()
      .then(() => fetchJson(url, CALL_TIMEOUT_MS))
      .then((body) => {
        if (!Array.isArray(body)) return []
        answered++
        return body.map((s) => rowFromServerSession(s, base)).filter(Boolean)
      })
      .catch(() => [])
  }))
  return { rows: results.flat(), asked: bases.length, answered }
}

/**
 * Merge rows from files and from servers. Same id → keep the freshest; a server row (which knows
 * the model) fills in what a file row lacks. Sorted freshest first, then cut to `limit`.
 */
function mergeSessionRows (fileRows, serverRows, limit) {
  const byId = new Map()
  const t = (r) => Date.parse((r && r.updated_at) || '') || 0
  for (const r of [...(fileRows || []), ...(serverRows || [])]) {
    if (!r || !r.session_id) continue
    const prev = byId.get(r.session_id)
    if (!prev) { byId.set(r.session_id, r); continue }
    const [a, b] = t(r) >= t(prev) ? [r, prev] : [prev, r]
    const merged = { ...b, ...a }
    for (const k of Object.keys(b)) if (merged[k] == null && b[k] != null) merged[k] = b[k]
    byId.set(r.session_id, merged)
  }
  const out = [...byId.values()].sort((a, b) => t(b) - t(a))
  return typeof limit === 'number' ? out.slice(0, limit) : out
}

/**
 * opencode's `GET /session/:id/message` ([{info, parts}]) → the history route's message shape, so a
 * session that lives only in a server's store can still be read from another machine.
 */
function historyFromServerMessages (items, limit = 200) {
  const messages = []
  const filesEdited = new Set()
  const commandsRun = []
  const toolCounts = {}
  for (const item of Array.isArray(items) ? items : []) {
    const info = item && item.info
    if (!info || !info.role) continue
    const role = info.role === 'assistant' ? 'assistant' : 'user'
    const timestamp = iso(info.time && info.time.created)
    for (const part of Array.isArray(item.parts) ? item.parts : []) {
      if (!part || typeof part !== 'object') continue
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim() && !part.synthetic) {
        messages.push({ role, type: 'text', text: part.text.slice(0, 2000), timestamp })
      } else if (part.type === 'tool') {
        const tool = part.tool || 'unknown'
        const input = (part.state && part.state.input) || {}
        toolCounts[tool] = (toolCounts[tool] || 0) + 1
        const fp = input.filePath || input.file_path || input.path || null
        if (fp && ['edit', 'write', 'patch', 'multiedit'].includes(tool)) filesEdited.add(fp)
        const cmd = typeof input.command === 'string' ? input.command.slice(0, 200) : null
        if (cmd && tool === 'bash') commandsRun.push(cmd)
        messages.push({ role, type: 'tool_use', tool, file_path: fp, command: cmd, timestamp })
      }
    }
  }
  // The newest `limit`, still in order: a transcript opened from another machine is read for what
  // is happening NOW, and the old route's slice(0, limit) kept the oldest.
  const limited = messages.slice(-limit)
  return {
    summary: {
      total_messages: messages.filter(m => m.type === 'text').length,
      user_messages: messages.filter(m => m.role === 'user' && m.type === 'text').length,
      assistant_messages: messages.filter(m => m.role === 'assistant' && m.type === 'text').length,
      files_edited: [...filesEdited],
      commands_run: commandsRun.slice(0, 50),
      tools_used: toolCounts
    },
    messages: limited,
    // The WHOLE session's size (#190957) — see desktop-sessions.js.
    messages_total: messages.length
  }
}

module.exports = { rowFromServerSession, listServerSessions, mergeSessionRows, historyFromServerMessages, CALL_TIMEOUT_MS }
