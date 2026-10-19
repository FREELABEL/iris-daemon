'use strict'
/**
 * Apple Mail Envelope Index reader — #189941.
 *
 * Built against a FIXTURE index (real sqlite3, same table shapes as Mail's V10 Envelope Index)
 * so it runs anywhere and never touches a real mailbox. The fixture mirrors what was measured
 * on 2026-10-19: Gmail keeps everything in `[Gmail]/All Mail`, the same message also shows up
 * in INBOX / Sent with the same `message_id` hash, and outbound Gmail mail is NOT in a Sent
 * mailbox row at all — only a label.
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const ACCT = 'E5D72C1C-0B2A-45CF-BB6F-5AC38DD30382'
const ALLMAIL = `imap://${ACCT}/%5BGmail%5D/All%20Mail`
const INBOX = `imap://${ACCT}/INBOX`
const SENT = `imap://${ACCT}/%5BGmail%5D/Sent%20Mail`
const DRAFTS = `imap://${ACCT}/%5BGmail%5D/Drafts`
const now = Math.floor(Date.now() / 1000)
const hoursAgo = (h) => now - h * 3600

function build() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailidx-'))
  const db = path.join(dir, 'Envelope Index')
  const q = (s) => String(s).replace(/'/g, "''")
  const sql = [
    `CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT COLLATE NOCASE NOT NULL, comment TEXT NOT NULL, UNIQUE(address, comment));`,
    `CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY, subject TEXT);`,
    `CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT);`,
    `CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, message_id INTEGER NOT NULL DEFAULT 0, global_message_id INTEGER NOT NULL DEFAULT 0, sender INTEGER, subject INTEGER NOT NULL, date_sent INTEGER, date_received INTEGER, mailbox INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);`,
    `CREATE TABLE recipients (ROWID INTEGER PRIMARY KEY, message INTEGER NOT NULL, address INTEGER NOT NULL, type INTEGER, position INTEGER);`,
    `CREATE TABLE labels (message_id INTEGER, mailbox_id INTEGER, PRIMARY KEY(message_id, mailbox_id)) WITHOUT ROWID;`,
  ]
  const mbs = [ALLMAIL, INBOX, SENT, DRAFTS]
  mbs.forEach((u, i) => sql.push(`INSERT INTO mailboxes VALUES (${i + 1}, '${q(u)}');`))
  const mb = (u) => mbs.indexOf(u) + 1
  const addrs = [
    ['hpk@m42.com', 'Haripurkh Khalsa'], // 1
    ['alex@freelabel.net', 'Alex Mayo'], // 2
    ['dc@m42.com', 'Darren Cummings'], // 3
    ['dave@constellation.io', 'Dave'], // 4
    ['HPK+news@M42.com', 'Haripurkh Khalsa'], // 5 plus-tag + uppercase
    ['', 'Display Name Only'], // 6 display-name-only sender
    ["o'brien%_x@odd.io", "O'Brien; DROP TABLE"], // 7 hostile characters
    ['hpk@m42.com.evil.io', 'Lookalike'], // 8 must NOT match hpk@m42.com
    ['amayo@mypathwaysai.com', 'Alex Mayo'], // 9 a Gmail account whose sent mail is ONLY a labelled All Mail row
  ]
  addrs.forEach(([a, c], i) => sql.push(`INSERT INTO addresses VALUES (${i + 1}, '${q(a)}', '${q(c)}');`))
  const subj = ['Following up', 'Iris demo and discussion', 'Re: Iris demo and discussion', 'Gate pilots', 'Newsletter', 'Hello from nobody', "100% ready; it's_done", 'Draft reply', 'Phish']
  subj.forEach((s, i) => sql.push(`INSERT INTO subjects VALUES (${i + 1}, '${q(s)}');`))
  const msg = (rowid, mid, sender, subject, h, mailbox) =>
    sql.push(`INSERT INTO messages (ROWID, message_id, global_message_id, sender, subject, date_sent, date_received, mailbox) VALUES (${rowid}, ${mid}, ${rowid}, ${sender}, ${subject}, ${hoursAgo(h)}, ${hoursAgo(h)}, ${mb(mailbox)});`)
  const rcpt = (message, address, type, pos = 0) => sql.push(`INSERT INTO recipients (message, address, type, position) VALUES (${message}, ${address}, ${type}, ${pos});`)
  const label = (message, mailbox) => sql.push(`INSERT INTO labels VALUES (${message}, ${mb(mailbox)});`)

  // Inbound from hpk, in All Mail AND INBOX (same message_id hash) — must count once.
  msg(1001, 111, 1, 1, 120, ALLMAIL); rcpt(1001, 2, 0)
  msg(1002, 111, 1, 1, 120, INBOX); rcpt(1002, 2, 0)
  // Inbound from hpk, All Mail only (archived) — the case that used to vanish.
  msg(1003, 222, 1, 2, 72, ALLMAIL); rcpt(1003, 2, 0)
  // Outbound alex → hpk: in All Mail with a Sent label, AND as a Sent mailbox row. Count once.
  msg(1004, 333, 2, 3, 70, ALLMAIL); rcpt(1004, 1, 0); label(1004, SENT)
  msg(1005, 333, 2, 3, 70, SENT); rcpt(1005, 1, 0)
  // Third party → dc (to) + hpk (cc): neither inbound from nor outbound to the lead.
  msg(1006, 444, 4, 4, 50, ALLMAIL); rcpt(1006, 3, 0); rcpt(1006, 1, 1, 1)
  // Plus-tag uppercase variant of the lead's address.
  msg(1007, 555, 5, 5, 30, ALLMAIL); rcpt(1007, 2, 0)
  // Display-name-only sender.
  msg(1008, 666, 6, 6, 20, INBOX); rcpt(1008, 2, 0)
  // Hostile characters in address + subject.
  msg(1009, 777, 7, 7, 10, INBOX); rcpt(1009, 2, 0)
  // A draft to hpk — never sent, never counted.
  msg(1010, 888, 2, 8, 5, DRAFTS); rcpt(1010, 1, 0)
  // Lookalike domain — a substring match would wrongly attribute this to hpk.
  msg(1011, 999, 8, 9, 4, INBOX); rcpt(1011, 2, 0)
  // Old message, outside a 30-day window.
  msg(1012, 1212, 1, 1, 24 * 60, ALLMAIL); rcpt(1012, 2, 0)
  // message_id 0 (Mail did not hash it) — dedupe must fall back to the row, not collapse all zeros.
  msg(1013, 0, 1, 4, 3, INBOX); rcpt(1013, 2, 0)
  msg(1014, 0, 1, 5, 2, INBOX); rcpt(1014, 2, 0)
  // Sent from a second Gmail account: no Sent mailbox row exists, only the label.
  msg(1015, 1515, 9, 4, 1, ALLMAIL); rcpt(1015, 3, 0); label(1015, SENT)
  // Two DIFFERENT messages whose 64-bit hashes are equal once rounded to a JS number.
  msg(1016, '5138336715160088001', 1, 5, 300, INBOX); rcpt(1016, 2, 0)
  msg(1017, '5138336715160088002', 1, 6, 300, INBOX); rcpt(1017, 2, 0)

  execFileSync('/usr/bin/sqlite3', [db, sql.join('\n')])

  // A real-shaped .emlx for 1003 (All Mail): multipart/alternative, quoted-printable plain part.
  const root = path.join(dir, 'V10')
  const msgDir = path.join(root, ACCT, '[Gmail].mbox', 'All Mail.mbox', '7F9861D9-E397-4EBA-9582-83151CEFE4A9', 'Data', '1', 'Messages')
  fs.mkdirSync(msgDir, { recursive: true })
  const rfc = [
    'From: Haripurkh Khalsa <hpk@m42.com>',
    'To: alex@freelabel.net',
    'Subject: Iris demo and discussion',
    'Message-ID: <abc123@m42.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Hi Alex, can we do the demo this week? Caf=C3=A9 at 10 works =',
    'for me.',
    '--b1',
    'Content-Type: text/html; charset="utf-8"',
    '',
    '<p>Hi Alex</p>',
    '--b1--',
    '',
  ].join('\r\n')
  fs.writeFileSync(path.join(msgDir, '1003.emlx'), `${Buffer.byteLength(rfc)}\n${rfc}<?xml version="1.0"?><plist></plist>`)
  // An HTML-only, base64 message for 1001 lives in Data/1/Messages too.
  const html = Buffer.from('<html><body><p>Following&nbsp;up on <b>Gate</b></p><style>p{}</style></body></html>').toString('base64')
  const rfc2 = ['From: hpk@m42.com', 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', html, ''].join('\n')
  fs.writeFileSync(path.join(msgDir, '1001.partial.emlx'), `${Buffer.byteLength(rfc2)}\n${rfc2}`)

  process.env.IRIS_MAIL_DB = db
  process.env.IRIS_MAIL_ROOT = root
  for (const k of Object.keys(require.cache)) if (k.includes('apple-mail-store')) delete require.cache[k]
  return require('../drivers/apple-mail-store')
}

const store = build()

test('participant search finds inbound AND outbound for a lead, across All Mail, counted once', async () => {
  const rows = await store.searchEmails({ participant: 'hpk@m42.com', days: 30, limit: 50 })
  const subjects = rows.map((r) => `${r.direction}:${r.subject}`)
  // 1001/1002 collapse to one; 1004/1005 collapse to one; draft 1010 and lookalike 1011 excluded.
  assert.deepStrictEqual(rows.filter((r) => r.message_id === '111').length, 1, subjects.join(' | '))
  assert.deepStrictEqual(rows.filter((r) => r.message_id === '333').length, 1, subjects.join(' | '))
  assert.ok(rows.some((r) => r.subject === 'Iris demo and discussion' && r.direction === 'inbound'), 'archived All Mail inbound missing')
  const out = rows.find((r) => r.message_id === '333')
  assert.strictEqual(out.direction, 'outbound')
  assert.strictEqual(out.from_me, true)
  assert.ok(!rows.some((r) => r.subject === 'Draft reply'), 'a draft was counted as sent')
  assert.ok(!rows.some((r) => r.subject === 'Phish'), 'lookalike domain matched by substring')
  assert.ok(!rows.some((r) => r.message_id === '1212'), 'outside the window')
})

test('the duplicate keeps every mailbox it was seen in', async () => {
  const rows = await store.searchEmails({ participant: 'hpk@m42.com', days: 30, limit: 50 })
  const dup = rows.find((r) => r.message_id === '111')
  assert.deepStrictEqual([...dup.mailboxes].sort(), [ALLMAIL, INBOX].sort())
})

test('a cc on a third-party thread is neither inbound nor outbound', async () => {
  const rows = await store.searchEmails({ participant: 'hpk@m42.com', days: 30, limit: 50 })
  const third = rows.find((r) => r.message_id === '444')
  assert.ok(third, 'third-party thread missing')
  assert.strictEqual(third.direction, 'other')
  assert.strictEqual(third.role, 'cc')
  assert.deepStrictEqual(third.cc, ['hpk@m42.com'])
})

test('plus-tags and case do not hide the lead', async () => {
  const a = await store.searchEmails({ participant: 'HPK@M42.COM', days: 30, limit: 50 })
  assert.ok(a.some((r) => r.message_id === '555' && r.direction === 'inbound'), 'HPK+news@M42.com not matched')
  const b = await store.searchEmails({ participant: 'hpk+crm@m42.com', days: 30, limit: 50 })
  assert.ok(b.some((r) => r.message_id === '222'), 'a plus-tagged lead address must still find the base mailbox')
})

test('64-bit message hashes keep full precision — two messages never collapse into one', async () => {
  const rows = await store.searchEmails({ participant: 'hpk@m42.com', days: 30, limit: 50 })
  const ids = rows.map((r) => r.message_id)
  assert.ok(ids.includes('5138336715160088001') && ids.includes('5138336715160088002'), ids.join(','))
})

test('message_id 0 never collapses unrelated messages', async () => {
  const rows = await store.searchEmails({ participant: 'hpk@m42.com', days: 30, limit: 50 })
  assert.strictEqual(rows.filter((r) => r.subject === 'Gate pilots' || r.subject === 'Newsletter').length >= 3, true)
})

test('from= matches the display name, not only the address ("khalsa")', async () => {
  const rows = await store.searchEmails({ from: 'khalsa', days: 30, limit: 50 })
  assert.ok(rows.length >= 2, `got ${rows.length}`)
  const named = await store.searchEmails({ from: 'Display Name Only', days: 30, limit: 5 })
  assert.strictEqual(named.length, 1)
  assert.strictEqual(named[0].sender, '')
})

test('subject-only search works with no sender', async () => {
  const rows = await store.searchEmails({ subject: 'iris demo', days: 30, limit: 50 })
  assert.ok(rows.length >= 2)
  assert.ok(rows.every((r) => /iris demo/i.test(r.subject)))
})

test('hostile query text is data, never SQL — and % _ are literal', async () => {
  for (const q of ["o'brien", "'; DROP TABLE messages; --", '"quoted"', '%', '_', '\\', 'a;b', '%_x', '100%']) {
    const rows = await store.searchEmails({ from: q, days: 30, limit: 5 })
    assert.ok(Array.isArray(rows), q)
  }
  assert.strictEqual((await store.searchEmails({ from: '%', days: 30, limit: 50 })).length, 1, '% must match only the address containing a literal %')
  assert.strictEqual((await store.searchEmails({ subject: '100%', days: 30, limit: 50 })).length, 1)
  assert.strictEqual((await store.searchEmails({ subject: 'Gate_pilots', days: 30, limit: 50 })).length, 0, '_ must not be a wildcard')
  // The table is still there.
  assert.ok((await store.searchEmails({ participant: 'hpk@m42.com', days: 30, limit: 5 })).length > 0)
})

test('an empty or whitespace query is refused, not turned into "match everything"', async () => {
  await assert.rejects(() => store.searchEmails({ from: '   ', days: 30, limit: 5 }), /required/)
  await assert.rejects(() => store.searchEmails({ days: 30, limit: 5 }), /required/)
})

test('a killed or timed-out query names the timeout, never the tail of the SQL (the "LIMIT 5;" bug)', () => {
  const err = Object.assign(new Error('Command failed: /usr/bin/sqlite3 -json file:x\n  SELECT 1\n     LIMIT 5;'), { killed: true, signal: 'SIGTERM' })
  const msg = store.describeQueryFailure(err, '', 20000)
  assert.match(msg, /timed out after 20s/)
  assert.doesNotMatch(msg, /LIMIT/)
  const parse = store.describeQueryFailure(Object.assign(new Error('Command failed'), { code: 1 }), 'Parse error near line 3: no such column: x\n  LIMIT 5;\n   ^--- error here\n', 20000)
  assert.match(parse, /no such column/)
  assert.doesNotMatch(parse, /LIMIT/)
})

test('include_body reads the .emlx: quoted-printable plain part, utf-8, soft line breaks', async () => {
  const rows = await store.searchEmails({ participant: 'hpk@m42.com', days: 30, limit: 50, includeBody: true })
  const r = rows.find((x) => x.message_id === '222')
  assert.strictEqual(r.body, 'Hi Alex, can we do the demo this week? Café at 10 works for me.')
  assert.strictEqual(r.message_id_header, '<abc123@m42.com>')
})

test('include_body falls back to stripped HTML, decodes base64, finds .partial.emlx', async () => {
  const rows = await store.searchEmails({ participant: 'hpk@m42.com', days: 30, limit: 50, includeBody: true })
  const r = rows.find((x) => x.message_id === '111')
  assert.strictEqual(r.body, 'Following up on Gate')
})

test('a message whose file is missing says so instead of an empty body', async () => {
  const rows = await store.searchEmails({ participant: 'hpk@m42.com', days: 30, limit: 50, includeBody: true })
  const r = rows.find((x) => x.message_id === '555')
  assert.strictEqual(r.body, null)
  assert.match(r.body_error, /not on disk/)
})

test('max_body truncates', async () => {
  const rows = await store.searchEmails({ participant: 'hpk@m42.com', days: 30, limit: 50, includeBody: true, maxBody: 6 })
  assert.strictEqual(rows.find((x) => x.message_id === '222').body, 'Hi Ale')
})

test('emlx path layout matches Mail V10 (rowid/1000 digits, reversed)', () => {
  assert.strictEqual(store.emlxSubdir(385872), path.join('Data', '5', '8', '3', 'Messages'))
  assert.strictEqual(store.emlxSubdir(999), path.join('Data', 'Messages'))
  assert.strictEqual(store.emlxSubdir(1003), path.join('Data', '1', 'Messages'))
})

test('limit applies AFTER dedupe so duplicates cannot starve the result', async () => {
  const rows = await store.searchEmails({ participant: 'hpk@m42.com', days: 30, limit: 6 })
  assert.strictEqual(rows.length, 6)
  assert.strictEqual(new Set(rows.map((r) => r.id)).size, 6)
  assert.ok(rows.some((r) => r.message_id === '222'), 'a duplicate row took the last slot')
})

// ── The HTTP handler index.js mounts ──
function call(query) {
  const { mailSearchHandler } = require('../drivers/apple-mail-route')
  return new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this }, json(b) { resolve({ code: this.code, body: b }) } }
    mailSearchHandler()({ query }, res)
  })
}

test('route: participant= returns both directions, recipients and capabilities', async () => {
  const { code, body } = await call({ participant: 'hpk@m42.com', days: '30', limit: '50' })
  assert.strictEqual(code, 200)
  assert.ok(body.capabilities.includes('participant'))
  const dirs = new Set(body.emails.map((e) => e.direction))
  assert.ok(dirs.has('inbound') && dirs.has('outbound'), [...dirs].join(','))
  assert.ok(body.emails.every((e) => Array.isArray(e.to) && Array.isArray(e.mailboxes)))
})

test('route: include_body=1 returns bodies; without it, no body key', async () => {
  const withBody = await call({ participant: 'hpk@m42.com', days: '30', limit: '50', include_body: '1' })
  assert.ok(withBody.body.emails.some((e) => typeof e.body === 'string' && e.body.length > 0))
  const without = await call({ participant: 'hpk@m42.com', days: '30', limit: '50' })
  assert.ok(without.body.emails.every((e) => !('body' in e)))
})

test('route: an empty / whitespace query is a 400, not every message', async () => {
  assert.strictEqual((await call({ from: '  ' })).code, 400)
  assert.strictEqual((await call({})).code, 400)
})

// #189942 — `iris mail audit` reconciles what went OUT against the comms ledger. It needs the
// Sent side of every account, including Gmail, which keeps sent mail in All Mail with a label.
test('from_me=1 returns what this Mac sent — Gmail labelled-Sent included, drafts excluded, deduped', async () => {
  const rows = await store.searchEmails({ fromMe: true, days: 30, limit: 50 })
  assert.deepStrictEqual(rows.map((r) => r.message_id), ['1515', '333'])
  assert.deepStrictEqual(rows[1].to, ['hpk@m42.com'])
  assert.deepStrictEqual(rows[0].to, ['dc@m42.com'])
  assert.ok(rows.every((r) => r.from_me === true))
})

test('route: from_me=1 is accepted alone (no from/subject needed)', async () => {
  const { code, body } = await call({ from_me: '1', days: '30', limit: '10' })
  assert.strictEqual(code, 200)
  assert.ok(body.capabilities.includes('from_me'))
  assert.strictEqual(body.emails.length, 2)
})
