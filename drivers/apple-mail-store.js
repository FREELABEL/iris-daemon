/**
 * Apple Mail — direct read of the Envelope Index (+ the .emlx files for bodies).
 *
 * REPLACES `messages of inbox whose sender contains X`, which is the SAME whose-clause
 * pathology that made Calendar unusable (#178745): MEASURED at 30+ seconds here, hitting
 * the execFile timeout and returning a truncated dump of the AppleScript instead of mail.
 *
 * The Envelope Index is Mail.app's own SQLite catalogue (~697MB on this machine) and
 * answers the same question in ~0.28s. Needs Full Disk Access, which the capability probe
 * already checks.
 *
 * #189941 — what this file got wrong, measured 2026-10-19 against a lead with 5 inbound and
 * 3 outbound messages in `[Gmail]/All Mail`:
 *
 *   1. It matched the SENDER only. Outbound mail (us → lead) is a RECIPIENT match, so a
 *      lead's thread came back one-sided at best. `participant=` matches sender OR any
 *      recipient and says which (`direction`, `role`).
 *   2. `a.address LIKE '%x%'` is a substring: `hpk@m42.com` also matched
 *      `hpk@m42.com.evil.io`. A participant is matched as an ADDRESS (case-insensitive, with
 *      plus-tags folded), never as a substring.
 *   3. `%` and `_` in a query were LIKE wildcards. They are escaped now.
 *   4. Searching "khalsa" never looked at the display name. `from=` matches both.
 *   5. Gmail stores one message in All Mail AND INBOX/Sent, with the same `message_id` hash.
 *      Results are deduped on that hash (falling back to the row when Mail left it 0), and
 *      the limit is applied AFTER dedupe so duplicates cannot starve the result.
 *   6. A killed/timed-out sqlite3 has an empty stderr, so the old error took the last line
 *      of `err.message` — which is the last line of the SQL. Users saw
 *      "Mail index query failed:      LIMIT 5;". It now names the timeout.
 *   7. Bodies: the index has none, so `include_body` was silently ignored. They are read
 *      from the message's .emlx now (plain part preferred, HTML stripped as a fallback).
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')
const { tccDenialMessage } = require('../daemon/tcc-notice')

// Cold Envelope Index reads (first query after boot, ~700MB file not in page cache) were
// measured well past the old 20s. A timeout is reported as a timeout either way.
const QUERY_TIMEOUT_MS = Number(process.env.IRIS_MAIL_QUERY_TIMEOUT_MS || 45000)

// Mailboxes whose rows are not correspondence. Drafts were never sent; Trash/Spam/Junk are
// not a relationship signal; Outbox is mid-send and will reappear in Sent.
const NON_CORRESPONDENCE = /(^|\/)(drafts?|trash|deleted(%20| )(items|messages)|spam|junk(%20| )?(e-?mail)?|outbox|notes)(\/|$)/i

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

/** ~/Library/Mail/V10 — the directory the account folders (and .emlx files) live under. */
function mailRoot() {
  if (process.env.IRIS_MAIL_ROOT) return process.env.IRIS_MAIL_ROOT
  return path.dirname(path.dirname(storePath()))
}

/**
 * Turn a sqlite3 failure into a sentence. Never the SQL: a killed process has an EMPTY stderr,
 * and `err.message` is "Command failed: <the whole command line>", whose last line is the
 * last line of the query.
 */
function describeQueryFailure(err, stderr, timeoutMs) {
  if (err && (err.killed || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT')) {
    return `timed out after ${Math.round(timeoutMs / 1000)}s reading the Mail index (a cold first read of a large index can be slow — retry once)`
  }
  const lines = String(stderr || '').split('\n').map((l) => l.trim()).filter(Boolean)
  const real = lines.find((l) => /error|unable|no such|malformed|locked|denied|not authorized/i.test(l))
  if (real) return real.replace(/^(Parse|Runtime) error near line \d+:\s*/i, '')
  if (lines.length) return lines[0]
  return `sqlite3 exited ${err && err.code != null ? err.code : 'abnormally'}`
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
      return reject(new Error(tccDenialMessage('Mail')))
    }
    execFile('/usr/bin/sqlite3', ['-json', `file:${db}?immutable=1`, sql],
      { timeout: QUERY_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`Mail index query failed: ${describeQueryFailure(err, stderr, QUERY_TIMEOUT_MS)}`))
        try { resolve(stdout.trim() ? JSON.parse(stdout) : []) }
        catch (e) { reject(new Error(`Mail index returned unparseable output: ${e.message}`)) }
      })
  })
}

