/**
 * Mesh LLM (epic #187246, slice M2-daemon) — the `llm_mesh` capability probe and the
 * `llm_infer` task type.
 *
 * The inference tests run the REAL module against a real HTTP server on an ephemeral loopback
 * port (IRIS_MESH_API_PORT), because the things that matter — the deadline covering a stalled
 * body, the target staying on loopback, a non-200 surfacing its status — are properties of the
 * wire, not of a mocked function.
 */
const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const fs = require('fs')
const path = require('path')
const mesh = require('../daemon/mesh-llm')

function jsonRes (status, body) {
  return { status, json: async () => body, text: async () => JSON.stringify(body) }
}

describe('llm_mesh capability probe', () => {
  it('is true with the model ids when /v1/models answers 200 with a non-empty data array', async () => {
    let seen
    const fetchImpl = async (url) => { seen = url; return jsonRes(200, { data: [{ id: 'mesh' }, { id: 'qwen3-8b' }] }) }
    const cap = await mesh.probeMesh({ fetchImpl, env: {} })
    assert.deepEqual(cap, { llm_mesh: true, llm_mesh_models: ['mesh', 'qwen3-8b'] })
    assert.equal(seen, 'http://127.0.0.1:9337/v1/models')
  })

  it('reads the port from IRIS_MESH_API_PORT', async () => {
    let seen
    const fetchImpl = async (url) => { seen = url; return jsonRes(200, { data: [{ id: 'm' }] }) }
    await mesh.probeMesh({ fetchImpl, env: { IRIS_MESH_API_PORT: '9444' } })
    assert.equal(seen, 'http://127.0.0.1:9444/v1/models')
  })

  it('is false when the engine is up but has no model loaded (empty data)', async () => {
    const cap = await mesh.probeMesh({ fetchImpl: async () => jsonRes(200, { data: [] }), env: {} })
    assert.equal(cap.llm_mesh, false)
    assert.deepEqual(cap.llm_mesh_models, [])
  })

  it('is false when data is missing or the status is not 200', async () => {
    assert.equal((await mesh.probeMesh({ fetchImpl: async () => jsonRes(200, {}), env: {} })).llm_mesh, false)
    assert.equal((await mesh.probeMesh({ fetchImpl: async () => jsonRes(503, { data: [{ id: 'm' }] }), env: {} })).llm_mesh, false)
  })

  it('is false, and does not throw, when nothing is listening', async () => {
    const fetchImpl = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }
    assert.equal((await mesh.probeMesh({ fetchImpl, env: {} })).llm_mesh, false)
  })

  it('is false after the timeout when the engine never answers', async () => {
    const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })
    const t0 = Date.now()
    const cap = await mesh.probeMesh({ fetchImpl, env: {}, timeoutMs: 50 })
    assert.equal(cap.llm_mesh, false)
    assert.ok(Date.now() - t0 < 1000, 'probe must give up at its timeout')
  })

  describe('meshCapability (heartbeat getter)', () => {
    beforeEach(() => mesh._resetCacheForTests())

    it('reports nothing until the first probe lands, then the cached result', async () => {
      const fetchImpl = async () => jsonRes(200, { data: [{ id: 'mesh' }] })
      assert.deepEqual(mesh.meshCapability({ fetchImpl, env: {} }), {})
      await mesh.refreshMeshCapability({ fetchImpl, env: {} })
      assert.deepEqual(mesh.meshCapability({ fetchImpl, env: {} }), { llm_mesh: true, llm_mesh_models: ['mesh'] })
    })

    it('reports llm_mesh:false (no model list) when the probe fails', async () => {
      const fetchImpl = async () => { throw new Error('down') }
      await mesh.refreshMeshCapability({ fetchImpl, env: {} })
      assert.deepEqual(mesh.meshCapability({ fetchImpl, env: {} }), { llm_mesh: false })
    })
  })
})

describe('llm_infer config refusals', () => {
  const base = { model: 'mesh', messages: [{ role: 'user', content: 'hi' }] }

  for (const key of ['base_url', 'url', 'port', 'host', 'BASE_URL']) {
    it(`refuses a config carrying ${key} with bad_config, before any request`, async () => {
      let called = false
      const r = await mesh.inferMesh({ ...base, [key]: 'http://evil.test' }, { fetchImpl: async () => { called = true } })
      assert.equal(r.ok, false)
      assert.equal(r.error.code, 'bad_config')
      assert.match(r.error.message, new RegExp(key))
      assert.equal(called, false, 'a refused config must never reach the network')
    })
  }

  it('requires model and a non-empty messages array', async () => {
    assert.equal((await mesh.inferMesh({ messages: base.messages })).error.code, 'bad_config')
    assert.equal((await mesh.inferMesh({ model: 'mesh', messages: [] })).error.code, 'bad_config')
    assert.equal((await mesh.inferMesh(null)).error.code, 'bad_config')
  })

  it('forwards only the whitelisted keys, forces stream:false, and caps timeout_ms at 600000', () => {
    const { body, timeoutMs } = mesh.buildRequest({ ...base, stream: true, temperature: 0.2, timeout_seconds: 5, secret: 'x', timeout_ms: 9e9 })
    assert.deepEqual(body, { stream: false, model: 'mesh', messages: base.messages, temperature: 0.2 })
    assert.equal(timeoutMs, 600000)
    assert.equal(mesh.buildRequest(base).timeoutMs, 180000)
    assert.equal(mesh.buildRequest({ ...base, timeout_ms: 'soon' }).error.error.code, 'bad_config')
  })
})

