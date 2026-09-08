/**
 * R1 channel — end-to-end over a real bridge process.
 *
 * Boots an isolated bridge (its own HOME, its own port) against a STUB iris-api,
 * then drives it with a real WebSocket client. Nothing is mocked in between:
 * pairing, the WS handshake, dialect decode, transcription, the agent call and
 * the reply all execute.
 *
 * The iris-api is stubbed on purpose — this proves OUR path is wired, without
 * making the suite depend on prod credentials or on an agent id that may move.
 * Verifying against real IRIS is a separate, manual step (see docs/R1.md).
 *
 *   node --test tests/r1-channel.test.js
 */

const { test, before, after } = require('node:test')
const assert = require('node:assert')
const { spawn } = require('node:child_process')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const WebSocket = require('ws')

const BRIDGE_PORT = 3299
const STUB_PORT = 3298
const ROOT = path.join(__dirname, '..')

let bridge = null
let stub = null
let tmpHome = null
let bridgeToken = null
const stubCalls = []
const pending = new Map()
let workflowSeq = 0

function req (method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null
    const r = http.request({
      hostname: '127.0.0.1',
      port: BRIDGE_PORT,
      path: urlPath,
      method,
      headers: {
        'X-Bridge-Key': bridgeToken,
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        let parsed
        try { parsed = JSON.parse(data) } catch { parsed = { raw: data } }
        resolve({ status: res.statusCode, body: parsed })
      })
    })
    r.on('error', reject)
    if (payload) r.write(payload)
    r.end()
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitFor (fn, timeoutMs = 20000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (await fn()) return true } catch { /* keep waiting */ }
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Drive one turn as a device. Resolves with every frame received. */
function runTurn (deviceId, token, turn, { dialect = 'native', expectClose = false } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/r1`)
    const frames = []
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('turn timed out')) }, 15000)

    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', device_id: deviceId, token })))

    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString())
      frames.push(frame)
      const type = frame.type || frame.event

      // When we expect a rejection, the interesting outcome is the CLOSE CODE.
      // The gateway sends an explanatory error frame first and closes right
      // after; resolving on that frame would report closeCode: undefined and
      // read as "the connection was never refused".
      if (expectClose) return

      if (/welcome|session\.started/.test(type)) {
        if (!turn) { clearTimeout(timer); ws.close(); return resolve(frames) }
        return ws.send(JSON.stringify({ request_id: 'r1', ...turn }))
      }
      if (/^(reply|response|error)$/.test(type)) {
        clearTimeout(timer)
        ws.close()
        resolve(frames)
      }
    })

    ws.on('close', (code) => {
      if (expectClose) { clearTimeout(timer); resolve({ closeCode: code, frames }) }
    })
    ws.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

before(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-test-'))

  // ── Stub iris-api ──
  stub = http.createServer((r, res) => {
    let body = Buffer.alloc(0)
    r.on('data', c => { body = Buffer.concat([body, c]) })
    r.on('end', () => {
      stubCalls.push({ path: r.url, contentType: r.headers['content-type'], length: body.length })
      res.setHeader('Content-Type', 'application/json')

      if (r.url.startsWith('/api/v1/transcribe')) {
        // Assert the shape the real endpoint validates: multipart with a `file`.
        const text = body.toString('latin1')
        const ok = /multipart\/form-data/.test(r.headers['content-type'] || '') &&
                   /name="file"; filename="ptt\./.test(text)
        if (!ok) { res.statusCode = 422; return res.end(JSON.stringify({ error: 'expected multipart file upload' })) }
        return res.end(JSON.stringify({ data: { text: 'what is on my plate today' } }))
      }

      // The REAL endpoint is async: it queues a job and returns 202 with a
      // workflow_id. The dispatch ack carries a `message` field that reads like a
      // perfectly good answer ("Chat execution dispatched. Subscribe to..."), so a
      // naive extractor speaks it aloud and nothing reports an error. The stub
      // reproduces that shape exactly — a sync stub would hide the bug.
      if (r.url.startsWith('/api/v6/chat/execute')) {
        const parsed = JSON.parse(body.toString())
        const workflowId = `wf-${++workflowSeq}`
        pending.set(workflowId, { polls: 0, query: parsed.query, threadId: parsed.thread_id })
        res.statusCode = 202
        return res.end(JSON.stringify({
          status: 'queued',
          workflow_id: workflowId,
          message: 'Chat execution dispatched. Subscribe to workflow channel for updates.'
        }))
      }

      const resultMatch = r.url.match(/^\/api\/v6\/chat\/([^/]+)\/result/)
      if (resultMatch) {
        const job = pending.get(resultMatch[1])
        if (!job) { res.statusCode = 404; return res.end(JSON.stringify({ status: 'pending' })) }
        job.polls++
        // Answer 'pending' on the first poll so the wait loop is actually exercised.
        if (job.polls < 2) { res.statusCode = 404; return res.end(JSON.stringify({ status: 'pending' })) }
        return res.end(JSON.stringify({
          workflow_id: resultMatch[1],
          status: 'completed',
          content: `echo:${job.query}|session:${job.threadId}`
        }))
      }

      res.statusCode = 404
      res.end(JSON.stringify({ error: 'not stubbed' }))
    })
  })
  await new Promise(r => stub.listen(STUB_PORT, '127.0.0.1', r))

  // ── Bridge, fully isolated ──
  bridge = spawn(process.execPath, ['index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: tmpHome,               // isolates bridge-token, bridge/.env, r1-devices.json
      BRIDGE_PORT: String(BRIDGE_PORT),
      BRIDGE_BIND_HOST: '127.0.0.1',
      _DAEMON_STARTED: '1',        // don't start the mesh daemon in a test
      IRIS_API_URL: `http://127.0.0.1:${STUB_PORT}`,
      IRIS_API_KEY: 'test-key'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  bridge.stdout.on('data', d => { if (process.env.VERBOSE) process.stdout.write(`[bridge] ${d}`) })
  bridge.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write(`[bridge!] ${d}`) })

  await waitFor(() => {
    bridgeToken = fs.readFileSync(path.join(tmpHome, '.iris', 'bridge-token'), 'utf-8').trim()
    return true
  }, 20000, 'bridge token')

  await waitFor(async () => (await req('GET', '/health')).status === 200, 20000, 'bridge health')
})

