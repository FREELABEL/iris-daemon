/**
 * Apple Mail — direct read of the Envelope Index.
 *
 * REPLACES `messages of inbox whose sender contains X`, which is the SAME whose-clause
 * pathology that made Calendar unusable (#178745): MEASURED at 30+ seconds here, hitting
 * the execFile timeout and returning a truncated dump of the AppleScript instead of mail.
 *
 * The Envelope Index is Mail.app's own SQLite catalogue (~697MB on this machine) and
 * answers the same question in ~0.28s. Needs Full Disk Access, which the capability probe
 * already checks.
 *
 * SCOPE, stated honestly: the index holds ENVELOPES — sender, subject, dates, mailbox. It
 * does NOT hold message bodies; those live in .emlx files on disk. So this covers search
 * and listing, and body retrieval stays a separate concern rather than being silently
 * half-implemented.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

function storePath() {
  if (process.env.IRIS_MAIL_DB) return process.env.IRIS_MAIL_DB
  const base = path.join(os.homedir(), 'Library', 'Mail')
  try {
    // V10 today, V9 before it — pick the highest rather than hardcoding a macOS version.
    const versions = fs.readdirSync(base).filter((d) => /^V\d+$/.test(d))
      .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))
    for (const v of versions) {
      const p = path.join(base, v, 'MailData', 'Envelope Index')
      if (fs.existsSync(p)) return p
    }
  } catch { /* fall through */ }
  return path.join(base, 'V10', 'MailData', 'Envelope Index')
}

function query(sql) {
  return new Promise((resolve, reject) => {
    const db = storePath()
    if (!fs.existsSync(db)) {
      return reject(new Error('Mail Envelope Index not found — is Mail.app configured on this Mac?'))
    }
    try {
      fs.accessSync(db, fs.constants.R_OK)
    } catch {
      return reject(new Error('No permission to read Mail — grant Full Disk Access in System Settings › Privacy'))
    }
    execFile('/usr/bin/sqlite3', ['-json', `file:${db}?immutable=1`, sql],
      { timeout: 20000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message).trim().split('\n').pop()
          return reject(new Error(`Mail index query failed: ${msg}`))
        }
        try { resolve(stdout.trim() ? JSON.parse(stdout) : []) }
        catch (e) { reject(new Error(`Mail index returned unparseable output: ${e.message}`)) }
      })
  })
}

/** Search recent mail by sender substring, optionally by subject. */
async function searchEmails({ from = '', days = 14, limit = 20, subject = '' } = {}) {
  const lim = Math.max(1, Math.min(200, Math.floor(Number(limit) || 20)))
  const d = Math.max(1, Math.min(365, Math.floor(Number(days) || 14)))
  const esc = (s) => String(s).replace(/'/g, "''")

  const where = [`m.date_sent > strftime('%s','now') - ${d} * 86400`]
  if (from) where.push(`a.address LIKE '%${esc(from)}%'`)
  if (subject) where.push(`s.subject LIKE '%${esc(subject)}%'`)

  const rows = await query(`
    SELECT s.subject   AS subject,
           a.address   AS sender,
           a.comment   AS sender_name,
           m.date_sent AS date_sent,
           mb.url      AS mailbox
      FROM messages m
      LEFT JOIN subjects  s  ON s.ROWID  = m.subject
      LEFT JOIN addresses a  ON a.ROWID  = m.sender
      LEFT JOIN mailboxes mb ON mb.ROWID = m.mailbox
     WHERE ${where.join(' AND ')}
     ORDER BY m.date_sent DESC
     LIMIT ${lim};
  `)

  return rows.map((r) => ({
    subject: r.subject == null ? '(no subject)' : String(r.subject),
    sender: r.sender == null ? '' : String(r.sender),
    sender_name: r.sender_name == null ? '' : String(r.sender_name),
    // date_sent is a plain Unix timestamp here, unlike the Core Data stores.
    sent_at: r.date_sent ? new Date(Number(r.date_sent) * 1000) : null,
    mailbox: r.mailbox == null ? '' : String(r.mailbox),
  }))
}

async function probeUnavailable() {
  const saved = process.env.IRIS_MAIL_DB
  process.env.IRIS_MAIL_DB = '/nonexistent/Envelope Index'
  try {
    await searchEmails({ days: 1, limit: 1 })
    return { threw: false, message: 'returned normally — an unreadable index looked like an empty mailbox' }
  } catch (e) {
    return { threw: true, message: e.message }
  } finally {
    if (saved === undefined) delete process.env.IRIS_MAIL_DB
    else process.env.IRIS_MAIL_DB = saved
  }
}

module.exports = { searchEmails, probeUnavailable, storePath }
