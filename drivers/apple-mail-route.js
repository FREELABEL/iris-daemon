'use strict'
/**
 * GET /api/mail/search — the handler, kept out of index.js so it can be mounted by a test
 * harness without booting the daemon (channels, bots, mesh). index.js mounts it as-is.
 */
function mailSearchHandler({ onError = () => {} } = {}) {
  return async (req, res) => {
  // Reads Mail's own Envelope Index instead of `messages of inbox whose sender contains X`
  // (31s of AppleScript → ~0.3s of SQLite). Bodies come from the message's .emlx on request.
  //
  //   from=        sender address OR display name contains (wildcards escaped)
  //   participant= this address sent it OR received it (to/cc/bcc) — rows carry
  //                 direction: inbound | outbound | other, and role: sender | to | cc | bcc
  //   subject=     subject contains
  //   include_body=1&max_body=N
  //
  // #189941: every caller that needs a lead's THREAD wants participant=. from= only ever
  // returned one side of the conversation.
  const from = (req.query.from || '').toString().trim()
  const participant = (req.query.participant || '').toString().trim()
  const subject = (req.query.subject || '').toString().trim()
  const fromMe = ['1', 'true', 'yes'].includes(String(req.query.from_me || '').toLowerCase())
  const days = Math.max(1, Math.min(365, parseInt(req.query.days || '14', 10)))
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit || '20', 10)))
  const includeBody = ['1', 'true', 'yes'].includes(String(req.query.include_body || '').toLowerCase())
  const maxBody = Math.max(1, Math.min(100000, parseInt(req.query.max_body || '4000', 10)))

  if (!from && !subject && !participant && !fromMe) {
    return res.status(400).json({ error: 'from, participant, subject or from_me query param is required' })
  }

  try {
    const store = require('./apple-mail-store')
    const emails = await store.searchEmails({ from, participant, subject, fromMe, days, limit, includeBody, maxBody })
    res.json({
      emails: emails.map((e) => ({
        id: e.id,
        message_id: e.message_id,
        subject: e.subject,
        sender: e.sender,
        sender_name: e.sender_name,
        date_sent: e.sent_at ? e.sent_at.toISOString() : null,
        mailbox: e.mailbox,
        mailboxes: e.mailboxes,
        to: e.to,
        cc: e.cc,
        ...(participant ? { direction: e.direction, role: e.role, from_me: e.from_me } : {}),
        ...(fromMe ? { from_me: true, direction: 'outbound' } : {}),
        ...(includeBody ? { body: e.body, body_error: e.body_error, body_truncated: e.body_truncated, message_id_header: e.message_id_header } : {}),
      })),
      count: emails.length,
      days,
      source: 'envelope-index',
      // Lets a CLI tell "this bridge can see outbound + bodies" from an older one that
      // silently ignores the params and answers sender-only.
      capabilities: ['participant', 'body', 'sender_name', 'dedupe', 'from_me'],
    })
  } catch (err) {
    onError(err)
    res.status(/required/.test(err.message) ? 400 : 503).json({ error: err.message })
  }
  }
}

module.exports = { mailSearchHandler }
