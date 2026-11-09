const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { SessionStreamer, buildEnvelopes, locateClaudeTranscript, MAX_BODY } = require('../daemon/session-stream')

/**
 * Epic #192964 W1: live follow. These drive a REAL transcript file on disk and the real fs.watch,
 * not a typed fake. The bug class this guards against is the one a fake hides: half-written lines,
 * a file rewritten under the reader, and a burst of appends.
 */

const ID = '0e9cc2cb-04c0-4de3-a156-3afcfef87956'
const NODE = '01a10379-0c9f-73c5-bf83-157496a21589'

function user (text) { return JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: new Date().toISOString() }) + '\n' }
function assistant (text) { return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: new Date().toISOString() }) + '\n' }
function toolResult (big) { return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: big }] } }) + '\n' }

function tmpHome () {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'live-follow-'))
  const dir = path.join(home, '.claude', 'projects', '-tmp-proj')
  fs.mkdirSync(dir, { recursive: true })
  return { home, file: path.join(dir, `${ID}.jsonl`) }
}

const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)) }
  throw new Error('timed out')
}

const open = []
afterEach(() => { while (open.length) open.pop().stopAll() })

function streamer (home, extra = {}) {
  const sent = []
  const s = new SessionStreamer({
    nodeId: NODE,
    publish: async (sessionId, envs) => { sent.push(...envs.map((e) => ({ ...e, sessionId }))) },
    locate: (id) => locateClaudeTranscript(fs, id, home),
    log: () => {},
    ...extra,
  })
  open.push(s)
  return { s, sent }
}

const texts = (envs) => envs.flatMap((e) => (e.body ? JSON.parse(e.body) : [])).map((m) => m.text).filter(Boolean)

describe('buildEnvelopes — the 10 KB Pusher limit', () => {
  // Quote-heavy on purpose: code in a reply is mostly quotes, and each one doubles when escaped.
  const msgs = Array.from({ length: 40 }, (_, i) => ({ role: 'assistant', type: 'text', text: `${i} `.padEnd(900, i % 2 ? 'x' : '"') }))

  it('splits a large flush so that no body exceeds MAX_BODY, keeping every message in order', () => {
    const envs = buildEnvelopes({ kind: 'delta', nodeId: NODE, sessionId: ID, seq: 7, from: 100, to: 900, messages: msgs })
    assert.ok(envs.length > 1)
    for (const e of envs) {
      const travels = Buffer.byteLength(JSON.stringify(e.body))
      assert.ok(travels <= MAX_BODY, `body travels as ${travels} B`)
      // The whole envelope must clear the platform's 10,000 B check, so Pusher's 10 KB never bites.
      assert.ok(Buffer.byteLength(JSON.stringify(e)) <= 10000)
    }
    assert.deepEqual(texts(envs), msgs.map((m) => m.text))
    assert.deepEqual(envs.map((e) => e.seq), envs.map((_, i) => 7 + i))
    assert.deepEqual(envs.map((e) => !!e.final), envs.map((_, i) => i === envs.length - 1))
    for (const e of envs) assert.deepEqual([e.from, e.to, e.v, e.enc], [100, 900, 1, 'none'])
  })

  it('turns a message that cannot fit alone into a ping with the cursor, never a dropped or split message', () => {
    const huge = { role: 'assistant', type: 'text', text: '"'.repeat(4500) } // 4.5 KB raw, 18 KB as it travels
    const envs = buildEnvelopes({ kind: 'delta', nodeId: NODE, sessionId: ID, seq: 0, from: 0, to: 50, messages: [msgs[0], huge, msgs[1]] })
    assert.deepEqual(envs.map((e) => e.kind), ['delta', 'ping', 'delta'])
    assert.equal(envs[1].body, '')
    assert.deepEqual([envs[1].from, envs[1].to], [0, 50])
  })

  it('the body is a STRING the platform never has to parse (opaque, ADR-02)', () => {
    const [e] = buildEnvelopes({ kind: 'delta', nodeId: NODE, sessionId: ID, seq: 0, from: 0, to: 1, messages: [msgs[0]] })
    assert.equal(typeof e.body, 'string')
  })

  it('an empty snapshot still carries the cursor to start from', () => {
    const envs = buildEnvelopes({ kind: 'snapshot', nodeId: NODE, sessionId: ID, seq: 0, from: 42, to: 42, messages: [] })
    assert.equal(envs.length, 1)
    assert.deepEqual([envs[0].body, envs[0].to, envs[0].final], ['[]', 42, true])
  })
})

