'use strict'

const test = require('node:test')
const assert = require('node:assert')
const http = require('http')
const { createHandler, signToken, PROBE_MODEL } = require('../daemon/inference-endpoint')

/**
 * #192146: GET /healthz/model-server, the far end of the gateway's reachability probe. Real HTTP in
 * front, a fake model server behind.
 */

const KEY = 'node_live_TEST'
const NODE = 'node-1'
const on = { enabled: true, max_concurrent: 1, max_tokens: 100 }

async function serve (fetchFn, opts = {}) {
  const calls = []
  const handler = createHandler({
    getKey: () => KEY,
    getNodeId: () => NODE,
    served: () => ['real-model'],
    settings: () => opts.settings || on,
    upstream: () => 'http://model.test/v1',
    fetchFn: (u, o) => { calls.push(u); return fetchFn(u, o) },
    probeUpstreamMs: 80
  })
  const server = http.createServer((req, res) => handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() }
}

const probeToken = () => signToken({ key: KEY, nodeId: NODE, model: PROBE_MODEL })
const get = (base, token) => fetch(`${base}/healthz/model-server`, { headers: token ? { authorization: `Bearer ${token}` } : {} })

test('up: the model server answered its model list, and nothing was generated', async (t) => {
  const s = await serve(async () => new Response('{"data":[]}', { status: 200 }))
  t.after(() => s.close())
  const res = await get(s.base, probeToken())
  assert.strictEqual(res.status, 200)
  assert.deepStrictEqual(await res.json(), { ok: true, model_server: 'up' })
  assert.deepStrictEqual(s.calls, ['http://model.test/v1/models'])
})

test('down: connection refused reads as down, and says nothing of the private address', async (t) => {
  const s = await serve(async () => { throw new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:11434') })
  t.after(() => s.close())
  const body = await (await get(s.base, probeToken())).json()
  assert.strictEqual(body.model_server, 'down')
  assert.ok(!JSON.stringify(body).includes('11434'))
})

test('down: an error status from the model server reads as down', async (t) => {
  const s = await serve(async () => new Response('nope', { status: 500 }))
  t.after(() => s.close())
  assert.strictEqual((await (await get(s.base, probeToken())).json()).model_server, 'down')
})

test('slow: a model server that does not answer in time is slow, not down', async (t) => {
  const s = await serve((_u, o) => new Promise((_res, rej) => o.signal.addEventListener('abort', () => rej(o.signal.reason))))
  t.after(() => s.close())
  assert.strictEqual((await (await get(s.base, probeToken())).json()).model_server, 'slow')
})

test('it answers nothing without a signed probe token, and never touches the model server', async (t) => {
  const s = await serve(async () => new Response('{}'))
  t.after(() => s.close())
  assert.strictEqual((await get(s.base)).status, 401)
  assert.strictEqual((await get(s.base, signToken({ key: 'wrong', nodeId: NODE, model: PROBE_MODEL }))).status, 401)
  assert.strictEqual((await get(s.base, signToken({ key: KEY, nodeId: NODE, model: 'real-model' }))).status, 401, 'a completion token is not a probe token')
  assert.deepStrictEqual(s.calls, [])
})

test('a probe token works once', async (t) => {
  const s = await serve(async () => new Response('{}'))
  t.after(() => s.close())
  const token = probeToken()
  assert.strictEqual((await get(s.base, token)).status, 200)
  assert.strictEqual((await get(s.base, token)).status, 401)
})

test('a probe token cannot run a completion', async (t) => {
  const s = await serve(async () => new Response('{}'))
  t.after(() => s.close())
  const res = await fetch(`${s.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${probeToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: PROBE_MODEL, messages: [] })
  })
  assert.strictEqual(res.status, 404)
  assert.deepStrictEqual(s.calls, [])
})

test('serving switched off answers 503', async (t) => {
  const s = await serve(async () => new Response('{}'), { settings: { ...on, enabled: false } })
  t.after(() => s.close())
  assert.strictEqual((await get(s.base, probeToken())).status, 503)
})