after(async () => {
  if (bridge) bridge.kill('SIGKILL')
  if (stub) await new Promise(r => stub.close(r))
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true })
})

test('gateway refuses to start in chat mode without an agent', async () => {
  const res = await req('POST', '/api/providers/r1', { mode: 'chat' })
  assert.strictEqual(res.status, 400)
  assert.match(res.body.error, /agent_id/)
})

test('pairing mints a token, and returns it exactly once', async () => {
  const res = await req('POST', '/api/r1/devices', { device_id: 'test-r1', label: 'Test R1' })
  assert.strictEqual(res.status, 200)
  assert.strictEqual(res.body.device_id, 'test-r1')
  assert.match(res.body.token, /^[0-9a-f]{64}$/)

  // The listing must never carry token material.
  const list = await req('GET', '/api/r1/devices')
  const device = list.body.devices.find(d => d.device_id === 'test-r1')
  assert.ok(device, 'device is listed')
  assert.strictEqual(device.token, undefined)
  assert.strictEqual(device.token_sha256, undefined)
})

test('gateway starts and reports its config', async () => {
  const res = await req('POST', '/api/providers/r1', {
    mode: 'chat',
    dialect: 'native',
    agent_id: 642,
    poll_interval_ms: 150,
    iris_api_url: `http://127.0.0.1:${STUB_PORT}`
  })
  assert.strictEqual(res.status, 200)
  assert.strictEqual(res.body.status, 'running')

  const status = await req('GET', '/api/providers/r1')
  assert.strictEqual(status.body.running, true)
  assert.strictEqual(status.body.agent_id, 642)
  assert.strictEqual(status.body.dialect, 'native')
})

test('an unpaired device is rejected', async () => {
  const result = await runTurn('ghost-r1', 'not-a-real-token', null, { expectClose: true })
  assert.strictEqual(result.closeCode, 4401)
})

test('a wrong token for a REAL device is rejected, and told why', async () => {
  const result = await runTurn('test-r1', 'f'.repeat(64), null, { expectClose: true })
  assert.strictEqual(result.closeCode, 4401)

  // A silent drop is indistinguishable from a network fault on a handheld —
  // the device must be able to say "pairing rejected" rather than "no signal".
  const error = result.frames.find(f => (f.type || f.event) === 'error')
  assert.ok(error, `expected an error frame, got ${JSON.stringify(result.frames)}`)
  assert.match(error.message, /pairing rejected/)

  // And it must not leak whether the device id exists.
  assert.ok(!/token|hash|sha/i.test(error.message), 'rejection reason stays opaque')
})

