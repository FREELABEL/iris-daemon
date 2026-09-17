'use strict'

/**
 * Name a Claude Code session after its first REAL user message.
 *
 * Measured 2026-09-17 in the IRIS chat Sessions tab: sessions listed as "/recap recap" and
 * "/model model". Their first user message was a bare slash command —
 *   <command-name>/recap</command-name> <command-message>recap</command-message> <command-args></command-args>
 * — and stripping the tags glued the name and the message together. Skipped now, along with the
 * other things Claude Code writes as "user" messages that nobody typed: command output
 * (<local-command-stdout>), the caveat before it, interruptions, and system reminders.
 *
 * A slash command WITH arguments is kept as `/command args` — there the arguments are the work.
 */

const tryJSON = (line) => {
  try { return JSON.parse(line) } catch { return null }
}

function userText (evt) {
  const c = evt.message.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ')
  return ''
}

function nameFromMessage (raw) {
  // A slash command: its arguments are the only part that says what the session is about.
  const command = raw.match(/<command-name>\s*([^<]*?)\s*<\/command-name>/)
  if (command) {
    const args = (raw.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || ''
    return args.trim() ? `${command[1]} ${args}` : ''
  }
  if (/^\s*<local-command-/.test(raw)) return ''

  return raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<[^>]+>/g, '')
}

function extractSessionName (lines, projectPath) {
  for (const line of Array.isArray(lines) ? lines : []) {
    const evt = tryJSON(line)
    if (!evt || evt.type !== 'user' || !evt.message || evt.message.role !== 'user') continue

    const cleaned = nameFromMessage(userText(evt)).replace(/\s+/g, ' ').trim()
    if (
      !cleaned ||
      cleaned.length < 3 ||
      cleaned.startsWith('Caveat:') ||
      cleaned.startsWith('[Request interrupted') ||
      cleaned.startsWith('clear') ||
      cleaned.startsWith('/clear')
    ) continue

    return cleaned.length > 80 ? cleaned.slice(0, 77) + '...' : cleaned
  }

  if (projectPath) {
    const segments = String(projectPath).replace(/\/+$/, '').split('/')
    return segments[segments.length - 1] || 'Coding Session'
  }
  return 'Coding Session'
}

module.exports = { extractSessionName }
