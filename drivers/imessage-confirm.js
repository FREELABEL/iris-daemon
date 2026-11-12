'use strict'
/**
 * Confirm an outgoing iMessage in chat.db before calling it sent.
 *
 * `osascript … send` returning cleanly only means Messages ACCEPTED the command. An unregistered
 * handle, a signed-out account or a network failure all return cleanly and leave a red
 * "Not Delivered" row — or no row at all. This daemon used to answer {ok:true} on that return,
 * and every comms-router iMessage send (fl-api → bridge :3200 → here) inherited the lie.
 * Companion to the CLI fix for #193288.
 *
 * Never throws for a not-confirmed send: callers fall back to a SECOND send path on a throw,
 * and a message that did go out would then be sent twice.
 */
const { execFile } = require('child_process')
const os = require('os')
const path = require('path')

const APPLE_EPOCH = 978307200
/** fl-api waits 15 s for the bridge; osascript + this must stay well inside that. */
const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_INTERVAL_MS = 400

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()

/** Pure. rows: [{rowid, text, is_sent, is_delivered, error}] newest first. */
function classifyOutgoing(rows, text) {
  const want = norm(text)
  const row = rows.find((r) => norm(r.text) === want) || rows.find((r) => !r.text)
  if (!row) return null
  const error = Number(row.error) || 0
  if (error !== 0) return { state: 'failed', rowid: row.rowid, error }
  if (Number(row.is_sent) === 1 || Number(row.is_delivered) === 1) {
    return { state: 'sent', rowid: row.rowid, delivered: Number(row.is_delivered) === 1 }
  }
  return { state: 'pending', rowid: row.rowid }
}

function buildSql({ chatGuid, handle, sinceUnix }) {
  const esc = (s) => String(s).replace(/'/g, "''")
  let match
  if (chatGuid) {
    match = `c.guid = '${esc(chatGuid)}'`
  } else {
    const digits = String(handle || '').includes('@') ? '' : String(handle || '').replace(/\D/g, '')
    match = digits.length >= 7
      ? `(h.id LIKE '%${digits.slice(-10)}' OR c.chat_identifier LIKE '%${digits.slice(-10)}')`
      : `(LOWER(h.id) = LOWER('${esc(handle)}') OR LOWER(c.chat_identifier) = LOWER('${esc(handle)}'))`
  }
  return `SELECT m.ROWID AS rowid, COALESCE(m.text, '') AS text,
      COALESCE(m.is_sent, 0) AS is_sent, COALESCE(m.is_delivered, 0) AS is_delivered,
      COALESCE(m.error, 0) AS error
    FROM message m
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    JOIN chat c ON c.ROWID = cmj.chat_id
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    WHERE m.is_from_me = 1
      AND m.date / 1000000000 + ${APPLE_EPOCH} >= ${Math.floor(sinceUnix) - 5}
      AND ${match}
    ORDER BY m.date DESC LIMIT 10`
}

/** Standalone reader for the route's fallback path (no driver running). */
function sqliteRunner(dbPath = process.env.IRIS_IMESSAGE_DB || path.join(os.homedir(), 'Library', 'Messages', 'chat.db')) {
  return (sql) => new Promise((resolve, reject) => {
    execFile('/usr/bin/sqlite3', ['-readonly', '-json', '-bail', dbPath, sql], { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim().slice(0, 200)))
      try { resolve(stdout.trim() ? JSON.parse(stdout) : []) } catch (e) { reject(e) }
    })
  })
}

/**
 * @returns {Promise<{state:'sent'|'failed'|'pending'|'missing'|'unknown', ...}>}
 */
async function confirmOutgoing({ runSql, chatGuid, handle, text, sinceUnix, timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = DEFAULT_INTERVAL_MS }) {
  const sql = buildSql({ chatGuid, handle, sinceUnix })
  const deadline = Date.now() + timeoutMs
  let last = null
  for (;;) {
    try {
      last = classifyOutgoing(await runSql(sql), text)
    } catch (err) {
      return { state: 'unknown', reason: `cannot read chat.db: ${err.message}` }
    }
    if (last && last.state !== 'pending') return last
    if (Date.now() >= deadline) return last || { state: 'missing' }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/**
 * HTTP answer for a confirmation. fl-api treats ONLY 2xx as sent, so anything short of a
 * confirmed send is non-2xx. "Unconfirmed" states say plainly that the message MAY have gone out,
 * so nobody retries blindly into a duplicate.
 */
function httpResult(c, who) {
  switch (c.state) {
    case 'sent':
      return { status: 200, body: { ok: true, confirmed: true, delivered: !!c.delivered } }
    case 'failed':
      return { status: 502, body: { ok: false, confirmed: false, state: c.state, error: `Messages marked the message to ${who} NOT DELIVERED (error ${c.error})` } }
    case 'missing':
      return { status: 502, body: { ok: false, confirmed: false, state: c.state, error: `Messages accepted the send but no message to ${who} appeared in the conversation — NOT sent` } }
    case 'pending':
      return { status: 504, body: { ok: false, confirmed: false, state: c.state, error: `Message to ${who} is in Messages but not sent after ${DEFAULT_TIMEOUT_MS / 1000}s — it may still go out; check the conversation before retrying` } }
    default:
      return { status: 503, body: { ok: false, confirmed: false, state: 'unknown', error: `Handed to Messages for ${who} but delivery could not be confirmed (${c.reason}) — it may have been sent; check the conversation before retrying` } }
  }
}

module.exports = { classifyOutgoing, buildSql, confirmOutgoing, sqliteRunner, httpResult, DEFAULT_TIMEOUT_MS }
