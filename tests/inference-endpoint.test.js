'use strict'

const test = require('node:test')
const assert = require('node:assert')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createHandler, signToken, verifyToken, readSettings, InferenceEndpoint } = require('../daemon/inference-endpoint')

// #191176 — a Hive machine serving its models to the owner's gateway. The token format is shared
// with fl-iris-api (HiveInferenceToken); VECTOR pins it so the two sides cannot drift apart.
const KEY = 'node-api-key-123'
const NODE = '01a10379-0c9f-73c5-bf83-157496a21589'
const VECTOR = {
  args: { key: KEY, nodeId: NODE, model: 'qwen3:14b', ttlS: 120, now: 1792000000000, nonce: 'a1b2c3d4e5f60718293a4b5c' }
}

test('the shared token vector (copy into fl-iris-api HiveInferenceTokenTest)', () => {
  const t = signToken(VECTOR.args)
  assert.strictEqual(t, 'hv1.01a10379-0c9f-73c5-bf83-157496a21589.1792000120.a1b2c3d4e5f60718293a4b5c.cXdlbjM6MTRi.1a3c1bd5149835f95f719ad6767f45d59e011b0a121b6d4d2ddb137f5442e728')
})

test('verifyToken refuses every way a token can be wrong', () => {
  const now = 1792000000000
  const ok = signToken({ key: KEY, nodeId: NODE, model: 'm', now })
  assert.strictEqual(verifyToken(ok, { key: KEY, nodeId: NODE, now }).ok, true)
  const why = (t, o = {}) => verifyToken(t, { key: KEY, nodeId: NODE, now, ...o }).why
  assert.strictEqual(why(''), 'not a Hive inference token')
  assert.strictEqual(why(ok, { nodeId: 'other' }), 'token is for another node')
  assert.strictEqual(why(ok, { now: now + 121000 }), 'token expired')
  assert.strictEqual(why(signToken({ key: KEY, nodeId: NODE, model: 'm', now, ttlS: 3600 })), 'token lives too long')
  assert.strictEqual(why(ok, { key: 'wrong' }), 'bad signature')
  assert.strictEqual(why(ok.replace(/\.[^.]+\.([a-f0-9]+)$/, '.' + Buffer.from('other').toString('base64url') + '.$1')), 'bad signature')
  assert.strictEqual(why(ok, { seen: () => true }), 'token already used')
  assert.strictEqual(why(ok, { key: '' }), 'this node has no identity yet')
})

// A fake local model server: streams three SSE chunks 150 ms apart, and records what it was sent.
function upstreamServer () {
  const seen = []
  const server = http.createServer((req, res) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', async () => {
      const body = JSON.parse(b)
      seen.push(body)
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const w of ['Hel', 'lo', '!']) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`)
          await new Promise((r) => setTimeout(r, 150))
        }
        res.end('data: [DONE]\n\n')
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'Hello!' } }] }))
      }
    })
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}` })))
}

async function rig (t, over = {}) {
  const up = await upstreamServer()
  let settings = { enabled: true, max_concurrent: 2, max_tokens: 100, ...over.settings }
  const handler = createHandler({
    getKey: () => KEY,
    getNodeId: () => NODE,
    served: () => over.served || ['qwen3:14b'],
    settings: () => settings,
    upstream: () => up.url
  })
  const server = http.createServer((q, s) => handler(q, s))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = (body, token = signToken({ key: KEY, nodeId: NODE, model: body.model })) =>
    fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
  const close = () => { server.closeAllConnections?.(); up.server.closeAllConnections?.(); server.close(); up.server.close() }
  t.after(close)
  return { base, call, up, close, setSettings: (s) => { settings = { ...settings, ...s } } }
}