test('text turn reaches the agent and the reply comes back', async () => {
  const paired = await req('POST', '/api/r1/devices', { device_id: 'talk-r1', label: 'Talker' })
  const frames = await runTurn('talk-r1', paired.body.token, { type: 'text', text: 'hello there' })

  const reply = frames.find(f => f.type === 'reply')
  assert.ok(reply, `expected a reply, got: ${JSON.stringify(frames)}`)
  assert.strictEqual(reply.text, 'echo:hello there|session:r1:talk-r1')

  // Session id is per-device, so context survives across presses.
  const chat = stubCalls.filter(c => c.path.includes('chat/execute'))
  assert.ok(chat.length >= 1, 'agent was called')
})

test('PTT audio is transcribed as multipart, then answered', async () => {
  const paired = await req('POST', '/api/r1/devices', { device_id: 'voice-r1', label: 'Voice' })
  const fakeWav = Buffer.from('RIFF....WAVEfmt fake audio payload').toString('base64')

  const frames = await runTurn('voice-r1', paired.body.token, {
    type: 'ptt', audio: fakeWav, format: 'wav'
  })

  // The ack carries the transcript back before the agent has answered.
  const ack = frames.find(f => f.type === 'ack')
  assert.ok(ack, 'an ack was sent')
  assert.strictEqual(ack.transcript, 'what is on my plate today')

  const reply = frames.find(f => f.type === 'reply')
  assert.ok(reply, 'a reply was sent')
  assert.strictEqual(reply.text, 'echo:what is on my plate today|session:r1:voice-r1')

  const transcribe = stubCalls.find(c => c.path.includes('/api/v1/transcribe'))
  assert.ok(transcribe, 'transcribe was called')
  assert.match(transcribe.contentType, /multipart\/form-data/)
})

test('an over-long reply is truncated for a 2.88" screen', async () => {
  const paired = await req('POST', '/api/r1/devices', { device_id: 'long-r1', label: 'Long' })
  const frames = await runTurn('long-r1', paired.body.token, { type: 'text', text: 'x'.repeat(2000) })
  const reply = frames.find(f => f.type === 'reply')
  assert.ok(reply.text.length <= 900, `reply was ${reply.text.length} chars`)
  assert.ok(reply.text.endsWith('…'), 'truncation is marked')
})

test('revoking a device stops it connecting', async () => {
  const paired = await req('POST', '/api/r1/devices', { device_id: 'doomed-r1', label: 'Doomed' })
  const before = await runTurn('doomed-r1', paired.body.token, null)
  assert.ok(before.find(f => f.type === 'welcome'), 'connected before revoke')

  const revoked = await req('DELETE', '/api/r1/devices/doomed-r1')
  assert.strictEqual(revoked.status, 200)

  const after = await runTurn('doomed-r1', paired.body.token, null, { expectClose: true })
  assert.strictEqual(after.closeCode, 4401)
})

test('re-pairing replaces the old token rather than adding a second live key', async () => {
  const first = await req('POST', '/api/r1/devices', { device_id: 'rotate-r1' })
  const second = await req('POST', '/api/r1/devices', { device_id: 'rotate-r1' })
  assert.notStrictEqual(first.body.token, second.body.token)

  const withOld = await runTurn('rotate-r1', first.body.token, null, { expectClose: true })
  assert.strictEqual(withOld.closeCode, 4401, 'the old token is dead')

  const withNew = await runTurn('rotate-r1', second.body.token, null)
  assert.ok(withNew.find(f => f.type === 'welcome'), 'the new token works')

  const list = await req('GET', '/api/r1/devices')
  assert.strictEqual(list.body.devices.filter(d => d.device_id === 'rotate-r1').length, 1)
})

test('stopping the gateway keeps pairings', async () => {
  const stopped = await req('DELETE', '/api/providers/r1')
  assert.strictEqual(stopped.body.status, 'stopped')
  assert.ok(stopped.body.devices_paired > 0, 'pairings survived')

  const status = await req('GET', '/api/providers/r1')
  assert.strictEqual(status.body.running, false)
})
