const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { SessionStreamer, locateClaudeTranscript } = require('../daemon/session-stream')

/**
 * Epic #192964 W1 — the CONTRACT, over the real wire: two daemons' streamers against the real API and
 * the real Pusher app, and a real pusher-js follower authorised as a user.
 *
 * pending-poll.test.js and session-stream.test.js drive the daemon's own logic; nothing there proves
 * that what the daemon POSTs is what the platform accepts, that the platform's broadcast is what the
 * client parses, or that channel auth refuses the right people. This does, end to end.
 *
 * Opt-in, because it needs credentials and a deployed API. Without them it is SKIPPED, loudly:
 *   LIVE_FOLLOW_CONTRACT=1
 *   IRIS_API_URL=https://…           (there is no staging environment today: Railway has production only)
 *   IRIS_API_KEY=…                   a user who can reach node A and node B
 *   NODE_A_KEY=node_live_… NODE_A_ID=…   NODE_B_KEY=node_live_… NODE_B_ID=…
 *   OUTSIDER_API_KEY=…               (optional) a user who can reach neither: must be refused
 */

const E = process.env
const ON = E.LIVE_FOLLOW_CONTRACT === '1' && E.IRIS_API_URL && E.IRIS_API_KEY && E.NODE_A_KEY && E.NODE_B_KEY && E.NODE_A_ID && E.NODE_B_ID
const skip = ON ? false : 'LIVE_FOLLOW_CONTRACT=1 and node/user credentials are not set — see the header of this file'

async function post (key, p, body) {
  const r = await fetch(E.IRIS_API_URL + p, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

function follower (userKey, info) {
  const Pusher = require('pusher-js')
  const p = new Pusher(info.pusher.key, {
    cluster: info.pusher.cluster,
    authorizer: (ch) => ({
      authorize: async (socketId, cb) => {
        const r = await post(userKey, info.auth_endpoint, { socket_id: socketId, channel_name: ch.name })
        r.status === 200 ? cb(null, r.body) : cb(new Error(`auth ${r.status}`), null)
      }
    })
  })
  const got = []
  const ch = p.subscribe(info.channel)
  const ready = new Promise((resolve, reject) => {
    ch.bind('pusher:subscription_succeeded', resolve)
    ch.bind('pusher:subscription_error', (e) => reject(new Error(`subscription refused: ${e && e.status}`)))
  })
  ch.bind('session.stream', (e) => got.push({ at: Date.now(), e }))
  return { got, ready, close: () => p.disconnect() }
}

function daemon (nodeId, nodeKey, home) {
  return new SessionStreamer({
    nodeId,
    log: () => {},
    locate: (id) => locateClaudeTranscript(fs, id, home),
    publish: async (sessionId, envelopes) => {
      const r = await post(nodeKey, `/api/v6/node-agent/sessions/${sessionId}/stream`, { envelopes })
      if (r.status !== 200) throw new Error(`stream ${r.status} ${JSON.stringify(r.body)}`)
    }
  })
}

const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)) } throw new Error('timed out') }
const line = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: new Date().toISOString() }) + '\n'

describe('live follow contract — real API, real Pusher', { skip }, () => {
  const sid = crypto.randomUUID()
  let home, file, A, B, fol

  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-contract-'))
    fs.mkdirSync(path.join(home, '.claude', 'projects', '-c'), { recursive: true })
    file = path.join(home, '.claude', 'projects', '-c', `${sid}.jsonl`)
    fs.writeFileSync(file, line('contract: opened'))
    A = daemon(E.NODE_A_ID, E.NODE_A_KEY, home)
    B = daemon(E.NODE_B_ID, E.NODE_B_KEY, home)
  })
  after(() => { A && A.stopAll(); B && B.stopAll(); fol && fol.close() })

  it('a member follows B: snapshot, then typed words in under 1 s, with consistent cursors', async () => {
    const info = (await post(E.IRIS_API_KEY, `/api/v6/nodes/sessions/${sid}/follow`, { machine: E.NODE_B_ID, notify: false })).body
    assert.equal(info.channel, `private-hive-session.${E.NODE_B_ID}.${sid}`)
    fol = follower(E.IRIS_API_KEY, info)
    await fol.ready
    // What the platform would deliver as session.follow on B's channel; B's streamer takes it from here.
    B.follow({ session_id: sid, ttl_s: 60, snapshot: true })
    await until(() => fol.got.some((g) => g.e.kind === 'snapshot'))

    const t0 = Date.now()
    fs.appendFileSync(file, line('contract: typed on B'))
    const d = await until(() => fol.got.find((g) => g.e.kind === 'delta'))
    assert.ok(d.at - t0 < 1000, `${d.at - t0} ms`)
    assert.equal(d.e.node_id, E.NODE_B_ID)
    assert.match(d.e.body, /typed on B/)
    assert.equal(d.e.from, fol.got.find((g) => g.e.kind === 'snapshot').e.to)
  })

  it('A cannot speak on B\'s channel: its envelopes land on its OWN channel, whatever the body says', async () => {
    const before = fol.got.length
    const r = await post(E.NODE_A_KEY, `/api/v6/node-agent/sessions/${sid}/stream`, { envelopes: [{ v: 1, kind: 'delta', node_id: E.NODE_B_ID, seq: 99, from: 0, to: 1, enc: 'none', body: '[{"text":"spoofed"}]', final: true }] })
    assert.equal(r.status, 200)
    await new Promise((res) => setTimeout(res, 1500))
    assert.equal(fol.got.slice(before).filter((g) => /spoofed/.test(g.e.body)).length, 0)
  })

  it('a node key cannot subscribe to another node\'s channel', async () => {
    const r = await post(E.NODE_A_KEY, '/api/v6/nodes/broadcasting/auth', { socket_id: '1.2', channel_name: `private-node.${E.NODE_B_ID}` })
    assert.equal(r.status, 403)
  })

  it('a user outside the Hive cannot subscribe to B\'s session stream', { skip: !E.OUTSIDER_API_KEY && 'OUTSIDER_API_KEY not set' }, async () => {
    const r = await post(E.OUTSIDER_API_KEY, '/api/v6/nodes/sessions/broadcasting/auth', { socket_id: '1.2', channel_name: `private-hive-session.${E.NODE_B_ID}.${sid}` })
    assert.equal(r.status, 403)
  })
})
