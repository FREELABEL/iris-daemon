const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

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

// The Atlas push is fire-and-forget from handleInbound()'s perspective (by design —
// it must never block the reply-policy pipeline), so tests can't just await
// handleInbound() and expect the push to have landed. Poll instead of guessing a
// fixed delay: a real network round-trip, even to 127.0.0.1, is not a microtask.
async function waitFor (predicate, timeoutMs = 2000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
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
    // #182118's Atlas push fires unconditionally alongside the local write these tests
    // check. Without this stub they were making REAL, unawaited network calls to
    // production on every run (caught live: 5 real 401s against raichu.heyiris.io,
    // landing asynchronously mid-way through unrelated later tests). Returning null
    // short-circuits _pushMentionToAtlas() before it ever opens a socket — see the
    // dedicated push tests below for coverage of that path itself.
    channel._getLocalNodeIdentity = async () => null
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

// #182118 — cross-machine mention push. Local logging (above) must stay intact and
// unblocked no matter what happens to the cloud push; these tests are specifically
// about the ADDITIVE Atlas write, not a replacement for the local file.
describe('IMessageChannel Atlas mention push (#182118)', () => {
  let scratch
  let channel
  let atlasServer
  let atlasRequests
  let atlasPort

  beforeEach(async () => {
    scratch = withScratchHome()
    atlasRequests = []
    atlasServer = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        atlasRequests.push({ url: req.url, method: req.method, body: body ? JSON.parse(body) : null })
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: { id: 1 } }))
      })
    })
    await new Promise((resolve) => atlasServer.listen(0, '127.0.0.1', resolve))
    atlasPort = atlasServer.address().port

    channel = new IMessageChannel({ groupPolicy: 'open', flApiUrl: `http://127.0.0.1:${atlasPort}` })
    channel.resolveContact = async () => null
    channel.forwardToAPI = async () => {}
    channel.sendReply = async () => {}
    // Real node identity resolution needs a live daemon on :3200, which tests must
    // not depend on (wrong port in CI, and binding a real daemon's port from a test
    // process is its own hazard). Stub it the same way resolveContact etc. are
    // stubbed above — this is the one seam _pushMentionToAtlas() is built around.
    channel._getLocalNodeIdentity = async () => ({ nodeId: 'test-node-id', nodeName: 'test-node' })
  })

  afterEach(async () => {
    scratch.restore()
    await new Promise((resolve) => atlasServer.close(resolve))
  })

  it('pushes a detected mention to the Atlas mentions dataset', async () => {
    await channel.handleInbound(baseEvent({ sender: '+15125551234', isFromMe: false, text: '@heyiris push this' }))
    await waitFor(() => atlasRequests.length > 0)

    assert.equal(atlasRequests.length, 1)
    assert.equal(atlasRequests[0].url, '/api/v1/atlas/datasets/mentions')
    assert.equal(atlasRequests[0].method, 'POST')
    assert.equal(atlasRequests[0].body.data.text, '@heyiris push this')
    assert.equal(atlasRequests[0].body.data.sender, '+15125551234')
    assert.equal(atlasRequests[0].body.data.node_id, 'test-node-id')
    assert.equal(atlasRequests[0].body.data.node_name, 'test-node')
  })

  it('pushes a self-mention too — the whole point of #182118 alongside #182062', async () => {
    await channel.handleInbound(baseEvent({ sender: 'unknown', isFromMe: true, text: '@heyiris self mention, cross-machine' }))
    await waitFor(() => atlasRequests.length > 0)

    assert.equal(atlasRequests.length, 1)
    assert.equal(atlasRequests[0].body.data.is_from_me, true)
  })

  it('still writes the local file even when the Atlas push fails', async () => {
    await atlasServer.close()
    // A closed server on this port refuses the connection — genuinely unreachable,
    // not a mocked failure.

    await channel.handleInbound(baseEvent({ sender: '+15125551234', isFromMe: false, text: '@heyiris local must survive' }))
    await new Promise((resolve) => setTimeout(resolve, 100))

    const rows = readAllMentions(scratch.dir)
    assert.equal(rows.length, 1, 'local log must not be affected by a cloud push failure')
    assert.equal(rows[0].text, '@heyiris local must survive')
  })

  it('does not push a message with no wake-word', async () => {
    await channel.handleInbound(baseEvent({ text: 'no wake word here', isFromMe: false }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(atlasRequests.length, 0)
  })
})
