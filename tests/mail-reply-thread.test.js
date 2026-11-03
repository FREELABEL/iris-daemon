/**
 * #189480 — replies sent through IRIS did not thread, and nothing off the Mac could read a body.
 *
 * /api/mail/send always did `make new outgoing message`: a brand-new email with a "Re:" typed
 * onto it at best. Threading lives in In-Reply-To / References headers, which Mail.app's
 * outgoing-message object cannot set — only Mail's own `reply` command produces them. So a
 * reply must be built FROM the original message, which means finding it by id.
 *
 * These tests run on Linux (no Mail.app, no sqlite3): they pin the pieces that decide whether
 * the AppleScript is correct and safe — the mailbox URL parse, the escaping, that `reply` is
 * used rather than a new message, and that an id can never carry SQL.
 */

const { test } = require('node:test')
const assert = require('node:assert')

const { parseMailboxUrl, buildReplyScript } = require('../lib/mail-reply')
const { messageByIdSql, searchSql } = require('../drivers/apple-mail-store')
const { parseEmlx } = require('../drivers/apple-mail-body')

// ── mailbox URL → account + mailbox path ────────────────────────────────────────────

test('Gmail All Mail URL decodes to the [Gmail]/All Mail path on its account', () => {
  const r = parseMailboxUrl('imap://61AFF9D2-9D89-4138-95BF-E6130AA96479/%5BGmail%5D/All%20Mail')
  assert.deepStrictEqual(r, { accountId: '61AFF9D2-9D89-4138-95BF-E6130AA96479', mailboxPath: '[Gmail]/All Mail' })
})

test('INBOX URL parses', () => {
  assert.deepStrictEqual(parseMailboxUrl('imap://72780A90-9AC4-477B-A0CF-3A79F22C5306/INBOX'), {
    accountId: '72780A90-9AC4-477B-A0CF-3A79F22C5306',
    mailboxPath: 'INBOX',
  })
})

test('a URL that is not account-scoped is refused, not guessed', () => {
  assert.throws(() => parseMailboxUrl('local://Drafts'), /cannot reply/i)
  assert.throws(() => parseMailboxUrl(''), /cannot reply/i)
})

// ── the reply script ────────────────────────────────────────────────────────────────

const base = {
  accountId: '72780A90-9AC4-477B-A0CF-3A79F22C5306',
  mailboxPath: 'INBOX',
  messageId: 380098,
  body: 'Thanks — happy to talk Tuesday.',
}

test('builds the reply FROM the original message with Mail\'s reply command — that is what threads it', () => {
  const s = buildReplyScript(base)
  // «class mssg» id N, NOT `message id N`: Mail's dictionary also has a `message id` PROPERTY (the
  // Message-ID header), so the plain form does not compile (-2741, measured on a real Mac).
  assert.match(s, /«class mssg» id 380098 of mailbox "INBOX" of \(first account whose id is "72780A90-9AC4-477B-A0CF-3A79F22C5306"\)/)
  assert.doesNotMatch(s, /whose id is 380098/, 'a whose-clause scans the mailbox — the 30s pathology')
  assert.match(s, /reply theMsg/)
  assert.doesNotMatch(s, /make new outgoing message/, 'a new outgoing message has no In-Reply-To and will not thread')
  assert.match(s, /send r/)
})

test('draft opens the reply instead of sending it', () => {
  const s = buildReplyScript({ ...base, draft: true })
  assert.doesNotMatch(s, /send r/)
  assert.match(s, /set visible of r to true/)
})

test('reply-all is passed to Mail, not reimplemented', () => {
  assert.match(buildReplyScript({ ...base, replyAll: true }), /with reply to all/)
  assert.doesNotMatch(buildReplyScript(base), /reply to all/)
})

test('quotes, backslashes and newlines in the body cannot break out of the AppleScript string', () => {
  const s = buildReplyScript({ ...base, body: 'He said "hi" \\ then left\n" & do shell script "rm -rf ~" & "' })
  // Every double quote inside the literal is escaped, so the injected `do shell script` stays text.
  const literal = s.match(/set content of r to "((?:[^"\\]|\\.)*)"/)
  assert.ok(literal, 'content literal must be a single well-formed string')
  assert.match(literal[1], /do shell script/)
})

test('a non-integer message id is refused before any script exists', () => {
  assert.throws(() => buildReplyScript({ ...base, messageId: '1 of every mailbox' }), /message id/i)
})

test('a sender address is set only when given, and escaped', () => {
  assert.doesNotMatch(buildReplyScript(base), /set sender/)
  assert.match(buildReplyScript({ ...base, fromAddress: 'me@x.com' }), /set sender of r to "me@x.com"/)
})

// ── the index: ids out, no SQL in ───────────────────────────────────────────────────

test('search returns the message id — a reply needs it, and the old search threw it away', () => {
  assert.match(searchSql({ from: '@', days: 7, limit: 5 }), /m\.ROWID\s+AS id/)
})

test('messageByIdSql accepts only a positive integer', () => {
  assert.match(messageByIdSql(380098), /WHERE m\.ROWID = 380098/)
  assert.throws(() => messageByIdSql('1 OR 1=1'), /message id/i)
  assert.throws(() => messageByIdSql(-4), /message id/i)
})

// ── bodies from .emlx ───────────────────────────────────────────────────────────────

test('parseEmlx returns the plain-text part and the Message-ID header', () => {
  const rfc =
    'Message-ID: <abc@mail.acme.com>\r\nSubject: Role\r\nContent-Type: multipart/alternative; boundary="b1"\r\n\r\n' +
    '--b1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nHi Alex,=0Awe have a role=\r\n for you.\r\n' +
    '--b1\r\nContent-Type: text/html\r\n\r\n<p>Hi Alex</p>\r\n--b1--\r\n'
  const emlx = Buffer.from(`${Buffer.byteLength(rfc)}\n${rfc}<?xml version="1.0"?><plist/>`)
  const r = parseEmlx(emlx)
  assert.strictEqual(r.messageIdHeader, '<abc@mail.acme.com>')
  assert.match(r.text, /we have a role for you\./)
  assert.doesNotMatch(r.text, /<p>/)
})

test('an HTML-only message is turned into text, not returned as markup', () => {
  const rfc = 'Content-Type: text/html\r\n\r\n<div>Hello<br>there &amp; welcome</div>'
  const r = parseEmlx(Buffer.from(`${Buffer.byteLength(rfc)}\n${rfc}`))
  assert.match(r.text, /Hello\nthere & welcome/)
})
