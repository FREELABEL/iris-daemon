'use strict'

/**
 * The outgoing Apple Mail message, as data and as the AppleScript that builds it (#191605).
 *
 * WHY THIS IS ITS OWN MODULE. `/api/mail/send` lives twice — index.js (bridgectl) and
 * daemon/index.js (daemonctl) — and each built its script inline. Both took ONE `to_email`, had
 * no BCC and no way to answer a specific message, so on 2026-10-28 a five-person reply-all on the
 * Vanguard thread was sent with raw `osascript` through `iris hive run`, around the comms router,
 * and never reached the comms log. One pure builder, used by both routes, is what the tests can
 * hold: the script that comes out is the thing under test, and nothing here touches Mail.app.
 *
 * THREADING. Mail.app's AppleScript dictionary has no writable header on an outgoing message —
 * `In-Reply-To` and `References` cannot be set directly. The only way to thread is Mail's own
 * `reply` command on the ORIGINAL message, which writes both headers itself. So a reply is:
 * find the original (by RFC Message-ID, in one named account and mailbox, date-bounded — never a
 * whose-clause over the unified inbox, see comms-mail-applescript.ts "THE TRAP"), `reply` to it,
 * then replace its recipients with exactly the ones the caller computed. That Mail really writes
 * the headers, and that `delete every to recipient` works on a reply, can only be confirmed by a
 * real send on a Mac.
 */

