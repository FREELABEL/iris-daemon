'use strict'

/**
 * Read a transcript the way it is written: from the END.
 *
 * A Claude Code transcript is an append-only JSONL file. The newest messages are always the last
 * bytes, and a reader who already has bytes 0..N only ever needs [N, EOF). A byte offset is
 * therefore a COMPLETE cursor — nothing else about the file needs to be remembered.
 *
 * MEASURED 2026-09-17, before this existed: the history route parsed the whole file to answer
 * either question. 40.7MB read and 1,876 message objects built in order to return 60, when those
 * 60 lived in the last 704KB — 57:1 on bytes, 31:1 on objects, and 1.09s of CPU for every poll of
 * every viewer. At a 2s refresh that is half a core per person watching one session.
 *
 * With a cursor the steady state is a `stat`: size unchanged, zero bytes read, zero messages
 * returned. That is what makes live updates affordable — and it is why this file has no watcher,
 * no long-poll and no cache. Those were all parts protecting against a cost that no longer exists.
 */

/** Covers 60 messages with ~3x headroom on the transcripts measured (360KB and 704KB needed). */
const FIRST_TAIL_BYTES = 1 << 21
/** One request never reads more than this, however few messages it found. */
const MAX_TAIL_BYTES = 32 << 20
const MAX_TEXT = 2000
const MESSAGE_ROLES = ['user', 'assistant']
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit']

/** Where to start reading for a tail of `tailBytes` — never before the start of the file. */
function chunkStart (size, tailBytes) {
  return Math.max(0, size - tailBytes)
}

/**
 * A read that starts mid-file starts mid-LINE. That first fragment is not a record and must not be
 * parsed as one. A read from byte 0 begins at a real line start, so nothing is dropped.
 */
function dropPartialLine (chunk, from) {
  if (from <= 0) return chunk
  const nl = chunk.indexOf('\n')
  return nl === -1 ? '' : chunk.slice(nl + 1)
}

/**
 * The messages the panel renders — and only those.
 *
 * `tool_result` blocks are deliberately not emitted: they are the largest thing in the file and the
 * reader never sees them, so they should not cross the machine boundary at all.
 */
function messagesFromChunk (chunk) {
  const messages = []
  if (typeof chunk !== 'string' || chunk === '') return messages

  for (const raw of chunk.split('\n')) {
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed[0] !== '{') continue

    let obj
    try { obj = JSON.parse(trimmed) } catch { continue } // truncated tail line, or noise

    const msg = (obj && obj.message) || {}
    const role = msg.role || obj.type
    if (!MESSAGE_ROLES.includes(obj && obj.type) || !MESSAGE_ROLES.includes(role)) continue

    const at = typeof obj.timestamp === 'string' ? obj.timestamp : null
    const content = msg.content || obj.content || ''

    if (typeof content === 'string') {
      if (content.trim()) messages.push({ role, type: 'text', text: content.slice(0, MAX_TEXT), timestamp: at })
      continue
    }
    if (!Array.isArray(content)) continue

    for (const block of content) {
      if (!block || typeof block !== 'object') continue

      if (block.type === 'text' && block.text) {
        messages.push({ role, type: 'text', text: String(block.text).slice(0, MAX_TEXT), timestamp: at })
        continue
      }
      if (block.type !== 'tool_use') continue // tool_result: never leaves the machine

      const tool = block.name || 'unknown'
      const input = block.input || {}
      const entry = { role, type: 'tool_use', tool, timestamp: at }

      if (EDIT_TOOLS.includes(tool)) entry.file_path = input.file_path || input.notebook_path || ''
      else if (tool === 'Read') entry.file_path = input.file_path || null
      else if (tool === 'Bash') entry.command = String(input.command || '').slice(0, 200)
      else if (tool === 'Grep' || tool === 'Glob') {
        entry.file_path = input.path || input.pattern || null
        entry.command = input.pattern || null
      }
      messages.push(entry)
    }
  }

  return messages
}

/**
 * The end of the last COMPLETE line in a chunk read from `from`.
 *
 * The file is being appended to while we read it, so the last bytes are routinely half a line.
 * The cursor must stop before that fragment: consuming it would lose that message permanently,
 * because the next read starts after the cursor.
 */
function completeThrough (chunk, from) {
  // No `-1` guard: a chunk with no newline yields `from + -1 + 1`, which is `from` — exactly the
  // "nothing complete yet" answer. The guard was unreachable by construction (mutation-tested).
  return from + chunk.lastIndexOf('\n') + 1
}

/** Read [from, size). Never throws; a file that moved under us reads as empty. */
function readRange (fs, filePath, from, size) {
  const length = Math.max(0, size - from)
  if (length === 0) return { chunk: '', bytesRead: 0 }

  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.allocUnsafe(length)
    const read = fs.readSync(fd, buf, 0, length, from)
    return { chunk: buf.slice(0, read).toString('utf8'), bytesRead: read }
  } catch {
    return { chunk: '', bytesRead: 0 }
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* already gone */ }
    }
  }
}

/**
 * The newest `want` messages. Widens the window rather than answering short: a session whose last
 * few turns are enormous would otherwise silently return three messages and look empty.
 */
function readTail (fs, filePath, size, want, opts = {}) {
  let tailBytes = Math.max(1, opts.tailBytes || FIRST_TAIL_BYTES)
  const max = opts.maxBytes || MAX_TAIL_BYTES

  for (;;) {
    const from = chunkStart(size, tailBytes)
    const { chunk, bytesRead } = readRange(fs, filePath, from, size)
    const messages = messagesFromChunk(dropPartialLine(chunk, from))

    if (messages.length >= want || from === 0 || tailBytes >= max) {
      return {
        messages: messages.slice(-want),
        from,
        offset: completeThrough(chunk, from),
        bytesRead,
        complete: from === 0,
      }
    }
    tailBytes = Math.min(tailBytes * 2, max)
  }
}

/**
 * Only what was appended since `since`. The whole reason this module exists.
 *
 * A file SMALLER than the cursor was rewritten, not appended to — the offset means nothing against
 * the new file, so say so and let the caller start again rather than parse from a random byte.
 */
function readSince (fs, filePath, size, since, opts = {}) {
  if (!Number.isFinite(since) || since < 0) return { messages: [], offset: size, bytesRead: 0, reset: true }
  if (since > size) return { messages: [], offset: size, bytesRead: 0, reset: true }
  // No early return for `since === size`: readRange already refuses a zero-length read without
  // opening the file, which is the same answer for less code (mutation-tested).

  // No `dropPartialLine` here: a cursor always points AT a line start, because it was itself set
  // to the end of a complete line. Dropping the first line would silently eat a message.
  const { chunk, bytesRead } = readRange(fs, filePath, since, size)
  const end = completeThrough(chunk, since)
  const messages = messagesFromChunk(chunk.slice(0, end - since))

  // More than a page of new messages means the reader has been away. Streaming them all grows the
  // panel without bound; refetching the page is both cheaper and simpler than merging a flood.
  if (opts.max && messages.length > opts.max) {
    return { messages: [], offset: end, bytesRead, reset: false, truncated: true }
  }

  return { messages, offset: end, bytesRead, reset: false }
}

module.exports = {
  chunkStart, dropPartialLine, completeThrough, messagesFromChunk, readRange, readTail, readSince,
  FIRST_TAIL_BYTES, MAX_TAIL_BYTES, MAX_TEXT,
}
