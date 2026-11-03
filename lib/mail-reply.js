/**
 * Threaded replies through Mail.app (#189480).
 *
 * /api/mail/send composes with `make new outgoing message`, which produces a NEW email: no
 * In-Reply-To, no References, so the recipient sees a separate message rather than a reply in
 * their thread — even with "Re:" on the subject. Mail.app's outgoing-message object cannot set
 * those headers. Its `reply` command can, because it builds the reply from the original. So a
 * threaded reply has to start from the original message, addressed by its id.
 *
 * A by-id reference is direct. A `whose id is N` clause would scan the mailbox, which is the
 * 30-second pathology the Envelope Index rewrite exists to avoid.
 */

/** imap://<ACCOUNT-UUID>/%5BGmail%5D/All%20Mail → { accountId, mailboxPath: '[Gmail]/All Mail' } */
function parseMailboxUrl (url) {
  const m = String(url || '').match(/^[a-z0-9+.-]+:\/\/([0-9A-F-]{36})\/(.+)$/i)
  if (!m) throw new Error(`cannot reply: "${url}" is not an account mailbox Mail.app can address`)
  const mailboxPath = m[2]
    .split('/')
    .filter(Boolean)
    .map((s) => { try { return decodeURIComponent(s) } catch { return s } })
    .join('/')
  return { accountId: m[1], mailboxPath }
}

const esc = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')

/**
 * @param {{accountId: string, mailboxPath: string, messageId: number, body: string,
 *          replyAll?: boolean, draft?: boolean, fromAddress?: string}} a
 */
function buildReplyScript (a) {
  const id = Number(a.messageId)
  if (!Number.isInteger(id) || id <= 0 || String(a.messageId).trim() !== String(id)) {
    throw new Error(`message id must be a positive integer, got "${a.messageId}"`)
  }
  if (!/^[0-9A-F-]{36}$/i.test(String(a.accountId))) throw new Error('cannot reply: bad account id')

  const lines = [
    'tell application "Mail"',
    // «class mssg» id N — Mail's dictionary also defines a `message id` PROPERTY (the Message-ID
    // header), so `message id N` does not compile (-2741). Measured on a real Mac 2026-10-15:
    // this form resolves the Envelope Index ROWID in ~150-200ms, in INBOX and [Gmail]/All Mail.
    `  set theMsg to «class mssg» id ${id} of mailbox "${esc(a.mailboxPath)}" of (first account whose id is "${esc(a.accountId)}")`,
    // `with` labels before `without` — the order osacompile writes them back in.
    `  set r to reply theMsg ${a.replyAll ? 'with reply to all ' : ''}without opening window`,
    // Replaces Mail's quoted original with the caller's text. The headers that make it a reply
    // (In-Reply-To, References, Re: subject, recipient) are already set by `reply`.
    `  set content of r to "${esc(a.body)}"`,
  ]
  if (a.fromAddress) lines.push(`  set sender of r to "${esc(a.fromAddress)}"`)
  if (a.draft) {
    lines.push('  set visible of r to true', '  activate')
  } else {
    lines.push('  delay 1', '  send r')
  }
  lines.push('end tell')
  return lines.join('\n')
}

module.exports = { parseMailboxUrl, buildReplyScript }
