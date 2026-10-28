const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  parseSendRequest,
  buildSendScript,
  describeSent,
  addressList,
  normalizeMessageId,
  lookupMessage,
  MAIL_MESSAGE_LOOKUP_JXA,
  CAPABILITIES,
} = require('../lib/mail-compose')

/**
 * #191605. The outgoing message — its recipients and how it threads — is the thing under test.
 * Nothing here runs osascript or touches Mail.app; lookupMessage is given a fake execFile.
 */

// One AppleScript string literal: "…" with \" and \\ escapes. Unescaping what the builder wrote
// and getting the original back is the proof that quoting held.
const LIT = '"((?:[^"\\\\]|\\\\.)*)"'
const unesc = (s) => s.replace(/\\(.)/g, '$1')
const literalsOf = (script, re) => [...script.matchAll(new RegExp(re, 'gm'))].map((m) => m.slice(1).map(unesc))

// The Vanguard reply-all that had to go out by raw osascript on 2026-10-28, with stand-in addresses.
const VANGUARD = {
  to_email: ['richard@vanguard.example', 'sean@vanguard.example'],
  cc_email: ['junaid@vanguard.example', 'robyn@vanguard.example', 'terry@vanguard.example'],
  from_email: 'amayo@mypathwaysai.com',
  subject: 'Re: Phase 1',
  body_text: 'Thanks all — notes attached.',
  in_reply_to: '<CAF1234abc@mail.gmail.com>',
  reply_account: 'Pathways',
  reply_mailbox: 'INBOX',
}

describe('the Vanguard reply-all: two To, three CC, threaded on the original', () => {
  const { message, error } = parseSendRequest(VANGUARD)
  const script = buildSendScript(message, 'amayo@mypathwaysai.com')

  it('parses into one message with all five recipients', () => {
    assert.equal(error, undefined)
    assert.deepEqual(message.to, ['richard@vanguard.example', 'sean@vanguard.example'])
    assert.deepEqual(message.cc, ['junaid@vanguard.example', 'robyn@vanguard.example', 'terry@vanguard.example'])
  })

  it('the script adds every recipient exactly once, in order', () => {
    const to = literalsOf(script, `^  make new to recipient at end of to recipients of msg with properties \\{name:${LIT}, address:${LIT}\\}$`)
    const cc = literalsOf(script, `^  make new cc recipient at end of cc recipients of msg with properties \\{address:${LIT}\\}$`)
    assert.deepEqual(to.map((t) => t[1]), VANGUARD.to_email)
    assert.deepEqual(cc.map((c) => c[0]), VANGUARD.cc_email)
    assert.equal((script.match(/make new (to|cc|bcc) recipient/g) || []).length, 5)
  })

  it('threads with Mail.app `reply` on the original found by its Message-ID — not a new message', () => {
    assert.match(script, /^  set wantId to "CAF1234abc@mail\.gmail\.com"$/m)
    assert.match(script, /^  repeat with mb in \(mailboxes of account "Pathways"\)$/m)
    assert.match(script, /\(name of mb\) is "INBOX"/)
    assert.match(script, /^  set msg to reply orig without opening window$/m)
    assert.doesNotMatch(script, /make new outgoing message/)
    // `reply to all` would let Mail choose the recipients; the caller already chose them.
    assert.doesNotMatch(script, /reply to all/)
    // Mail's reply pre-fills recipients; they are cleared BEFORE the exact list is added.
    const clear = script.indexOf('delete every to recipient of msg')
    assert.ok(clear > script.indexOf('set msg to reply orig'))
    assert.ok(clear < script.indexOf('make new to recipient'))
    assert.match(script, /if orig is missing value then error .* number 1404/)
  })

  it('never searches the unified inbox or uses a whose-clause on message id', () => {
    assert.doesNotMatch(script, /whose message id/)
    assert.doesNotMatch(script, /messages of inbox/)
    assert.match(script, /whose date received > cutoff/)
  })

  it('sends from the resolved account, and sends (not a draft)', () => {
    assert.match(script, /^  set sender of msg to "amayo@mypathwaysai\.com"$/m)
    assert.match(script, /^  send msg$/m)
    assert.doesNotMatch(script, /set visible of msg to true/)
  })

  it('reports the In-Reply-To it threaded on', () => {
    assert.deepEqual(describeSent(message), {
      to: VANGUARD.to_email,
      cc: VANGUARD.cc_email,
      bcc: [],
      in_reply_to: '<CAF1234abc@mail.gmail.com>',
      threaded: 'mail.app-reply',
    })
  })
})