describe('llm_infer against a loopback stub engine', () => {
  let server
  let port
  let mode = 'ok'
  let lastBody
  const prevPort = process.env.IRIS_MESH_API_PORT

  before(async () => {
    server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', c => { raw += c })
      req.on('end', () => {
        lastBody = raw ? JSON.parse(raw) : null
        if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end() }
        if (mode === 'ok') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ id: 'cmpl-1', object: 'chat.completion', model: lastBody.model, choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }] }))
        }
        if (mode === '503') { res.writeHead(503); return res.end('no model loaded') }
        if (mode === 'stall-headers') return // never answer
        if (mode === 'stall-body') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"id":'); return }
      })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    port = server.address().port
    process.env.IRIS_MESH_API_PORT = String(port)
  })

  after(async () => {
    if (prevPort === undefined) delete process.env.IRIS_MESH_API_PORT
    else process.env.IRIS_MESH_API_PORT = prevPort
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
  })

  it('returns { ok, response, latency_ms } and sends a non-streaming request', async () => {
    mode = 'ok'
    const r = await mesh.inferMesh({ model: 'mesh', messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 })
    assert.equal(r.ok, true)
    assert.equal(r.response.choices[0].message.content, 'pong')
    assert.equal(typeof r.latency_ms, 'number')
    assert.equal(lastBody.stream, false)
    assert.equal(lastBody.max_tokens, 8)
  })

  it('runLlmInfer maps it to a completed submitResult payload with the contract result as data', async () => {
    mode = 'ok'
    const p = await mesh.runLlmInfer({ type: 'llm_infer', config: { model: 'mesh', messages: [{ role: 'user', content: 'ping' }] } })
    assert.equal(p.status, 'completed')
    assert.equal(p.data.ok, true)
    assert.deepEqual(JSON.parse(p.output), p.data)
    assert.equal(p.metadata.model, 'mesh')
  })

  it('a non-200 answer becomes mesh_http_<status>', async () => {
    mode = '503'
    const r = await mesh.inferMesh({ model: 'mesh', messages: [{ role: 'user', content: 'x' }] })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'mesh_http_503')
    const p = await mesh.runLlmInfer({ config: { model: 'mesh', messages: [{ role: 'user', content: 'x' }] } })
    assert.equal(p.status, 'failed')
    assert.match(p.error, /^mesh_http_503/)
  })

  it('times out when the engine never answers', async () => {
    mode = 'stall-headers'
    const r = await mesh.inferMesh({ model: 'mesh', messages: [{ role: 'user', content: 'x' }], timeout_ms: 150 })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'timeout')
  })

  it('times out when the engine sends 200 then stalls mid-body — the deadline covers the body', async () => {
    mode = 'stall-body'
    const r = await mesh.inferMesh({ model: 'mesh', messages: [{ role: 'user', content: 'x' }], timeout_ms: 150 })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'timeout')
  })

  it('reports mesh_unreachable when nothing listens on the port', async () => {
    const r = await mesh.inferMesh({ model: 'mesh', messages: [{ role: 'user', content: 'x' }] }, { env: { IRIS_MESH_API_PORT: '1' } })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'mesh_unreachable')
  })

  it('never logs message contents', async () => {
    mode = 'ok'
    const lines = []
    const orig = console.log
    console.log = (...a) => lines.push(a.join(' '))
    try {
      await mesh.runLlmInfer({ config: { model: 'mesh', messages: [{ role: 'user', content: 'SECRET-PHI-MARKER' }] } })
    } finally {
      console.log = orig
    }
    assert.ok(lines.length > 0)
    assert.ok(!lines.join('\n').includes('SECRET-PHI-MARKER'))
  })
})

describe('llm_infer wiring in the daemon', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'task-executor.js'), 'utf8')
  it('is a known structured type, so an old daemon never runs it as a shell command', () => {
    assert.match(src, /KNOWN_STRUCTURED_TYPES = new Set\(\[[^\]]*'llm_infer'/)
  })
  it('is short-circuited to mesh-llm.runLlmInfer', () => {
    assert.match(src, /task\.type === 'llm_infer'[\s\S]{0,400}runLlmInfer\(task\)/)
  })
  it('the heartbeat reports the mesh capability in task_capabilities', () => {
    const idx = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'index.js'), 'utf8')
    assert.match(idx, /task_capabilities:[\s\S]{0,1200}require\('\.\/mesh-llm'\)\.meshCapability\(\)/)
  })
})
