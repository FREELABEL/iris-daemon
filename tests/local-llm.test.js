const { describe, it, before, after, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const os = require('os')
const {
  resolveLocalLlmConfig, buildChatBody, buildCurlArgs, parseLocalLlmResponse,
  describeCurlExit, probeLocalLlm, guessServer
} = require('../daemon/local-llm')
const { TaskExecutor } = require('../daemon/task-executor')

// A stand-in for any OpenAI-compatible server (Ollama /v1, MeshLLM, LM Studio).
// Records what it was sent so the tests can check the wire, not just the result.
function fakeServer (handler) {
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      handler(req, res, body)
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}/v1` })
  }))
}

function json (res, status, obj, pretty = false) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj, null, pretty ? 2 : 0))
}

describe('local model seam — config', () => {
  it('defaults to Ollama under /v1', () => {
    const c = resolveLocalLlmConfig({}, {})
    assert.equal(c.baseUrl, 'http://localhost:11434/v1')
    assert.equal(c.model, 'qwen3:8b')
    assert.equal(c.server, 'ollama')
    assert.equal(c.source, 'default')
  })

  it('keeps honouring OLLAMA_HOST, with or without a scheme', () => {
    assert.equal(resolveLocalLlmConfig({}, { OLLAMA_HOST: 'http://gpu-box:11434/' }).baseUrl, 'http://gpu-box:11434/v1')
    assert.equal(resolveLocalLlmConfig({}, { OLLAMA_HOST: '0.0.0.0:11434' }).baseUrl, 'http://0.0.0.0:11434/v1')
  })

  it('LOCAL_LLM_BASE_URL points it at MeshLLM with no other change', () => {
    const c = resolveLocalLlmConfig({}, { LOCAL_LLM_BASE_URL: 'http://localhost:9337/v1/', OLLAMA_HOST: 'http://x:11434' })
    assert.equal(c.baseUrl, 'http://localhost:9337/v1')
    assert.equal(c.server, 'mesh-llm')
    assert.equal(c.source, 'LOCAL_LLM_BASE_URL')
  })

  it('a task picks the model but can never pick the URL', () => {
    const task = { model: 'GLM-4.7-Flash-Q4_K_M', config: { base_url: 'http://attacker.example/v1', baseUrl: 'http://attacker.example/v1' } }
    const c = resolveLocalLlmConfig(task, {})
    assert.equal(c.model, 'GLM-4.7-Flash-Q4_K_M')
    assert.equal(c.baseUrl, 'http://localhost:11434/v1')
  })

  it('model precedence: task.model > task.config.model > LOCAL_LLM_MODEL > default', () => {
    const env = { LOCAL_LLM_MODEL: 'env-model' }
    assert.equal(resolveLocalLlmConfig({ model: 'a', config: { model: 'b' } }, env).model, 'a')
    assert.equal(resolveLocalLlmConfig({ config: { model: 'b' } }, env).model, 'b')
    assert.equal(resolveLocalLlmConfig({}, env).model, 'env-model')
  })

  it('guesses known servers by port and says so when it cannot', () => {
    assert.equal(guessServer('http://localhost:1234/v1'), 'lm-studio')
    assert.equal(guessServer('http://box:4000/v1'), 'openai-compatible')
    assert.equal(guessServer('not a url'), 'unknown')
  })
})

describe('local model seam — request and response', () => {
  it('the prompt never appears in argv', () => {
    const cfg = resolveLocalLlmConfig({}, {})
    const secret = 'PATIENT NAME 12345'
    const args = buildCurlArgs(cfg)
    assert.ok(!args.join(' ').includes(secret))
    assert.ok(args.includes('@-'))
    assert.ok(buildChatBody({ prompt: secret }, cfg).messages[0].content.includes(secret))
  })

  it('carries system prompt, temperature and max_tokens only when given', () => {
    const cfg = { model: 'm' }
    const plain = buildChatBody({ prompt: 'hi' }, cfg)
    assert.deepEqual(plain, { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false })
    const full = buildChatBody({ prompt: 'hi', config: { system_prompt: 'be brief', temperature: 0, max_tokens: 64 } }, cfg)
    assert.equal(full.messages[0].role, 'system')
    assert.equal(full.temperature, 0)
    assert.equal(full.max_tokens, 64)
  })

  it('reads the OpenAI shape, the legacy completions shape and Ollama native', () => {
    assert.equal(parseLocalLlmResponse('{"choices":[{"message":{"content":"hello"}}]}').content, 'hello')
    assert.equal(parseLocalLlmResponse('{"choices":[{"text":"legacy"}]}').content, 'legacy')
    assert.equal(parseLocalLlmResponse('{"response":"native"}').content, 'native')
  })

  it('a server error is an error, not a successful answer', () => {
    assert.equal(parseLocalLlmResponse('{"error":{"message":"model not found"}}').error, 'model not found')
    assert.equal(parseLocalLlmResponse('{"error":"bad key"}').error, 'bad key')
  })

  it('an empty answer is an error, and says why when the budget went on reasoning', () => {
    // Shape measured from qwen3:8b under Ollama /v1 with max_tokens 60.
    const starved = '{"choices":[{"message":{"role":"assistant","content":"","reasoning":"Okay, the user wants"},"finish_reason":"length"}]}'
    assert.match(parseLocalLlmResponse(starved).error, /ran out of tokens before answering — the budget went on reasoning/)
    assert.match(parseLocalLlmResponse('{"choices":[{"message":{"content":"  "},"finish_reason":"length"}]}').error, /raise max_tokens/)
    assert.equal(parseLocalLlmResponse('{"choices":[{"message":{"content":""},"finish_reason":"stop"}]}').error, 'returned an empty answer')
  })

  it('unrecognised output is left alone', () => {
    assert.equal(parseLocalLlmResponse('<html>502</html>').content, null)
    assert.equal(parseLocalLlmResponse('{"weird":1}').content, null)
  })

  it('translates the curl exits that read like model failures', () => {
    const cfg = { baseUrl: 'http://localhost:9337/v1' }
    assert.match(describeCurlExit(7, cfg), /No local model server answering at http:\/\/localhost:9337\/v1/)
    assert.equal(describeCurlExit(1, cfg), null)
  })
})

describe('local model seam — against a real server', () => {
  let srv
  const savedEnv = { ...process.env }

  afterEach(() => {
    for (const k of ['LOCAL_LLM_BASE_URL', 'LOCAL_LLM_MODEL', 'LOCAL_LLM_API_KEY']) {
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]
    }
    if (srv) srv.server.close()
    srv = null
  })

  function executor () {
    const ex = new TaskExecutor({}, {})
    return ex
  }

  it('runs a local_llm task end to end and returns only the answer', async () => {
    srv = await fakeServer((req, res, body) => {
      const b = JSON.parse(body)
      json(res, 200, { model: b.model, choices: [{ message: { role: 'assistant', content: `echo: ${b.messages.at(-1).content}\nline two` } }] }, true)
    })
    process.env.LOCAL_LLM_BASE_URL = srv.base
    const out = []
    const r = await executor().runRuntimeProcess(
      { id: 'task-local-1', type: 'local_llm', prompt: 'summarise this', model: 'Qwen3-8B-Q4_K_M' },
      'local_llm', { projectDir: os.tmpdir() }, out)

    assert.equal(r.exitCode, 0)
    assert.deepEqual(out, ['echo: summarise this', 'line two'])
    const sent = srv.seen[0]
    assert.equal(sent.url, '/v1/chat/completions')
    assert.equal(JSON.parse(sent.body).model, 'Qwen3-8B-Q4_K_M')
    assert.equal(sent.headers.authorization, 'Bearer local')
  })

  it('a server error fails the task and names the server and model', async () => {
    srv = await fakeServer((req, res) => json(res, 404, { error: { message: 'model "nope" not found' } }))
    process.env.LOCAL_LLM_BASE_URL = srv.base
    await assert.rejects(
      executor().runRuntimeProcess({ id: 'task-local-2', type: 'local_llm', prompt: 'x', model: 'nope' },
        'local_llm', { projectDir: os.tmpdir() }, []),
      (err) => /failed \(nope\): model "nope" not found/.test(err.message) && err.message.includes(srv.base))
  })

  it('nothing listening says so instead of "exited with code 7"', async () => {
    const probe = http.createServer().listen(0, '127.0.0.1')
    await new Promise((resolve) => probe.on('listening', resolve))
    const port = probe.address().port
    await new Promise((resolve) => probe.close(resolve))
    process.env.LOCAL_LLM_BASE_URL = `http://127.0.0.1:${port}/v1`
    await assert.rejects(
      executor().runRuntimeProcess({ id: 'task-local-3', type: 'local_llm', prompt: 'x' },
        'local_llm', { projectDir: os.tmpdir() }, []),
      /No local model server answering/)
  })

  it('the profile probe lists what the server has loaded', async () => {
    srv = await fakeServer((req, res) => json(res, 200, { object: 'list', data: [{ id: 'GLM-4.7-Flash-Q4_K_M' }, { id: 'Qwen3-8B-Q4_K_M' }] }))
    const p = await probeLocalLlm({ LOCAL_LLM_BASE_URL: srv.base })
    assert.equal(p.available, true)
    assert.deepEqual(p.models, ['GLM-4.7-Flash-Q4_K_M', 'Qwen3-8B-Q4_K_M'])
    assert.equal(p.base_url, srv.base)
    assert.equal(srv.seen[0].url, '/v1/models')
  })

  it('the profile probe reports unavailable rather than throwing', async () => {
    const p = await probeLocalLlm({ LOCAL_LLM_BASE_URL: 'http://127.0.0.1:1/v1' }, { timeoutMs: 500 })
    assert.equal(p.available, false)
    assert.equal(p.model_count, 0)
  })
})
