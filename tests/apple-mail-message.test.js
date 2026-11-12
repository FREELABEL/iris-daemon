'use strict'

/**
 * GET /api/mail/message?id=<rowid> in daemon-only mode: a Mail index id reads the index and the
 * .emlx directly. It used to go to Mail.app's AppleScript lookup, which only knows RFC
 * Message-IDs: `iris mail read 387748` hung for 120 s and failed (2026-11-11).
 */

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const UUID = '64981EAD-E892-4FAA-8D4B-EB65A869DD5C'

function fixture () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-msg-'))
  const v10 = path.join(root, 'V10')
  fs.mkdirSync(path.join(v10, 'MailData'), { recursive: true })
  const db = path.join(v10, 'MailData', 'Envelope Index')
  execFileSync('/usr/bin/sqlite3', [db, `
    CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY, subject TEXT);
    CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY, address TEXT, comment TEXT);
    CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT);
    CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, subject INTEGER, sender INTEGER, mailbox INTEGER, date_sent INTEGER);
    INSERT INTO subjects VALUES (1, 'We''re ready to repair your device!');
    INSERT INTO addresses VALUES (1, 'asurion-reply@notification.asurion.com', 'Asurion for AT&T');
    INSERT INTO mailboxes VALUES (1, 'imap://${UUID}/INBOX');
    INSERT INTO messages VALUES (387748, 1, 1, 1, 1762817463);
    INSERT INTO messages VALUES (387749, 1, 1, 1, 1762817463);
  `])
  // floor(387748 / 1000) = 387, digits reversed → Data/7/8/3/Messages
  const dir = path.join(v10, UUID, 'INBOX.mbox', 'Data', '7', '8', '3', 'Messages')
  fs.mkdirSync(dir, { recursive: true })
  const mime = [
    'From: Asurion for AT&T <asurion-reply@notification.asurion.com>',
    'Subject: We\'re ready to repair your device!',
    'Message-ID: <abc@asurion.com>',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Come on in. &zwnj; &zwnj; &zwnj;</p><p>Your claim is approved&mdash;come on in!</p>',
    '',
  ].join('\r\n')
  fs.writeFileSync(path.join(dir, '387748.emlx'), `${Buffer.byteLength(mime)}\n${mime}<?xml version="1.0"?><plist></plist>`)
  return db
}

test('a row id is told apart from an RFC Message-ID', () => {
  const { isRowId } = require('../drivers/apple-mail-message')
  assert.equal(isRowId('387748'), true)
  assert.equal(isRowId(387748), true)
  assert.equal(isRowId('<abc@asurion.com>'), false)
  assert.equal(isRowId('abc@asurion.com'), false)
  assert.equal(isRowId('0'), false)
  assert.equal(isRowId(''), false)
  assert.equal(isRowId(undefined), false)
})

test('a row id answers with envelope and body, read from disk, with no invisible padding', async () => {
  process.env.IRIS_MAIL_DB = fixture()
  try {
    const { readMessage } = require('../drivers/apple-mail-message')
    const out = await readMessage('387748', 4000)
    assert.equal(out.status, 200)
    assert.equal(out.body.subject, "We're ready to repair your device!")
    assert.equal(out.body.sender, 'asurion-reply@notification.asurion.com')
    assert.match(out.body.body, /Your claim is approved—come on in!/)
    assert.doesNotMatch(out.body.body, /&zwnj;|‌/)

    const missing = await readMessage('387749', 4000)
    assert.equal(missing.status, 200)
    assert.equal(missing.body.body, null)
    assert.match(missing.body.body_error, /No \.emlx on disk/)

    assert.equal((await readMessage('5', 4000)).status, 404)
  } finally {
    delete process.env.IRIS_MAIL_DB
  }
})

test('each server registers GET /api/mail/message exactly once — a second route never runs', () => {
  // Express answers with the FIRST matching route. A second registration on the same path is
  // dead code that looks like a fix: that is how the .emlx reader sat unused (2026-11-11).
  const count = (file, re) => (fs.readFileSync(path.join(__dirname, '..', file), 'utf-8').match(re) || []).length
  assert.equal(count('index.js', /app\.get\(\s*'\/api\/mail\/message'/g), 1)
  assert.equal(count('daemon/index.js', /app\.get\(\s*`\$\{prefix\}\/api\/mail\/message`/g), 1)
})
