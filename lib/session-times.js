'use strict'

/**
 * WHEN a Claude Code session last actually said something.
 *
 * MEASURED 2026-09-17 across 12 real transcripts: a file's mtime and its last real message differ
 * by up to 721 MINUTES. Claude Code appends lines that are not messages — attachment, system,
 * ai-title, mode, permission-mode, atis-latch, bridge-session — and each one touches the file.
 *
 * The session list reported mtime as `updated_at`, so a session whose last message was twelve hours
 * ago read as "now", lit the live dot in the fleet strip, and then opened on a transcript that
 * ended hours earlier. The transcript was right.
 *
 * Reading the TAIL of a large file lands mid-line, so a truncated leading line is discarded rather
 * than parsed. Nothing usable returns null — the caller says so instead of substituting the file
 * time, because "we do not know when it last spoke" and "it spoke just now" are different answers.
 */

const MESSAGE_TYPES = ['user', 'assistant']

function lastMessageAtFromChunk (chunk) {
  if (typeof chunk !== 'string' || chunk === '') return null

  let bestIso = null
  let bestMs = -Infinity

  for (const line of chunk.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed[0] !== '{') continue

    let evt
    try { evt = JSON.parse(trimmed) } catch { continue } // a truncated tail line, or noise

    if (!evt || !MESSAGE_TYPES.includes(evt.type)) continue
    const role = evt.message && evt.message.role
    if (!MESSAGE_TYPES.includes(role)) continue

    const ts = typeof evt.timestamp === 'string' ? evt.timestamp : ''
    const ms = Date.parse(ts)
    if (Number.isNaN(ms)) continue

    // The LATEST time, not the last line: a resumed session can write out of order.
    if (ms > bestMs) {
      bestMs = ms
      bestIso = ts
    }
  }

  return bestIso
}

/** The last message time from a file's tail, or null. Never throws. */
function readLastMessageAt (fs, filePath, size, tailBytes = 1 << 18) {
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const length = Math.min(size, tailBytes)
    const buf = Buffer.allocUnsafe(length)
    const read = fs.readSync(fd, buf, 0, length, Math.max(0, size - length))
    return lastMessageAtFromChunk(buf.slice(0, read).toString('utf8'))
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* already gone */ }
    }
  }
}

module.exports = { lastMessageAtFromChunk, readLastMessageAt, MESSAGE_TYPES }