/** AppleScript string literal body: backslash first, then double quote. Newlines are legal. */
function esc (s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Normalise a recipient field to a clean list. Accepts a string, a comma/semicolon-separated
 * string, an array of either, or nothing. Duplicates (case-insensitive) are dropped, first wins.
 */
function addressList (v) {
  const raw = Array.isArray(v) ? v : (v == null || v === '' ? [] : [v])
  const out = []
  const seen = new Set()
  for (const item of raw) {
    for (const part of String(item == null ? '' : item).split(/[,;]/)) {
      const a = part.trim()
      if (!a) continue
      const k = a.toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      out.push(a)
    }
  }
  return out
}

/** `<abc@x>`, `abc@x`, `rfc822_<abc@x>` → `abc@x` — the comparable core of a Message-ID. */
function normalizeMessageId (id) {
  return String(id == null ? '' : id).trim().replace(/^rfc822_/i, '').replace(/^<|>$/g, '').trim()
}

const looksLikeAddress = (a) => /^[^\s@<>"]+@[^\s@<>"]+$/.test(a)

/**
 * Validate a POST /api/mail/send body into one outgoing message. Returns { error } or { message }.
 * Backward compatible: a single string `to_email` with `cc_email` is exactly the old contract.
 */
function parseSendRequest (body) {
  const b = body || {}
  const to = addressList(b.to_email)
  // An address may appear once. To beats CC beats BCC — a person in To is not also CC'd.
  const inTo = new Set(to.map((a) => a.toLowerCase()))
  const cc = addressList(b.cc_email).filter((a) => !inTo.has(a.toLowerCase()))
  const inToOrCc = new Set([...inTo, ...cc.map((a) => a.toLowerCase())])
  const bcc = addressList(b.bcc_email).filter((a) => !inToOrCc.has(a.toLowerCase()))

  if (!to.length || !b.subject || !b.body_text) {
    return { error: 'to_email, subject, and body_text are required' }
  }
  const bad = [...to, ...cc, ...bcc].filter((a) => !looksLikeAddress(a))
  if (bad.length) return { error: `not an email address: ${bad.join(', ')}` }

  let reply = null
  if (b.in_reply_to) {
    const messageId = normalizeMessageId(b.in_reply_to)
    if (!messageId) return { error: 'in_reply_to is empty' }
    // Without the account and mailbox the original would have to be found by a whose-clause over
    // every mailbox — the request that pegs Mail for minutes. GET /api/mail/message answers both.
    if (!b.reply_account || !b.reply_mailbox) {
      return { error: 'in_reply_to needs reply_account and reply_mailbox — look the message up first with GET /api/mail/message?id=…' }
    }
    reply = {
      messageId,
      account: String(b.reply_account),
      mailbox: String(b.reply_mailbox),
      days: Math.max(1, Math.min(365, parseInt(b.reply_days || '90', 10) || 90)),
    }
  }

  return {
    message: {
      to,
      // A display name only makes sense for a single To.
      toName: to.length === 1 && b.to_name ? String(b.to_name) : null,
      cc,
      bcc,
      from: b.from_email ? String(b.from_email) : null,
      subject: String(b.subject),
      body: String(b.body_text),
      attachments: Array.isArray(b.attachments) ? b.attachments.filter(Boolean).map(String) : [],
      draft: b.draft === true || b.draft === 'true',
      reply,
    },
  }
}

/**
 * The AppleScript for one outgoing message. `senderAddress` is the account address already
 * resolved against Mail.app (as Mail spells it) — resolution stays in the route, which is where a
 * 422 for an unknown From belongs.
 */
function buildSendScript (m, senderAddress) {
  const lines = ['tell application "Mail"']

  if (m.reply) {
    // Find the original the way the thread reader does: the mailbox OBJECT from the account's own
    // listing (a Gmail "Sent Mail" cannot be addressed by name), a date-bounded whose, the ids
    // fetched in bulk and compared in script — never `whose message id is …` over a big mailbox.
    lines.push(
      `  set wantId to "${esc(m.reply.messageId)}"`,
      `  set cutoff to (current date) - (${m.reply.days} * days)`,
      '  set orig to missing value',
      `  repeat with mb in (mailboxes of account "${esc(m.reply.account)}")`,
      `    if orig is missing value and (name of mb) is "${esc(m.reply.mailbox)}" then`,
      '      set recent to (messages of mb whose date received > cutoff)',
      '      if (count of recent) > 0 then',
      '        set ids to message id of recent',
      '        repeat with i from 1 to (count of ids)',
      '          set mid to item i of ids',
      '          if mid starts with "<" then set mid to text 2 thru -2 of mid',
      '          if mid is wantId then',
      '            set orig to item i of recent',
      '            exit repeat',
      '          end if',
      '        end repeat',
      '      end if',
      '    end if',
      '  end repeat',
      `  if orig is missing value then error "IRIS: original message <${esc(m.reply.messageId)}> not found in ${esc(m.reply.mailbox)} of ${esc(m.reply.account)}" number 1404`,
      // `reply` is what writes In-Reply-To and References. Not `reply to all`: the recipients are
      // computed by the caller (minus yourself, leads resolved) and set below, exactly.
      `  set msg to reply orig ${m.draft ? 'with' : 'without'} opening window`,
      '  delete every to recipient of msg',
      '  delete every cc recipient of msg',
      '  delete every bcc recipient of msg',
      `  set subject of msg to "${esc(m.subject)}"`,
      `  set content of msg to "${esc(m.body)}"`,
    )
  } else {
    lines.push(`  set msg to make new outgoing message with properties {subject:"${esc(m.subject)}", content:"${esc(m.body)}", visible:false}`)
  }

  for (const a of m.to) {
    const name = m.toName || a
    lines.push(`  make new to recipient at end of to recipients of msg with properties {name:"${esc(name)}", address:"${esc(a)}"}`)
  }
  for (const a of m.cc) lines.push(`  make new cc recipient at end of cc recipients of msg with properties {address:"${esc(a)}"}`)
  for (const a of m.bcc) lines.push(`  make new bcc recipient at end of bcc recipients of msg with properties {address:"${esc(a)}"}`)
  if (senderAddress) lines.push(`  set sender of msg to "${esc(senderAddress)}"`)
  for (const fp of m.attachments) {
    lines.push(`  make new attachment with properties {file name:POSIX file "${esc(fp)}"} at after the last paragraph of content of msg`)
  }
  if (m.draft) lines.push('  set visible of msg to true', '  activate')
  else lines.push('  delay 1', '  send msg')
  lines.push('end tell')
  return lines.join('\n')
}

/** What the route reports back — the bridge's account of what it composed, not the caller's intent. */
function describeSent (m) {
  return {
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
    in_reply_to: m.reply ? `<${m.reply.messageId}>` : null,
    threaded: m.reply ? 'mail.app-reply' : null,
  }
}

/**
 * Read ONE message's envelope by RFC Message-ID, for a reply. JXA, with every input passed as
 * argv — nothing is interpolated into the script, so no address or id can break out of it.
 * argv: [messageId, days, accountName?]. Scans INBOX, Sent and Archive/All Mail of each account
 * (or the one named), date-bounded, counting before any bulk fetch (an empty whose throws -1728).
 */
const MAIL_MESSAGE_LOOKUP_JXA = String.raw`function run(argv) {
  const norm = (s) => String(s || "").trim().replace(/^rfc822_/i, "").replace(/^<|>$/g, "").trim()
  const want = norm(argv[0])
  const days = Number(argv[1] || 90)
  const only = String(argv[2] || "")
  if (!want) throw new Error("usage: <message-id> <days> [account]")
  const Mail = Application("Mail")
  const cutoff = new Date(Date.now() - days * 864e5)
  const accts = only ? [Mail.accounts.byName(only)] : Mail.accounts()
  const wanted = (n) => /^inbox$/i.test(n) || /(^|\/)sent( mail| messages)?$/i.test(n) || /(^|\/)(archive|all mail)$/i.test(n)
  const emailOf = (s) => {
    const m = String(s || "").match(/<([^>]+)>/)
    return (m ? m[1] : String(s || "")).trim()
  }
  for (const acct of accts) {
    const acctName = acct.name()
    for (const mb of acct.mailboxes()) {
      const mbName = mb.name()
      if (!wanted(mbName)) continue
      const msgs = mb.messages.whose({ dateReceived: { ">": cutoff } })
      if (msgs.length === 0) continue
      const ids = msgs.messageId()
      for (let i = 0; i < ids.length; i++) {
        if (norm(ids[i]) !== want) continue
        const m = msgs[i]
        let headers = ""
        try { headers = String(m.allHeaders()) } catch (e) { headers = "" }
        const refs = (headers.match(/^references:\s*((?:.*)(?:\r?\n[ \t].*)*)/im) || [])[1] || ""
        return JSON.stringify({
          ok: true,
          message_id: norm(ids[i]),
          account: acctName,
          mailbox: mbName,
          subject: m.subject(),
          from: emailOf(m.sender()),
          reply_to: m.replyTo() ? emailOf(m.replyTo()) : null,
          to: m.toRecipients.address(),
          cc: m.ccRecipients.address(),
          date: (m.dateSent() || m.dateReceived()).toISOString(),
          references: (refs.match(/<[^>]+>/g) || []).map(norm),
        })
      }
    }
  }
  return JSON.stringify({ ok: false, error: "not found" })
}
`

/** What /api/mail/send accepts. Bump `version` with any field a caller must not send to an older bridge. */
const CAPABILITIES = { ok: true, version: 2, multi_to: true, bcc: true, reply: true, message_lookup: true }

/**
 * GET /api/mail/message?id=<message-id>&days=90&account=<name>. `execFile` is injected so the
 * route can be tested with a fake osascript. Returns { status, body }.
 */
function lookupMessage (execFile, query) {
  const q = query || {}
  const id = normalizeMessageId(q.id || q.message_id)
  if (!id) return Promise.resolve({ status: 400, body: { error: 'id (an RFC Message-ID) is required' } })
  const days = String(Math.max(1, Math.min(365, parseInt(q.days || '90', 10) || 90)))
  const args = ['-l', 'JavaScript', '-e', MAIL_MESSAGE_LOOKUP_JXA, id, days]
  if (q.account) args.push(String(q.account))
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', args, { timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || '').trim().slice(0, 300)
        return resolve({ status: /-1743|not allowed|not authori[sz]ed/i.test(msg) ? 403 : 500, body: { error: `Mail.app lookup failed: ${msg}` } })
      }
      let d
      try { d = JSON.parse(String(stdout)) } catch { return resolve({ status: 500, body: { error: `unreadable lookup output: ${String(stdout).slice(0, 120)}` } }) }
      if (!d.ok) return resolve({ status: 404, body: { error: `no message <${id}> in the last ${days} days (INBOX, Sent, Archive/All Mail)` } })
      resolve({ status: 200, body: d })
    })
  })
}

module.exports = {
  CAPABILITIES,
  lookupMessage,
  esc,
  addressList,
  normalizeMessageId,
  parseSendRequest,
  buildSendScript,
  describeSent,
  MAIL_MESSAGE_LOOKUP_JXA,
}