/** SQL string literal. */
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`
/** LIKE pattern for "contains s", with % _ and the escape char itself made literal. */
const likeContains = (s) => lit(`%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`) + " ESCAPE '\\'"

/**
 * The address forms that ARE this participant: exact (case-insensitive — the column is
 * COLLATE NOCASE) plus any plus-tag variant of the same mailbox. A plus-tagged lead address
 * also matches its base mailbox. Never a substring.
 */
function participantClause(participant) {
  const p = String(participant).trim().toLowerCase()
  const at = p.lastIndexOf('@')
  if (at <= 0) return `address = ${lit(p)}`
  const local = p.slice(0, at)
  const domain = p.slice(at + 1)
  const base = local.split('+')[0]
  const esc = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`)
  return `(address = ${lit(p)} OR address = ${lit(`${base}@${domain}`)} OR address LIKE ${lit(`${esc(base)}+%@${esc(domain)}`)} ESCAPE '\\')`
}

/** Mail V10 layout: Data/<digits of floor(rowid/1000), reversed>/Messages. */
function emlxSubdir(rowid) {
  const n = Math.floor(Number(rowid) / 1000)
  return n > 0 ? path.join('Data', ...String(n).split('').reverse(), 'Messages') : path.join('Data', 'Messages')
}

/** The .emlx for a row, or null. mailbox url → <root>/<account>/<seg>.mbox/…/<store-uuid>/Data/… */
function emlxPath(rowid, mailboxUrl) {
  let u
  try { u = new URL(mailboxUrl) } catch { return null }
  const acct = u.host || u.hostname
  if (!acct) return null
  const segs = decodeURIComponent(u.pathname).split('/').filter(Boolean)
  if (!segs.length) return null
  const mbox = path.join(mailRoot(), acct, ...segs.map((s) => `${s}.mbox`))
  let stores = []
  try { stores = fs.readdirSync(mbox, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return null }
  const sub = emlxSubdir(rowid)
  for (const st of [...stores.filter((s) => s !== 'Data'), '']) {
    for (const name of [`${rowid}.emlx`, `${rowid}.partial.emlx`]) {
      const p = path.join(mbox, st, sub, name)
      if (fs.existsSync(p)) return p
    }
  }
  return null
}

// ── Minimal RFC 822 / MIME reader — enough to get a readable body out of a .emlx ──

function splitHeaders(raw) {
  const m = /\r?\n\r?\n/.exec(raw)
  const head = m ? raw.slice(0, m.index) : raw
  const body = m ? raw.slice(m.index + m[0].length) : ''
  const headers = {}
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const k = line.slice(0, i).trim().toLowerCase()
    if (!(k in headers)) headers[k] = line.slice(i + 1).trim()
  }
  return { headers, body }
}

function param(value, name) {
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(value || '')
  return m ? (m[1] ?? m[2]) : null
}

function decodeBytes(binary, encoding) {
  const enc = String(encoding || '').toLowerCase()
  if (enc === 'base64') return Buffer.from(binary.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
  if (enc === 'quoted-printable') {
    const s = binary.replace(/=\r?\n/g, '')
    const out = []
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { out.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2 }
      else out.push(s.charCodeAt(i) & 0xff)
    }
    return Buffer.from(out)
  }
  return Buffer.from(binary, 'latin1')
}

function toText(buf, charset) {
  const cs = String(charset || 'utf-8').toLowerCase()
  try { return new TextDecoder(cs).decode(buf) } catch { return buf.toString('utf8') }
}

function stripHtml(html) {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
}

