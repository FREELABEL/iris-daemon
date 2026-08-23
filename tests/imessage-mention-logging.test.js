const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const IMessageChannel = require('../channels/imessage')

// _logMentionLocally resolves its directory via a fresh `require('os').homedir()`
// call at write time, which on POSIX reads process.env.HOME — so redirecting HOME
// to a scratch dir is enough to keep these tests off the real ~/.iris/mentions/.
function withScratchHome () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imessage-mention-test-'))
  const realHome = process.env.HOME
  process.env.HOME = dir
  return {
    dir,
    restore () {
      process.env.HOME = realHome
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

function readAllMentions (homeDir) {
  const mentionsDir = path.join(homeDir, '.iris', 'mentions')
  if (!fs.existsSync(mentionsDir)) return []
  const rows = []
  for (const file of fs.readdirSync(mentionsDir).filter((f) => f.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(mentionsDir, file), 'utf-8').split('\n').filter(Boolean)) {
      rows.push(JSON.parse(line))
    }
  }
  return rows
}

function baseEvent (overrides = {}) {
  return {
    chatGuid: 'chat-1',
    sender: 'unknown',
    senderName: null,
    messageId: 'm-1',
    text: '@heyiris ingest this please and thank you',
    attachments: [],
    timestamp: Date.now(),
    isGroup: true,
    groupName: 'GTC MediGuide',
    isFromMe: false,
    ...overrides,
  }
}

describe('IMessageChannel mention logging (#182062)', () => {
  let scratch
  let channel

  beforeEach(() => {
    scratch = withScratchHome()
    // groupPolicy defaults to 'closed' (config.groupPolicy unset -> shouldProcess
    // returns false for ANY group message, before logging even runs) — these tests
    // are about the is_from_me gate inside the logging path, not policy defaults, so
    // open groups explicitly to match how the production bridge is actually configured
    // (confirmed live: client group mentions were reaching the mentions log).
    channel = new IMessageChannel({ groupPolicy: 'open' })
    // Isolate from network / lead lookups — these tests are about the
    // detect-mention -> log-locally path, not contact resolution or replying.
    channel.resolveContact = async () => null
    channel.forwardToAPI = async () => {}
    channel.sendReply = async () => {}
  })

  afterEach(() => {
    scratch.restore()
  })

  it('logs a mention from another sender', async () => {
    await channel.handleInbound(baseEvent({ sender: '+13129700587', isFromMe: false }))
    const rows = readAllMentions(scratch.dir)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].sender, '+13129700587')
    assert.equal(rows[0].text.includes('ingest this'), true)
  })

  it('logs a mention the user sent to themselves — regression for #182062', async () => {
    // This is exactly the shape measured live on 2026-08-23: an own-message mention
    // where sender resolves to "unknown", in a group. Before the fix this silently
    // produced zero log entries — no error, nothing in ~/.iris/mentions/ — because
    // handleInbound gated _logMentionLocally on `!is_from_me`. A month of self-sent
    // @heyiris instructions ("@heyiris ingest this please") were lost this way.
    await channel.handleInbound(baseEvent({ sender: 'unknown', isFromMe: true }))
    const rows = readAllMentions(scratch.dir)
    assert.equal(rows.length, 1, 'own-message mention must be logged, not dropped')
    assert.equal(rows[0].text.includes('ingest this'), true)
  })

  it('does not log a message with no wake-word', async () => {
    await channel.handleInbound(baseEvent({ text: 'no wake word here', isFromMe: false }))
    assert.deepEqual(readAllMentions(scratch.dir), [])
  })

  it('does not log a self-sent message with no wake-word', async () => {
    await channel.handleInbound(baseEvent({ text: 'just talking to myself', isFromMe: true }))
    assert.deepEqual(readAllMentions(scratch.dir), [])
  })

  it('logs every mention in a burst, one entry per message', async () => {
    await channel.handleInbound(baseEvent({ sender: '+15125551234', isFromMe: false, messageId: 'a', text: '@heyiris one' }))
    await channel.handleInbound(baseEvent({ sender: '+15125551234', isFromMe: false, messageId: 'b', text: '@heyiris two' }))
    await channel.handleInbound(baseEvent({ sender: 'unknown', isFromMe: true, messageId: 'c', text: '@heyiris three' }))
    const rows = readAllMentions(scratch.dir)
    assert.equal(rows.length, 3)
    assert.deepEqual(rows.map((r) => r.text).sort(), ['@heyiris one', '@heyiris three', '@heyiris two'])
  })
})
