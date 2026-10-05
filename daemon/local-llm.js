'use strict'

const http = require('http')
const https = require('https')

/**
 * The local model seam.
 *
 * A node used to reach a local model through exactly one door: Ollama's native API on
 * Ollama's default port (`localhost:11434/api/generate`). Every other server — MeshLLM,
 * LM Studio, vLLM, llama.cpp's own server — speaks the OpenAI chat-completions shape, and
 * so does Ollama itself under `/v1`. Speaking that shape here means the node depends on
 * none of them: point LOCAL_LLM_BASE_URL somewhere else and nothing else changes.
 *
 *   Ollama     http://localhost:11434/v1   (default — derived from OLLAMA_HOST if set)
 *   MeshLLM    http://localhost:9337/v1
 *   LM Studio  http://localhost:1234/v1
 *
 * The base URL comes from the NODE's environment only, never from the task. A task is
 * written by the hub; letting it name the URL would let anyone who can dispatch a task make
 * this machine POST the prompt to an address of their choosing. A task may pick the MODEL.
 */

const DEFAULT_MODEL = 'qwen3:8b'

/** Known servers by their default port. A guess for the profile, never a routing decision. */
const { requestJson } = require('./http-json')

const KNOWN_PORTS = {
  11434: 'ollama',
  9337: 'mesh-llm',
  1234: 'lm-studio',
  8000: 'vllm',
  8080: 'llama-server'
}

function trimSlash (s) {
  return String(s || '').trim().replace(/\/+$/, '')
}

/**
 * Where this node's local model server is, and what to ask it for.
 * @param {Object} task  hub task (only task.model / task.config.model are read)
 * @param {Object} env   process.env, injectable for tests
 */
function resolveLocalLlmConfig (task = {}, env = process.env) {
  let baseUrl = trimSlash(env.LOCAL_LLM_BASE_URL)
  let source = 'LOCAL_LLM_BASE_URL'
  if (!baseUrl) {
    // Keep honouring OLLAMA_HOST, which is what nodes were configured with before the seam.
    const ollamaHost = trimSlash(env.OLLAMA_HOST) || 'http://localhost:11434'
    baseUrl = `${/^https?:\/\//.test(ollamaHost) ? ollamaHost : `http://${ollamaHost}`}/v1`
    source = env.OLLAMA_HOST ? 'OLLAMA_HOST' : 'default'
  }
  const model = task.model || task.config?.model || env.LOCAL_LLM_MODEL || DEFAULT_MODEL
  // Local servers ignore the key; a hosted OpenAI-compatible gateway on the LAN may not.
  const apiKey = env.LOCAL_LLM_API_KEY || 'local'
  return { baseUrl, model, apiKey, source, server: guessServer(baseUrl) }
}

function guessServer (baseUrl) {
  try {
    const u = new URL(baseUrl)
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
    return KNOWN_PORTS[port] || 'openai-compatible'
  } catch {
    return 'unknown'
  }
}

/** The chat-completions request body for one prompt. */
function buildChatBody (task, cfg) {
  const messages = []
  if (task.config?.system_prompt) messages.push({ role: 'system', content: String(task.config.system_prompt) })
  messages.push({ role: 'user', content: String(task.prompt ?? '') })
  const body = { model: cfg.model, messages, stream: false }
  if (typeof task.config?.temperature === 'number') body.temperature = task.config.temperature
  if (Number.isInteger(task.config?.max_tokens)) body.max_tokens = task.config.max_tokens
  return body
}

/**
 * curl argv for the request. The body goes on STDIN (`--data-binary @-`), not argv: a prompt
 * in argv is visible to every user in `ps`, and a long one hits ARG_MAX and fails before the
 * model ever sees it.
 */
function buildCurlArgs (cfg) {
  return [
    '-sS', '-X', 'POST',
    `${cfg.baseUrl}/chat/completions`,
    '-H', 'Content-Type: application/json',
    '-H', `Authorization: Bearer ${cfg.apiKey}`,
    '--data-binary', '@-'
  ]
}

/**
 * Pull the answer out of whatever the server returned.
 * Returns { content } on success, { error } when the server answered with an error, and
 * { content: null } when the body is not JSON we recognise (caller keeps the raw output).
 *
 * A server that is up but refuses — unknown model, bad key — answers HTTP 4xx with a JSON
 * error and curl still exits 0. Without this the task "succeeded" with an error blob as
 * its result.
 */
