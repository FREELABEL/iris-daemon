'use strict'

/**
 * A few words about what a session was for and where it ended (#194315), so Home's
 * "Today · across your projects" can say what got DONE in your coding sessions, not only what
 * was written on your boards.
 *
 * Three fields, each cut to DIGEST_CHARS: the first thing the person asked, the last thing they
 * asked, and the agent's last reply. Taken from the head and tail chunks the listers already read —
 * no extra file reads. A session quiet for more than DIGEST_MAX_AGE_H gets none, so old work does
 * not keep travelling in every heartbeat. `IRIS_SESSION_DIGESTS=off` stops it on a machine.
 *
 * Text leaves this machine in the heartbeat (to your own IRIS account, like the session's label
 * already does). Kept short on purpose: enough to summarise, not a transcript.
 */

const DIGEST_CHARS = 240
const DIGEST_MAX_AGE_H = 48

const enabled = (env = process.env) => String(env.IRIS_SESSION_DIGESTS || '').toLowerCase() !== 'off'

function clip (t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim()
  if (!s) return null
  return s.length > DIGEST_CHARS ? s.slice(0, DIGEST_CHARS - 1).trimEnd() + '…' : s
}

function lines (chunk) {
  const out = []
  for (const l of String(chunk || '').split('\n')) {
    const t = l.trim()
    if (!t || t[0] !== '{') continue
    try { out.push(JSON.parse(t)) } catch { /* a line cut at the chunk edge */ }
  }
  return out
}

function textOf (content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join(' ')
  return ''
}

// What Claude Code writes into a user turn that the person did not type.
const NOT_TYPED = /^\s*(<command-|<local-command|<system-reminder|<task-notification|Caveat:|\[Request interrupted)/

/** First ask, last ask, last reply from a Claude Code transcript's head and tail. Pure. */
function claudeDigest (head, tail) {
  let first = null
  let lastAsk = null
  let lastReply = null
  const scan = (events, setFirst) => {
    for (const e of events) {
      const m = e && e.message
      if (!m) continue
      if (e.type === 'user' && m.role === 'user') {
        const t = textOf(m.content)
        if (t && !NOT_TYPED.test(t)) {
          if (setFirst && !first) first = t
          lastAsk = t
        }
      } else if (e.type === 'assistant') {
        const t = textOf(m.content)
        if (t.trim()) lastReply = t
      }
    }
  }
  scan(lines(head), true)
  scan(lines(tail), !first)
  return { first_ask: clip(first), last_ask: clip(lastAsk), last_reply: clip(lastReply) }
}

/** The same three from a Codex rollout's head and tail (event_msg user_message / agent_message). Pure. */
function codexDigest (head, tail) {
  let first = null
  let lastAsk = null
  let lastReply = null
  for (const [i, e] of [...lines(head), ...lines(tail)].entries()) {
    const p = e && e.type === 'event_msg' && e.payload
    if (!p || typeof p.message !== 'string') continue
    if (p.type === 'user_message') { if (!first) first = p.message; lastAsk = p.message }
    else if (p.type === 'agent_message') lastReply = p.message
    void i
  }
  return { first_ask: clip(first), last_ask: clip(lastAsk), last_reply: clip(lastReply) }
}

/** A digest for a session last active at `lastAt`, or null when it is off, too old or empty. */
function digestFor (kind, head, tail, lastAt, now = Date.now(), env = process.env) {
  if (!enabled(env)) return null
  const t = Date.parse(lastAt || '')
  if (Number.isNaN(t) || now - t > DIGEST_MAX_AGE_H * 3600_000) return null
  const d = kind === 'codex' ? codexDigest(head, tail) : claudeDigest(head, tail)
  return d.first_ask || d.last_reply ? d : null
}

module.exports = { DIGEST_CHARS, DIGEST_MAX_AGE_H, enabled, clip, claudeDigest, codexDigest, digestFor }