describe('recipients', () => {
  it('accepts comma-separated and repeated values, drops duplicates case-insensitively', () => {
    assert.deepEqual(addressList(['a@x.io, b@x.io', 'A@X.io', ' c@x.io ;d@x.io']), ['a@x.io', 'b@x.io', 'c@x.io', 'd@x.io'])
    assert.deepEqual(addressList(undefined), [])
    assert.deepEqual(addressList('one@x.io'), ['one@x.io'])
  })

  it('a person in To is not also CC or BCC; a CC is not also BCC', () => {
    const { message } = parseSendRequest({
      to_email: 'a@x.io', cc_email: ['A@x.io', 'b@x.io'], bcc_email: ['b@x.io', 'c@x.io', 'a@x.io'], subject: 's', body_text: 'b',
    })
    assert.deepEqual([message.to, message.cc, message.bcc], [['a@x.io'], ['b@x.io'], ['c@x.io']])
  })

  it('BCC is written as bcc recipients', () => {
    const { message } = parseSendRequest({ to_email: 'a@x.io', bcc_email: ['h1@x.io', 'h2@x.io'], subject: 's', body_text: 'b' })
    const bcc = literalsOf(buildSendScript(message), `^  make new bcc recipient at end of bcc recipients of msg with properties \\{address:${LIT}\\}$`)
    assert.deepEqual(bcc.map((b) => b[0]), ['h1@x.io', 'h2@x.io'])
  })

  it('refuses something that is not an address rather than handing it to Mail', () => {
    assert.match(parseSendRequest({ to_email: ['a@x.io', 'Richard Smith'], subject: 's', body_text: 'b' }).error, /not an email address: Richard Smith/)
    assert.match(parseSendRequest({ to_email: 'a@x.io", address:"evil@x.io', subject: 's', body_text: 'b' }).error, /not an email address/)
  })

  it('still requires a To, a subject and a body', () => {
    assert.match(parseSendRequest({ to_email: [], subject: 's', body_text: 'b' }).error, /required/)
    assert.match(parseSendRequest({ to_email: 'a@x.io', body_text: 'b' }).error, /required/)
  })

  it('the old single-To contract builds the same kind of message it always did', () => {
    const { message } = parseSendRequest({ to_email: 'a@x.io', to_name: 'Ann', cc_email: 'c@x.io', subject: 'Hi', body_text: 'Body' })
    const script = buildSendScript(message)
    assert.match(script, /^  set msg to make new outgoing message with properties \{subject:"Hi", content:"Body", visible:false\}$/m)
    assert.match(script, /\{name:"Ann", address:"a@x\.io"\}/)
    assert.match(script, /\{address:"c@x\.io"\}/)
    assert.doesNotMatch(script, /reply orig/)
  })

  it('a display name is only used when there is a single To', () => {
    const { message } = parseSendRequest({ to_email: ['a@x.io', 'b@x.io'], to_name: 'Ann', subject: 's', body_text: 'b' })
    assert.equal(message.toName, null)
  })
})

describe('quoting — data cannot break out of an AppleScript string', () => {
  const nasty = 'He said "send it" \\ then "end tell" — done'
  const { message } = parseSendRequest({ to_email: 'a@x.io', subject: nasty, body_text: `line 1\n${nasty}\nline 3`, attachments: ['/tmp/a "b".pdf'] })
  const script = buildSendScript(message)

  it('subject and body come back intact from their literals', () => {
    const [[subject, content]] = literalsOf(script, `^  set msg to make new outgoing message with properties \\{subject:${LIT}, content:${LIT}, visible:false\\}$`)
    assert.equal(subject, nasty)
    assert.equal(content, `line 1\n${nasty}\nline 3`)
  })

  it('an attachment path with quotes stays one path', () => {
    const [[fp]] = literalsOf(script, `^  make new attachment with properties \\{file name:POSIX file ${LIT}\\} at after the last paragraph of content of msg$`)
    assert.equal(fp, '/tmp/a "b".pdf')
  })

  it('the script still has exactly one tell block', () => {
    assert.equal((script.match(/^end tell$/gm) || []).length, 1)
  })

  it('reply fields are quoted too', () => {
    const r = parseSendRequest({ ...VANGUARD, reply_account: 'Work "Main"', reply_mailbox: 'A\\B', subject: 'Re: "x"' })
    const s = buildSendScript(r.message)
    assert.deepEqual(literalsOf(s, `^  repeat with mb in \\(mailboxes of account ${LIT}\\)$`), [['Work "Main"']])
    assert.deepEqual(literalsOf(s, `\\(name of mb\\) is ${LIT} then$`), [['A\\B']])
    assert.deepEqual(literalsOf(s, `^  set subject of msg to ${LIT}$`), [['Re: "x"']])
  })
})