function parseLocalLlmResponse (raw) {
  let parsed
  try {
    parsed = JSON.parse(String(raw || '').trim())
  } catch {
    return { content: null }
  }
  if (parsed && parsed.error) {
    const e = parsed.error
    return { error: typeof e === 'string' ? e : (e.message || JSON.stringify(e)) }
  }
  const choice = parsed?.choices?.[0]
  if (choice) {
    // MeshLLM sends `content: null` (with `reasoning_content`) where Ollama sends "" — both
    // are a missing answer, not an unrecognised body.
    const content = choice.message ? (choice.message.content ?? '') : choice.text
    if (typeof content === 'string') {
      // An empty answer is a failure, not a result. Measured on qwen3:8b under Ollama /v1 with
      // max_tokens 60: content "", finish_reason "length", the whole budget spent in a separate
      // `reasoning` field. Returned as-is, the task "succeeded" with nothing in it.
      if (!content.trim()) {
        const thought = choice.message?.reasoning || choice.message?.reasoning_content
        if (choice.finish_reason === 'length') {
          return { error: `ran out of tokens before answering${thought ? ' — the budget went on reasoning; raise max_tokens or use a non-reasoning model' : '; raise max_tokens'}` }
        }
        return { error: 'returned an empty answer' }
      }
      return { content, usage: parsed.usage || null, model: parsed.model || null }
    }
  }
  // Ollama's native shape, in case LOCAL_LLM_BASE_URL is pointed at a proxy that speaks it.
  if (typeof parsed?.response === 'string') return { content: parsed.response, usage: null, model: parsed.model || null }
  return { content: null }
}

/**
 * The chat-completions body for a whole agent turn: the conversation so far, plus the tools the
 * model may call. buildChatBody above is the one-prompt shape `local_llm` TASKS use; an agent needs
 * the history and the tools, or it can neither follow a conversation nor act.
 */
function buildConversationBody (args = {}, cfg) {
  if (!Array.isArray(args.messages) || args.messages.length === 0) {
    throw new Error('messages is required — a non-empty array of {role, content}')
  }
  const body = { model: cfg.model, messages: args.messages, stream: false }
  if (Array.isArray(args.tools) && args.tools.length) {
    body.tools = args.tools
    if (args.tool_choice) body.tool_choice = args.tool_choice
  }
  if (typeof args.temperature === 'number') body.temperature = args.temperature
  if (Number.isInteger(args.max_tokens)) body.max_tokens = args.max_tokens
  if (args.response_format) body.response_format = args.response_format
  return body
}

/**
 * One agent turn against this node's local model server (`local_llm.chat` over bridge_call).
 *
 * Returns the assistant MESSAGE — text, or tool calls — because an agent loop needs the
 * structure. Flattened to text (what a `local_llm` task returns) a tool call is unusable.
 * The server URL is the node's to choose (env), never the caller's: the cloud names a model, not
 * an address, so a dispatched call cannot be pointed at anything else on the node's network.
 *
 * Every failure throws with a NAMED reason — no server, server refused, empty answer — because
 * "the model failed" is three different problems with three different fixes.
 */
async function chat (args = {}, { env = process.env, timeoutMs = 10 * 60 * 1000 } = {}) {
  const cfg = resolveLocalLlmConfig({ model: args.model }, env)
  const body = buildConversationBody(args, cfg)
  // What one agent turn costs to READ — counts and characters only, never content. A CPU-only node
  // reads ~27 prompt tokens/s, so a 20K-token turn is ~12 minutes before the first word
  // (iris-hive-001, 2026-10-04). Without this line the only clue is Ollama's n_tokens.
  try {
    const sizes = body.messages.map((m) => `${m.role}:${String(m.content || '').length}`).join(' ')
    const toolChars = JSON.stringify(body.tools || []).length
    console.log(`[local_llm.chat] ${cfg.model} messages=${body.messages.length} [${sizes}] tools=${(body.tools || []).length} (${toolChars} chars)`)
  } catch { /* a log line must never fail the call */ }
  // node:http, not fetch(): fetch's hidden 300s headers timeout killed every turn longer than five
  // minutes at exactly 5m00s (see daemon/http-json.js). timeoutMs is now the only limit.
  let res
  try {
    res = await requestJson({
      method: 'POST',
      url: `${cfg.baseUrl}/chat/completions`,
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body,
      timeoutMs
    })
  } catch (e) {
    throw new Error(`No local model server answering at ${cfg.baseUrl} (${e.message})`)
  }
  const parsed = res.body
  if (!parsed) throw new Error(`Local model server at ${cfg.baseUrl} answered HTTP ${res.status} with a body that is not JSON`)
  if (parsed.error) {
    const e = parsed.error
    throw new Error(`Local model server at ${cfg.baseUrl} refused (${cfg.model}): ${typeof e === 'string' ? e : (e.message || JSON.stringify(e))}`)
  }
  const choice = parsed.choices?.[0]
  if (!choice?.message) throw new Error(`Local model server at ${cfg.baseUrl} returned no message (${cfg.model})`)
  const m = choice.message
  const toolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length ? m.tool_calls : null
  const content = typeof m.content === 'string' ? m.content : ''
  // Same rule as parseLocalLlmResponse: no text and no tool call is a failure, not an answer.
  if (!toolCalls && !content.trim()) {
    const thought = m.reasoning || m.reasoning_content
    throw new Error(choice.finish_reason === 'length'
      ? `${cfg.model} ran out of tokens before answering${thought ? ' — the budget went on reasoning' : ''}; raise max_tokens`
      : `${cfg.model} returned an empty answer`)
  }
  return {
    message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
    finish_reason: choice.finish_reason || null,
    usage: parsed.usage || null,
    model: parsed.model || cfg.model,
    server: cfg.server
  }
}

