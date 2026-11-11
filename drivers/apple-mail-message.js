/**
 * Apple Mail — one message by its index id: envelope from the Envelope Index, body from its
 * .emlx (#189480). Shared by the full bridge (index.js) and daemon-only mode (daemon/index.js),
 * so both answer GET /api/mail/message?id=<rowid> the same way.
 *
 * Daemon-only mode used to send every id to Mail.app's AppleScript lookup, which wants an RFC
 * Message-ID: a row id like 387748 matched nothing, and the scan of 90 days of mail ran into its
 * 120 s timeout. `iris mail read <id>` hung for two minutes and failed, every time.
 */

const store = require('./apple-mail-store')
const { readBody } = require('./apple-mail-body')

/** A Mail index row id (what /api/mail/search returns as `id`), not an RFC Message-ID. */
function isRowId (id) {
  return /^\s*[1-9][0-9]*\s*$/.test(String(id == null ? '' : id))
}

/** { status, body } for GET /api/mail/message?id=<rowid>&max_body=N. */
async function readMessage (id, maxBodyParam) {
  const maxBody = Math.max(200, Math.min(100000, parseInt(maxBodyParam || '20000', 10) || 20000))
  const env = await store.messageById(id)
  if (!env) return { status: 404, body: { error: `No message with id ${id} in the Mail index` } }
  let body = null
  let bodyError = null
  try {
    body = readBody(env.id, env.mailbox)
  } catch (e) {
    // The envelope is still worth returning; the missing body is NAMED, never an empty string.
    bodyError = e.message
  }
  return {
    status: 200,
    body: {
      id: env.id,
      subject: env.subject,
      sender: env.sender,
      sender_name: env.sender_name,
      date_sent: env.sent_at ? env.sent_at.toISOString() : null,
      mailbox: env.mailbox,
      message_id_header: body ? body.messageIdHeader : null,
      body: body ? body.text.slice(0, maxBody) : null,
      body_truncated: body ? body.text.length > maxBody : false,
      partial: body ? body.partial : false,
      ...(bodyError ? { body_error: bodyError } : {}),
    },
  }
}

/** Body text for a search row, or { error } — never the 1000-character `summaries` preview. */
function bodyFor (rowid, mailboxUrl, max) {
  try {
    return { text: readBody(Number(rowid), mailboxUrl).text.slice(0, max) }
  } catch (e) {
    return { error: e.message }
  }
}

module.exports = { readMessage, isRowId, bodyFor }
