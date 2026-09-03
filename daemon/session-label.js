'use strict'

/**
 * Give every session a name a human can use.
 *
 * A session's `name` is whatever its first message happened to be, so the fleet carries
 * values that are not identifiers at all. Measured live — 14 unusable names across two
 * machines:
 *
 *   claude_code  a 52-character box-drawing rule
 *   claude_code  'agentsmemory<PUA>ATLAS<PUA>Agents…'  (Nerd Font private-use glyphs)
 *   claude_code  'bfgbczjub toolu_01L2vStst… /private/tmp/…'  (a raw tool-use id)
 *   opencode     'New session - 2026-08-31T16:08:47.414Z'
 *
 * Fixed HERE rather than in the CLI so every consumer benefits — the MCP tools and the API
 * fleet view serve the same field, and fixing it in one renderer would leave the others
 * showing box-drawing rules.
 *
 * The raw value is never destroyed; callers keep `name` and gain `label`.
 */

// Control characters, box drawing, block elements, and the private-use area (where Nerd
// Fonts live). All three were observed as session names on the live fleet.
const NOISE = /[\u0000-\u001f\u007f\u2500-\u259f\ue000-\uf8ff]/g

/** A generated placeholder is not a name — it tells you less than the id does. */
const PLACEHOLDER = /^(new session\b|session$|untitled\b|opencode session$)/i

/**
 * @param {{name?:string, project_path?:string|null, session_id?:string, provider?:string}} s
 * @returns {string} always non-empty
 */
function sessionLabel(s) {
  const cleaned = String((s && s.name) || '')
    .replace(NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const usable = cleaned.length >= 4 && /[a-z0-9]/i.test(cleaned) && !PLACEHOLDER.test(cleaned)

  if (usable) return cleaned.length > 72 ? cleaned.slice(0, 71) + '…' : cleaned

  // Fall back to what the session actually IS. The project it runs in and a short id are
  // both stable and both mean something, which the first message often does not.
  const proj = String((s && s.project_path) || '')
    .split('/')
    .filter(Boolean)
    .pop()
  const id = String((s && s.session_id) || '').slice(-8)

  if (proj && id) return `${proj} · ${id}`
  if (proj) return proj
  if (id) return `session ${id}`

  return String((s && s.provider) || 'session')
}

module.exports = { sessionLabel, NOISE, PLACEHOLDER }