describe('replies', () => {
  it('needs the account and mailbox the lookup returned — never a search over every mailbox', () => {
    const { error } = parseSendRequest({ ...VANGUARD, reply_account: undefined })
    assert.match(error, /reply_account and reply_mailbox/)
  })

  it('normalises the Message-ID forms people paste', () => {
    for (const v of ['<abc@x>', 'abc@x', 'rfc822_<abc@x>', '  <abc@x>  ']) assert.equal(normalizeMessageId(v), 'abc@x')
  })

  it('a draft reply opens the window and does not send', () => {
    const { message } = parseSendRequest({ ...VANGUARD, draft: true })
    const s = buildSendScript(message)
    assert.match(s, /set msg to reply orig with opening window/)
    assert.doesNotMatch(s, /^  send msg$/m)
  })

  it('capabilities advertise what a CLI must check before relying on it', () => {
    assert.deepEqual(
      { multi_to: CAPABILITIES.multi_to, bcc: CAPABILITIES.bcc, reply: CAPABILITIES.reply, message_lookup: CAPABILITIES.message_lookup },
      { multi_to: true, bcc: true, reply: true, message_lookup: true },
    )
  })
})

describe('GET /api/mail/message lookup (fake osascript)', () => {
  const fake = (stdout, err = null, stderr = '') => {
    const calls = []
    const fn = (file, args, opts, cb) => { calls.push({ file, args }); cb(err, stdout, stderr) }
    return { fn, calls }
  }

  it('passes the id as argv — never interpolated into the script', async () => {
    const { fn, calls } = fake(JSON.stringify({ ok: true, message_id: 'abc@x', account: 'Pathways', mailbox: 'INBOX', to: [], cc: [] }))
    const out = await lookupMessage(fn, { id: '<abc@x>', days: '30', account: 'Pathways' })
    assert.equal(out.status, 200)
    assert.deepEqual(calls[0].args, ['-l', 'JavaScript', '-e', MAIL_MESSAGE_LOOKUP_JXA, 'abc@x', '30', 'Pathways'])
    assert.ok(!MAIL_MESSAGE_LOOKUP_JXA.includes('abc@x'))
  })

  it('404 when Mail has no such message; 400 without an id; 403 on an Automation denial', async () => {
    assert.equal((await lookupMessage(fake(JSON.stringify({ ok: false })).fn, { id: 'x@y' })).status, 404)
    assert.equal((await lookupMessage(fake('').fn, {})).status, 400)
    assert.equal((await lookupMessage(fake('', new Error('x'), 'execution error: Not authorized (-1743)').fn, { id: 'x@y' })).status, 403)
  })

  it('the embedded reader parses and reads only INBOX / Sent / Archive, date-bounded, counting first', () => {
    assert.doesNotThrow(() => new Function(MAIL_MESSAGE_LOOKUP_JXA))
    assert.match(MAIL_MESSAGE_LOOKUP_JXA, /dateReceived: \{ ">": cutoff \}/)
    assert.match(MAIL_MESSAGE_LOOKUP_JXA, /if \(msgs\.length === 0\) continue/)
    assert.doesNotMatch(MAIL_MESSAGE_LOOKUP_JXA, /Mail\.inbox/)
    assert.doesNotMatch(MAIL_MESSAGE_LOOKUP_JXA, /messageId: \{/) // no whose on message id
  })
})

describe('both /api/mail/send routes use the shared builder', () => {
  const fs = require('fs')
  const path = require('path')
  for (const file of ['index.js', 'daemon/index.js']) {
    it(`${file}: parses with parseSendRequest and builds with buildSendScript; no inline single-To script`, () => {
      const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
      const start = src.search(/app\.post\([^)]*\/api\/mail\/send/)
      assert.ok(start > 0, 'route not found')
      const body = src.slice(start, src.indexOf('\n  })', start) > 0 ? src.indexOf('/api/mail/capabilities', start) : undefined)
      assert.match(body, /mailCompose\.parseSendRequest\(req\.body\)/)
      assert.match(body, /mailCompose\.buildSendScript\(m, senderAddress\)/)
      assert.doesNotMatch(body, /make new to recipient/)
      assert.match(src, /\/api\/mail\/capabilities/)
      assert.match(src, /\/api\/mail\/message/)
    })
  }
})
