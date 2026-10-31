/**
 * Apple Mail — one message's BODY, from its .emlx file (#189480).
 *
 * The Envelope Index holds envelopes only, so /api/mail/search could never return a body and
 * nothing off the Mac could read one. Answering a recruiter starts with reading what they
 * wrote, so this exists.
 *
 * Ported from the CLI's reader (packages/opencode/src/cli/lib/apple-mail.ts). They run in
 * different processes with different Full Disk Access grants, which is why there are two;
 * keep the parsing rules in step. Never read the index's `summaries` column instead — it is
 * capped at 1000 characters and looks like a body (#183189).
 */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { storePath } = require('./apple-mail-store')

/** ~/Library/Mail/V10 — the directory holding MailData and the account folders. */
function mailRoot () {
  return path.dirname(path.dirname(storePath()))
}

/** Mail's fan-out: floor(rowid/1000), digits REVERSED. 380098 → Data/0/8/3/Messages. */
function shardSegments (rowid) {
  return String(Math.floor(rowid / 1000)).split('').reverse()
}

/** `imap://<UUID>/%5BGmail%5D/All%20Mail` → `<root>/<UUID>/[Gmail].mbox/All Mail.mbox` */
function mailboxDir (mailboxUrl) {
  const m = String(mailboxUrl || '').match(/^[a-z0-9+.-]+:\/\/([^/]+)\/?(.*)$/i)
  if (!m || !/^[0-9A-F-]{36}$/i.test(m[1])) return null
  const segs = (m[2] ? m[2].split('/') : [])
    .filter(Boolean)
    .map((s) => { try { return decodeURIComponent(s) } catch { return s } })
    .filter((s) => s !== '.' && s !== '..' && !s.includes(path.sep))
  return path.join(mailRoot(), m[1], ...segs.map((s) => `${s}.mbox`))
}

function locate (rowid, mailboxUrl) {
  const dir = mailboxDir(mailboxUrl)
  if (!dir) return null
  const bases = [dir]
  try {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory() && /^[0-9A-F-]{36}$/i.test(d.name)) bases.push(path.join(dir, d.name))
    }
  } catch { /* unreadable — the find below reports it */ }
  const tail = path.join('Data', ...shardSegments(rowid), 'Messages')
  for (const b of bases) {
    for (const name of [`${rowid}.emlx`, `${rowid}.partial.emlx`]) {
      const p = path.join(b, tail, name)
      if (fs.existsSync(p)) return p
    }
  }
  try {
    const found = execFileSync('/usr/bin/find', [dir, '-name', `${rowid}.emlx`, '-o', '-name', `${rowid}.partial.emlx`],
      { encoding: 'utf-8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 })
      .split('\n').map((s) => s.trim()).filter(Boolean)
    return found[0] || null
  } catch {
    return null
  }
}

/** .emlx = `<byte-count>\n<rfc822 message><plist>`. */
function stripEmlxEnvelope (raw) {
  const nl = raw.indexOf(0x0a)
  if (nl > 0 && nl < 32) {
    const n = parseInt(raw.subarray(0, nl).toString('ascii').trim(), 10)
    if (Number.isFinite(n) && n > 0 && nl + 1 + n <= raw.length) return raw.subarray(nl + 1, nl + 1 + n)
  }
  const plist = raw.indexOf(Buffer.from('\n<?xml'))
  return plist > 0 ? raw.subarray(nl + 1, plist) : raw.subarray(nl + 1)
}

function splitEntity (buf) {
  let idx = buf.indexOf(Buffer.from('\r\n\r\n'))
  let gap = 4
  const alt = buf.indexOf(Buffer.from('\n\n'))
  if (idx === -1 || (alt !== -1 && alt < idx)) { idx = alt; gap = 2 }
  if (idx === -1) return { headers: {}, body: buf }
  const headers = {}
  const raw = buf.subarray(0, idx).toString('latin1').replace(/\r?\n[ \t]+/g, ' ')
  for (const line of raw.split(/\r?\n/)) {
    const c = line.indexOf(':')
    if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim()
  }
  return { headers, body: buf.subarray(idx + gap) }
}

function decodePart (body, headers, charset) {
  const cte = String(headers['content-transfer-encoding'] || '').trim().toLowerCase()
  let bytes = body
  if (cte === 'quoted-printable') {
    bytes = Buffer.from(body.toString('latin1').replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1')
  } else if (cte === 'base64') {
    bytes = Buffer.from(body.toString('ascii').replace(/\s+/g, ''), 'base64')
  }
  // us-ascii is routinely a lie on real mail; utf-8 decodes true ascii identically.
  const cs = String(charset || 'utf-8').toLowerCase().replace(/^us-ascii$/, 'utf-8')
  try { return new TextDecoder(cs, { fatal: false }).decode(bytes) } catch { /* unknown charset */ }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' }

function htmlToText (html) {
  return String(html)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|li|tr|h[1-6]|ul|ol|blockquote|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[String(n).toLowerCase()] || m)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const looksLikeHtml = (s) => /<(!doctype|html|body|div|p|table|h[1-6])[\s>]/i.test(s.slice(0, 2000))

function collectParts (buf, depth = 0) {
  if (depth > 8) return []
  const { headers, body } = splitEntity(buf)
  const ct = String(headers['content-type'] || 'text/plain')
  const type = ct.split(';')[0].trim().toLowerCase()
  const boundary = (ct.match(/boundary\s*=\s*"?([^";]+)"?/i) || [])[1]
  const charset = (ct.match(/charset\s*=\s*"?([^";]+)"?/i) || [])[1]
  if (type.startsWith('multipart/') && boundary) {
    const out = []
    for (const chunk of body.toString('latin1').split(`--${boundary}`).slice(1)) {
      if (chunk.startsWith('--')) break
      out.push(...collectParts(Buffer.from(chunk.replace(/^\r?\n/, ''), 'latin1'), depth + 1))
    }
    return out
  }
  if (/^attachment/i.test(String(headers['content-disposition'] || ''))) return []
  if (type && !type.startsWith('text/') && depth > 0) return []
  const text = decodePart(body, headers, charset)
  if (!text.trim()) return []
  // Content-Type is not evidence: some senders' only part says text/plain and holds HTML.
  return [{ isHtml: type === 'text/html' || looksLikeHtml(text), text }]
}

/** Parse a raw .emlx buffer. Pure — tested without a Mac. */
function parseEmlx (raw) {
  const msg = stripEmlxEnvelope(raw)
  const { headers } = splitEntity(msg)
  const parts = collectParts(msg)
  const plain = parts.find((p) => !p.isHtml)
  const markup = parts.find((p) => p.isHtml)
  return {
    text: plain ? plain.text.trim() : markup ? htmlToText(markup.text) : '',
    html: markup ? markup.text : null,
    messageIdHeader: headers['message-id'] || null,
  }
}

/** Read one message's body off disk. Throws with a named reason when it cannot. */
function readBody (rowid, mailboxUrl) {
  const file = locate(rowid, mailboxUrl)
  if (!file) throw new Error(`No .emlx on disk for message ${rowid} — Mail may not have downloaded it yet`)
  const parsed = parseEmlx(fs.readFileSync(file))
  return { ...parsed, path: file, partial: /\.partial\.emlx$/.test(file) }
}

module.exports = { readBody, parseEmlx, htmlToText }
