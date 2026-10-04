const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const { chat, buildConversationBody } = require('../daemon/local-llm')
const registry = require('../daemon/bridge-registry')

// local_llm.chat — an AGENT turn on the node's own model server (EPIC #187884: PATTY on
// iris-hive-001). The one-prompt `local_llm` task flattens a tool call into text, which an agent
// loop cannot use, so this path returns the assistant MESSAGE. These tests check the wire (what
// the server was sent) as well as the result.

let server, base, lastBody, nextReply
before(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      lastBody = raw ? JSON.parse(raw) : null
      const { status = 200, body } = nextReply
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}/v1`
})
after(() => server.close())

const env = () => ({ LOCAL_LLM_BASE_URL: base })
const ask = { model: 'phi4:latest', messages: [{ role: 'user', content: 'hi' }] }

describe('local_llm.chat', () => {
  it('passes the conversation AND the tools through, and returns tool calls as structure', async () => {
    const tools = [{ type: 'function', function: { name: 'get_settlement_allocation', parameters: { type: 'object', properties: {} } } }]
    const call = { id: 'c1', type: 'function', function: { name: 'get_settlement_allocation', arguments: '{"gross":85000}' } }
    nextReply = { body: { model: 'phi4:latest', choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [call] } }] } }
    const history = [{ role: 'system', content: 'You are PATTY.' }, { role: 'user', content: 'net?' }]
    const out = await chat({ model: 'phi4:latest', messages: history, tools, tool_choice: 'auto' }, { env: env() })
    assert.deepEqual(lastBody.messages, history)
    assert.deepEqual(lastBody.tools, tools)
    assert.equal(lastBody.tool_choice, 'auto')
    assert.equal(lastBody.stream, false)
    assert.deepEqual(out.message.tool_calls, [call])
    assert.equal(out.finish_reason, 'tool_calls')
  })

  it('returns plain text when the model answers in words', async () => {
    nextReply = { body: { model: 'phi4:latest', usage: { completion_tokens: 3 }, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Hello.' } }] } }
    const out = await chat(ask, { env: env() })
    assert.equal(out.message.content, 'Hello.')
    assert.equal(out.message.tool_calls, undefined)
    assert.deepEqual(out.usage, { completion_tokens: 3 })
  })

  it('a refusing server is an ERROR naming the model, not a result', async () => {
    nextReply = { status: 404, body: { error: { message: 'model "phi9" not found' } } }
    await assert.rejects(chat({ ...ask, model: 'phi9' }, { env: env() }), /refused \(phi9\).*not found/)
  })

  it('an empty answer that ran out of tokens says so', async () => {
    nextReply = { body: { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '', reasoning: 'thinking…' } }] } }
    await assert.rejects(chat(ask, { env: env() }), /ran out of tokens.*reasoning/)
  })

  it('no server is named as no server', async () => {
    await assert.rejects(chat(ask, { env: { LOCAL_LLM_BASE_URL: 'http://127.0.0.1:9/v1' } }), /No local model server answering/)
  })

  it('messages are required', () => {
    assert.throws(() => buildConversationBody({ model: 'x' }, { model: 'x' }), /messages is required/)
  })

  it('the server address comes from the NODE, never from the request', async () => {
    nextReply = { body: { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] } }
    lastBody = null
    // A caller-supplied base_url must be ignored — the cloud names a model, not an address.
    await chat({ ...ask, base_url: 'http://169.254.169.254/latest' }, { env: env() })
    assert.ok(lastBody, 'the request went to the node-configured server')
    assert.equal(lastBody.base_url, undefined)
  })
})

describe('bridge registry', () => {
  it('declares local_llm.chat with a timeout long enough for a 14B model on CPU', () => {
    const fn = registry.PROVIDERS.local_llm.functions.chat
    assert.equal(fn.method, 'POST')
    assert.equal(fn.path, '/api/local-llm/chat')
    assert.ok(fn.timeoutMs >= 5 * 60 * 1000, `timeout ${fn.timeoutMs}ms is shorter than a CPU 14B answer`)
  })
})
