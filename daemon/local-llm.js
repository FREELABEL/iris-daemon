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

module.exports = {
  DEFAULT_MODEL,
  resolveLocalLlmConfig,
  guessServer,
  buildChatBody,
  buildCurlArgs,
  parseLocalLlmResponse,
  describeCurlExit,
  probeLocalLlm
}