/** Depth-first: the first text/plain wins; else the first text/html, stripped. */
function extractBody(raw, depth = 0) {
  const { headers, body } = splitHeaders(raw)
  const ctype = headers['content-type'] || 'text/plain'
  const type = ctype.split(';')[0].trim().toLowerCase()
  if (type.startsWith('multipart/') && depth < 8) {
    const boundary = param(ctype, 'boundary')
    if (!boundary) return null
    const parts = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`))
    let html = null
    for (const part of parts) {
      if (!part.trim()) continue
      const got = extractBody(part, depth + 1)
      if (!got) continue
      if (got.type === 'text/plain') return got
      if (!html && got.type === 'text/html') html = got
    }
    return html
  }
  if (type !== 'text/plain' && type !== 'text/html') return null
  if (/attachment/i.test(headers['content-disposition'] || '')) return null
  const text = toText(decodeBytes(body, headers['content-transfer-encoding']), param(ctype, 'charset'))
  return { type, text: type === 'text/html' ? stripHtml(text) : text }
}

/** Read one message's body + Message-ID header from disk. Never throws. */
function readBody(rowid, mailboxUrls, maxBody) {
  for (const url of mailboxUrls) {
    const p = emlxPath(rowid, url)
    if (!p) continue
    try {
      let raw = fs.readFileSync(p).toString('latin1')
      const nl = raw.indexOf('\n')
      const len = parseInt(raw.slice(0, nl), 10)
      raw = Number.isFinite(len) && len > 0 ? raw.slice(nl + 1, nl + 1 + len) : raw.slice(nl + 1)
      const { headers } = splitHeaders(raw)
      const got = extractBody(raw)
      const text = got ? got.text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim() : ''
      return {
        body: text.slice(0, Math.max(1, maxBody)),
        message_id_header: headers['message-id'] || null,
        body_truncated: text.length > maxBody,
      }
    } catch (e) {
      return { body: null, body_error: `could not read the message file: ${e.message}` }
    }
  }
  return { body: null, body_error: 'message file not on disk (Mail has not downloaded this message)' }
}

/**
 * Search recent mail.
 *   from        — sender address OR display name contains this (escaped LIKE)
 *   participant — this address is the sender or ANY recipient; rows carry direction + role
 *   subject     — subject contains this
 * At least one of them is required. Bodies only with includeBody.
 */
async function searchEmails({ from = '', participant = '', subject = '', fromMe = false, days = 14, limit = 20, includeBody = false, maxBody = 4000 } = {}) {
  const lim = Math.max(1, Math.min(200, Math.floor(Number(limit) || 20)))
  const d = Math.max(1, Math.min(365, Math.floor(Number(days) || 14)))
  const f = String(from || '').trim()
  const p = String(participant || '').trim()
  const s = String(subject || '').trim()
  if (!f && !p && !s && !fromMe) throw new Error('from, participant, subject or from_me is required (an empty query would match every message)')

  const where = [`m.date_sent > strftime('%s','now') - ${d} * 86400`, 'm.deleted = 0']
  let pIds = null
  if (p) {
    pIds = `(SELECT ROWID FROM addresses WHERE ${participantClause(p)})`
    where.push(`(m.sender IN ${pIds} OR m.ROWID IN (SELECT message FROM recipients WHERE address IN ${pIds}))`)
  }
  if (f) where.push(`m.sender IN (SELECT ROWID FROM addresses WHERE address LIKE ${likeContains(f)} OR comment LIKE ${likeContains(f)})`)
  if (s) where.push(`m.subject IN (SELECT ROWID FROM subjects WHERE subject LIKE ${likeContains(s)})`)
  let own = null
  if (fromMe) {
    // #189942: what went OUT, from every account — Gmail's sent mail is an All Mail row with a
    // Sent label, never a Sent mailbox row, so "the Sent mailbox" alone misses all of it.
    own = await ownAddresses()
    if (own.size === 0) return []
    where.push(`m.sender IN (SELECT ROWID FROM addresses WHERE address IN (${[...own].map(lit).join(', ')}))`)
  }

  // Over-fetch: one Gmail message is up to ~4 rows (All Mail, INBOX, Sent, Important).
  const fetchN = Math.min(2000, lim * 6)
  const rows = await query(`
    SELECT m.ROWID      AS rowid,
           m.message_id AS mid,
           s.subject    AS subject,
           a.address    AS sender,
           a.comment    AS sender_name,
           m.date_sent  AS date_sent,
           mb.url       AS mailbox,
           (SELECT group_concat(mb2.url, char(10)) FROM labels l JOIN mailboxes mb2 ON mb2.ROWID = l.mailbox_id WHERE l.message_id = m.ROWID) AS labels,
           (SELECT json_group_array(json_object('t', r.type, 'a', ra.address))
              FROM recipients r JOIN addresses ra ON ra.ROWID = r.address WHERE r.message = m.ROWID) AS rcpts
           ${pIds ? `, (m.sender IN ${pIds}) AS p_is_sender` : ''}
      FROM messages m
      LEFT JOIN subjects  s  ON s.ROWID  = m.subject
      LEFT JOIN addresses a  ON a.ROWID  = m.sender
      LEFT JOIN mailboxes mb ON mb.ROWID = m.mailbox
     WHERE ${where.join(' AND ')}
     ORDER BY m.date_sent DESC
     LIMIT ${fetchN};
  `)

  if (p && !own) own = await ownAddresses()
  const pForms = p ? participantForms(p) : null

  const byKey = new Map()
  for (const r of rows) {
    const mailbox = r.mailbox == null ? '' : String(r.mailbox)
    const labels = r.labels ? String(r.labels).split('\n') : []
    if (NON_CORRESPONDENCE.test(mailbox) || labels.some((l) => /drafts?$/i.test(l))) continue
    const key = r.mid && String(r.mid) !== '0' ? `m${r.mid}` : `r${r.rowid}`
    const existing = byKey.get(key)
    if (existing) {
      if (!existing.mailboxes.includes(mailbox)) existing.mailboxes.push(mailbox)
      existing._rows.push({ rowid: r.rowid, mailbox })
      continue
    }
    let rc = []
    try { rc = JSON.parse(r.rcpts || '[]') } catch { /* keep [] */ }
    const list = (t) => rc.filter((x) => x.t === t && x.a).map((x) => String(x.a))
    const sender = r.sender == null ? '' : String(r.sender)
    const row = {
      id: r.rowid,
      message_id: r.mid && String(r.mid) !== '0' ? String(r.mid) : null,
      subject: r.subject == null ? '(no subject)' : String(r.subject),
      sender,
      sender_name: r.sender_name == null ? '' : String(r.sender_name),
      // date_sent is a plain Unix timestamp here, unlike the Core Data stores.
      sent_at: r.date_sent ? new Date(Number(r.date_sent) * 1000) : null,
      mailbox,
      mailboxes: [mailbox],
      to: list(0),
      cc: list(1),
      _rows: [{ rowid: r.rowid, mailbox }],
    }
    if (fromMe) row.from_me = true
    if (p) {
      const isSender = Number(r.p_is_sender) === 1
      const fromMe = own.has(sender.toLowerCase())
      row.from_me = fromMe
      row.role = isSender ? 'sender' : rc.filter((x) => pForms(String(x.a))).map((x) => ['to', 'cc', 'bcc'][x.t] || 'to').sort((a, b) => ['to', 'cc', 'bcc'].indexOf(a) - ['to', 'cc', 'bcc'].indexOf(b))[0] || 'to'
      row.direction = isSender ? 'inbound' : fromMe ? 'outbound' : 'other'
    }
    byKey.set(key, row)
  }

  const out = [...byKey.values()].slice(0, lim)
  for (const row of out) {
    if (includeBody) {
      let got = null
      for (const { rowid, mailbox } of row._rows) {
        got = readBody(rowid, [mailbox], Math.max(1, Math.floor(Number(maxBody) || 4000)))
        if (got.body !== null) break
      }
      Object.assign(row, got)
    }
    delete row._rows
  }
  return out
}

function participantForms(p) {
  const lower = String(p).trim().toLowerCase()
  const at = lower.lastIndexOf('@')
  const base = at > 0 ? lower.slice(0, at).split('+')[0] : lower
  const domain = at > 0 ? lower.slice(at + 1) : ''
  return (addr) => {
    const a = String(addr || '').toLowerCase()
    if (a === lower) return true
    if (!domain) return false
    const i = a.lastIndexOf('@')
    return i > 0 && a.slice(i + 1) === domain && a.slice(0, i).split('+')[0] === base
  }
}

/**
 * Addresses this Mac sends AS: senders of anything in a Sent mailbox, or carrying a Sent label
 * (Gmail keeps sent mail in All Mail with only a label). Cached for 5 minutes.
 */
let ownCache = null
async function ownAddresses() {
  if (ownCache && Date.now() - ownCache.at < 5 * 60 * 1000) return ownCache.set
  const rows = await query(`
    SELECT DISTINCT lower(a.address) AS address FROM messages m
      JOIN addresses a ON a.ROWID = m.sender
     WHERE m.mailbox IN (SELECT ROWID FROM mailboxes WHERE url LIKE '%Sent%')
        OR m.ROWID IN (SELECT l.message_id FROM labels l WHERE l.mailbox_id IN (SELECT ROWID FROM mailboxes WHERE url LIKE '%Sent%'));
  `)
  const set = new Set(rows.map((r) => String(r.address || '')).filter(Boolean))
  ownCache = { at: Date.now(), set }
  return set
}

async function probeUnavailable() {
  const saved = process.env.IRIS_MAIL_DB
  process.env.IRIS_MAIL_DB = '/nonexistent/Envelope Index'
  try {
    await searchEmails({ subject: 'probe', days: 1, limit: 1 })
    return { threw: false, message: 'returned normally — an unreadable index looked like an empty mailbox' }
  } catch (e) {
    return { threw: true, message: e.message }
  } finally {
    if (saved === undefined) delete process.env.IRIS_MAIL_DB
    else process.env.IRIS_MAIL_DB = saved
  }
}

module.exports = { searchEmails, probeUnavailable, storePath, describeQueryFailure, emlxSubdir, emlxPath, extractBody }