/** curl exit codes worth translating — the bare number reads as a model failure. */
function describeCurlExit (code, cfg) {
  switch (code) {
    case 6: return `Local model server host not found: ${cfg.baseUrl} (check LOCAL_LLM_BASE_URL)`
    case 7: return `No local model server answering at ${cfg.baseUrl} — start Ollama / MeshLLM there, or set LOCAL_LLM_BASE_URL`
    case 28: return `Local model server at ${cfg.baseUrl} timed out`
    case 52: return `Local model server at ${cfg.baseUrl} closed the connection without replying`
    default: return null
  }
}

/**
 * Ask the server what it has loaded (GET {base}/models). Never throws.
 * @returns {Promise<{available:boolean, base_url:string, server:string, source:string, model_count:number, models:string[], default_model:string}>}
 */
function probeLocalLlm (env = process.env, { timeoutMs = 3000 } = {}) {
  const cfg = resolveLocalLlmConfig({}, env)
  const base = { base_url: cfg.baseUrl, server: cfg.server, source: cfg.source, default_model: cfg.model }
  return new Promise((resolve) => {
    let url
    try { url = new URL(`${cfg.baseUrl}/models`) } catch {
      return resolve({ ...base, available: false, model_count: 0, models: [] })
    }
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.request(url, {
      method: 'GET',
      timeout: timeoutMs,
      headers: { Authorization: `Bearer ${cfg.apiKey}` }
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return resolve({ ...base, available: false, http_status: res.statusCode, model_count: 0, models: [] })
        }
        let models = []
        try {
          const parsed = JSON.parse(data)
          models = (parsed.data || parsed.models || []).map((m) => m.id || m.name).filter(Boolean)
        } catch { /* answered, but not a model list */ }
        resolve({ ...base, available: true, model_count: models.length, models })
      })
    })
    req.on('error', () => resolve({ ...base, available: false, model_count: 0, models: [] }))
    req.on('timeout', () => { req.destroy(); resolve({ ...base, available: false, model_count: 0, models: [] }) })
    req.end()
  })
}

/**
 * What this node's local model server can answer for, kept fresh in the background.
 *
 * The heartbeat sends `report()` every beat so the hub can route a `local_llm` task to a node
 * that can serve its model. Probed here, never inline: a heartbeat that waits on an HTTP call
 * is a heartbeat that can make a healthy node look dead. `report()` is null until the first
 * probe lands, and the caller OMITS the key then — absent means "no update", while an empty
 * list would tell the hub this node serves nothing, which is not known yet.
 */
class LocalModelReporter {
  constructor ({ env = process.env, intervalMs = 60000, probe = probeLocalLlm } = {}) {
    this.env = env
    this.intervalMs = intervalMs
    this.probe = probe
    this._report = null
    this._timer = null
  }

  async refresh () {
    try {
      const p = await this.probe(this.env)
      this._report = { available: p.available === true, server: p.server, models: p.models || [] }
    } catch {
      this._report = { available: false, server: null, models: [] }
    }
    return this._report
  }

  start () {
    this.refresh()
    this._timer = setInterval(() => this.refresh(), this.intervalMs)
    if (this._timer.unref) this._timer.unref()
    return this
  }

  stop () {
    if (this._timer) clearInterval(this._timer)
    this._timer = null
  }

  report () {
    return this._report
  }
}

module.exports = {
  LocalModelReporter,
  DEFAULT_MODEL,
  resolveLocalLlmConfig,
  guessServer,
  buildChatBody,
  buildConversationBody,
  chat,
  buildCurlArgs,
  parseLocalLlmResponse,
  describeCurlExit,
  probeLocalLlm
}