describe('SessionStreamer — a real transcript on disk', () => {
  it('sends a snapshot of the tail on follow, with the cursor at the end of the last complete line', async () => {
    const { home, file } = tmpHome()
    fs.writeFileSync(file, user('first') + assistant('hello'))
    const { s, sent } = streamer(home)
    assert.deepEqual(s.follow({ session_id: ID, ttl_s: 60 }), { ok: true, started: true })
    await waitFor(() => sent.length)
    assert.equal(sent[0].kind, 'snapshot')
    assert.deepEqual(texts(sent), ['first', 'hello'])
    assert.equal(sent[0].to, fs.statSync(file).size)
  })

  it('pushes words typed into the session as a delta, in well under a second', async () => {
    const { home, file } = tmpHome()
    fs.writeFileSync(file, user('first'))
    const { s, sent } = streamer(home)
    s.follow({ session_id: ID })
    await waitFor(() => sent.length)
    const before = fs.statSync(file).size
    const t0 = Date.now()
    fs.appendFileSync(file, user('typed on B'))
    const d = await waitFor(() => sent.find((e) => e.kind === 'delta'))
    assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`)
    assert.deepEqual(texts([d]), ['typed on B'])
    assert.deepEqual([d.from, d.to], [before, fs.statSync(file).size])
  })

  it('never sends half a line: a record being written is held until its newline lands', async () => {
    const { home, file } = tmpHome()
    fs.writeFileSync(file, user('a'))
    const { s, sent } = streamer(home)
    s.follow({ session_id: ID })
    await waitFor(() => sent.length)
    const line = assistant('half then whole')
    fs.appendFileSync(file, line.slice(0, 20))
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(sent.filter((e) => e.kind === 'delta').length, 0)
    fs.appendFileSync(file, line.slice(20))
    const d = await waitFor(() => sent.find((e) => e.kind === 'delta'))
    assert.deepEqual(texts([d]), ['half then whole'])
  })

  it('consecutive deltas chain: each from is the previous to, so a follower can detect a gap', async () => {
    const { home, file } = tmpHome()
    fs.writeFileSync(file, user('a'))
    const { s, sent } = streamer(home)
    s.follow({ session_id: ID })
    await waitFor(() => sent.length)
    for (const t of ['one', 'two', 'three']) {
      fs.appendFileSync(file, assistant(t))
      await new Promise((r) => setTimeout(r, 250))
    }
    await waitFor(() => texts(sent.filter((e) => e.kind === 'delta')).length === 3)
    const finals = sent.filter((e) => e.final)
    for (let i = 1; i < finals.length; i++) assert.equal(finals[i].from, finals[i - 1].to)
    assert.deepEqual(sent.map((e) => e.seq), sent.map((_, i) => i))
  })

  it('tool results never leave the machine, even a megabyte of them', async () => {
    const { home, file } = tmpHome()
    fs.writeFileSync(file, user('a'))
    const { s, sent } = streamer(home)
    s.follow({ session_id: ID })
    await waitFor(() => sent.length)
    fs.appendFileSync(file, toolResult('x'.repeat(1 << 20)) + assistant('after the tool'))
    await waitFor(() => sent.some((e) => e.kind === 'delta'))
    for (const e of sent) assert.ok(Buffer.byteLength(e.body) <= MAX_BODY)
    assert.deepEqual(texts(sent.filter((e) => e.kind === 'delta')), ['after the tool'])
  })

  it('a rewritten (shorter) file sends a fresh snapshot instead of parsing from a stale cursor', async () => {
    const { home, file } = tmpHome()
    fs.writeFileSync(file, user('one') + user('two') + user('three'))
    const { s, sent } = streamer(home)
    s.follow({ session_id: ID })
    await waitFor(() => sent.length)
    fs.writeFileSync(file, user('compacted'))
    await waitFor(() => sent.filter((e) => e.kind === 'snapshot').length === 2)
    assert.deepEqual(texts([sent.filter((e) => e.kind === 'snapshot')[1]]), ['compacted'])
  })

  it('stops when no follower renews within the ttl, and a renewal keeps it alive', async () => {
    const { home, file } = tmpHome()
    fs.writeFileSync(file, user('a'))
    let now = 1_000_000
    const { s } = streamer(home, { now: () => now })
    s.follow({ session_id: ID, ttl_s: 10 })
    now += 8000
    assert.deepEqual(s.follow({ session_id: ID, ttl_s: 10 }), { ok: true, renewed: true })
    now += 8000
    s._tick(ID)
    assert.equal(s.followed.size, 1)
    now += 3000
    s._tick(ID)
    assert.equal(s.followed.size, 0)
  })

  it('a second follower gets its own snapshot, and pending words are flushed before it', async () => {
    const { home, file } = tmpHome()
    fs.writeFileSync(file, user('a'))
    const { s, sent } = streamer(home)
    s.follow({ session_id: ID })
    await waitFor(() => sent.length)
    fs.appendFileSync(file, user('pending'))
    s.follow({ session_id: ID, snapshot: true })
    await waitFor(() => sent.filter((e) => e.kind === 'snapshot').length === 2)
    const kinds = sent.map((e) => e.kind)
    assert.deepEqual(kinds, ['snapshot', 'delta', 'snapshot'])
  })

  it('refuses what it cannot stream, saying why — and touches no file for it', () => {
    const { home } = tmpHome()
    const { s } = streamer(home)
    assert.equal(s.follow({ session_id: '../../etc/passwd' }).ok, false)
    assert.match(s.follow({ session_id: ID, provider: 'opencode' }).reason, /not supported for opencode/)
    assert.match(s.follow({ session_id: 'b'.repeat(36) }).reason, /not on this machine/)
    assert.equal(s.followed.size, 0)
  })
})
