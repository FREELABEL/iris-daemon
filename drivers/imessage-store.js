/**
 * iMessage — direct read of chat.db.
 *
 * REPLACES a read that required the live iMessage CHANNEL to be running. That coupling was
 * the bug (#178747): listing your conversations is a READ, but it could only be served by
 * starting an always-on, write-capable channel — the same channel that must never run
 * casually because it auto-replies to real contacts (#137256). So the safe answer was
 * "unavailable" and the available answer was unsafe.
 *
 * chat.db is the same store the native driver already queries, so this adds no new
 * permission: Full Disk Access, which the capability probe already checks for.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

/** Apple stores message dates as NANOseconds since 2001-01-01 (older rows: seconds). */
const APPLE_EPOCH_OFFSET = 978307200

const DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db')

const storePath = () => process.env.IRIS_IMESSAGE_DB || DB_PATH

function toDate(raw) {
  const n = Number(raw)
  if (!n) return null
  // Post-High-Sierra rows are nanoseconds; older ones are seconds. 1e11 separates them.
  const secs = n > 1e11 ? n / 1e9 : n
  return new Date((secs + APPLE_EPOCH_OFFSET) * 1000)
}

function query(sql) {
  return new Promise((resolve, reject) => {
    const db = storePath()
    if (!fs.existsSync(db)) {
      return reject(new Error('Messages chat.db not found — is this macOS with Messages configured?'))
    }
    try {
      fs.accessSync(db, fs.constants.R_OK)
    } catch {
      return reject(new Error('No permission to read Messages — grant Full Disk Access in System Settings › Privacy'))
    }
    execFile('/usr/bin/sqlite3', ['-json', `file:${db}?immutable=1`, sql],
      { timeout: 20000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message).trim().split('\n').pop()
          return reject(new Error(`Messages store query failed: ${msg}`))
        }
        try { resolve(stdout.trim() ? JSON.parse(stdout) : []) }
        catch (e) { reject(new Error(`Messages store returned unparseable output: ${e.message}`)) }
      })
  })
}

/** Recent conversations, most-recently-active first. */
async function listConversations({ limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)))
  const rows = await query(`
    SELECT c.guid                AS guid,
           c.display_name        AS display_name,
           c.chat_identifier     AS chat_identifier,
           MAX(m.date)           AS last_date,
           COUNT(m.ROWID)        AS message_count,
           (SELECT COUNT(*) FROM chat_handle_join chj WHERE chj.chat_id = c.ROWID) AS participants
      FROM chat c
      JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
      JOIN message m             ON m.ROWID = cmj.message_id
     GROUP BY c.ROWID
     ORDER BY last_date DESC
     LIMIT ${lim};
  `)

  return rows.map((r) => ({
    guid: r.guid,
    display_name: r.display_name || r.chat_identifier || r.guid,
    chat_identifier: r.chat_identifier,
    is_group: Number(r.participants) > 1,
    participants: Number(r.participants) || 0,
    message_count: Number(r.message_count) || 0,
    last_message_at: toDate(r.last_date),
  }))
}

/** Recent messages with a handle (phone/email) — what search_messages actually means. */
async function searchMessages({ handle, days = 30, limit = 25 } = {}) {
  if (!handle) throw new Error('handle is required (a phone number or email)')
  const lim = Math.max(1, Math.min(500, Math.floor(Number(limit) || 25)))
  const d = Math.max(1, Math.min(365, Math.floor(Number(days) || 30)))
  const safe = String(handle).replace(/'/g, "''")
  const cutoff = `(strftime('%s','now') - ${APPLE_EPOCH_OFFSET} - ${d} * 86400) * 1000000000`

  const rows = await query(`
    SELECT m.text AS text, m.date AS date, m.is_from_me AS is_from_me, h.id AS handle
      FROM message m
      JOIN handle h ON h.ROWID = m.handle_id
     WHERE h.id LIKE '%${safe}%'
       AND m.date > ${cutoff}
       AND m.text IS NOT NULL
     ORDER BY m.date DESC
     LIMIT ${lim};
  `)

  return rows.map((r) => ({
    text: r.text == null ? '' : String(r.text),
    sent_at: toDate(r.date),
    from_me: !!Number(r.is_from_me),
    handle: r.handle,
  }))
}

async function probeUnavailable() {
  const saved = process.env.IRIS_IMESSAGE_DB
  process.env.IRIS_IMESSAGE_DB = '/nonexistent/chat.db'
  try {
    await listConversations({ limit: 1 })
    return { threw: false, message: 'returned normally — an unreadable store looked like an empty inbox' }
  } catch (e) {
    return { threw: true, message: e.message }
  } finally {
    if (saved === undefined) delete process.env.IRIS_IMESSAGE_DB
    else process.env.IRIS_IMESSAGE_DB = saved
  }
}

module.exports = { listConversations, searchMessages, probeUnavailable, storePath }