test('streams tokens through as they are generated, not after', { timeout: 10000 }, async (t) => {
  const r = await rig(t)
  const res = await r.call({ model: 'qwen3:14b', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  assert.strictEqual(res.status, 200)
  assert.match(res.headers.get('content-type'), /event-stream/)
  const t0 = Date.now()
  const arrivals = []
  let text = ''
  for await (const chunk of res.body) { arrivals.push(Date.now() - t0); text += Buffer.from(chunk).toString() }
  assert.match(text, /Hel/)
  assert.match(text, /\[DONE\]/)
  assert.ok(arrivals.length >= 2, `expected several chunks, got ${arrivals.length}`)
  assert.ok(arrivals[0] < 120, `first chunk after ${arrivals[0]}ms — it was buffered`)
})

test('refuses without a token, with a reused token, and for a model the token does not name', { timeout: 10000 }, async (t) => {
  const r = await rig(t)
  const body = { model: 'qwen3:14b', messages: [] }
  assert.strictEqual((await r.call(body, '')).status, 401)
  const tok = signToken({ key: KEY, nodeId: NODE, model: 'qwen3:14b' })
  assert.strictEqual((await r.call(body, tok)).status, 200)
  const again = await r.call(body, tok)
  assert.strictEqual(again.status, 401)
  assert.strictEqual((await again.json()).error.message, 'token already used')
  const other = signToken({ key: KEY, nodeId: NODE, model: 'phi4' })
  assert.strictEqual((await r.call(body, other)).status, 403)
  assert.strictEqual(r.up.seen.length, 1, 'only the one good request reached the model server')
})

test('refuses a model this machine does not serve, and does not burn the token doing it', { timeout: 10000 }, async (t) => {
  const r = await rig(t, { served: ['phi4'] })
  const res = await r.call({ model: 'qwen3:14b', messages: [] })
  assert.strictEqual(res.status, 404)
  assert.strictEqual((await res.json()).error.code, 'model_not_served')
})

test('off means off, busy means 429, and max_tokens is capped', { timeout: 10000 }, async (t) => {
  const r = await rig(t, { settings: { max_concurrent: 1 } })
  r.setSettings({ enabled: false })
  assert.strictEqual((await r.call({ model: 'qwen3:14b', messages: [] })).status, 503)
  r.setSettings({ enabled: true })

  const first = r.call({ model: 'qwen3:14b', stream: true, messages: [], max_tokens: 99999 })
  await new Promise((res) => setTimeout(res, 50))
  const second = await r.call({ model: 'qwen3:14b', messages: [] })
  assert.strictEqual(second.status, 429)
  assert.strictEqual(second.headers.get('retry-after'), '2')
  const f = await first
  for await (const _ of f.body) {}
  assert.strictEqual(r.up.seen[0].max_tokens, 100)

  await r.call({ model: 'qwen3:14b', messages: [] })
  assert.strictEqual(r.up.seen[1].max_tokens, 100, 'a request with no max_tokens gets the cap')
})

test('only /v1/chat/completions and /healthz exist; healthz says nothing about models', { timeout: 10000 }, async (t) => {
  const r = await rig(t)
  assert.deepStrictEqual(await (await fetch(`${r.base}/healthz`)).json(), { ok: true })
  assert.strictEqual((await fetch(`${r.base}/v1/models`)).status, 404)
  assert.strictEqual((await fetch(`${r.base}/api/sessions/claude-code`)).status, 404)
})

test('the switch: missing file is off; the report says so explicitly, and lists served models when on', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inf-'))
  assert.strictEqual(readSettings(home).enabled, false)
  const localModels = { report: () => ({ available: true, models: ['qwen3:14b', 'phi4', 'nomic-embed-text'] }) }
  const ep = new InferenceEndpoint({ getKey: () => KEY, getNodeId: () => NODE, localModels, home, upstream: () => 'http://x', log: () => {} })
  assert.deepStrictEqual(ep.report(), { enabled: false }, 'off is said out loud, so the hub stops routing')
  fs.mkdirSync(path.join(home, '.iris'))
  fs.writeFileSync(path.join(home, '.iris', 'inference.json'), JSON.stringify({ enabled: true, url: 'https://hive-001-ai.t.heyiris.io/', models: ['qwen3:14b', 'phi4'], port: 80 }))
  const rep = ep.report()
  assert.deepStrictEqual(rep.models, ['qwen3:14b', 'phi4'])
  assert.strictEqual(rep.url, 'https://hive-001-ai.t.heyiris.io')
  assert.strictEqual(rep.port, 3290, 'a privileged or invalid port falls back to the default')
  fs.writeFileSync(path.join(home, '.iris', 'inference.json'), JSON.stringify({ enabled: true, url: 'http://plain.example' }))
  assert.strictEqual(ep.report().url, null, 'only an https URL is reported')
})
