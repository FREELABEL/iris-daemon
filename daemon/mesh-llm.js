/**
 * Mesh LLM — shared compute on THIS machine's loopback (epic #187246, slice M2-daemon).
 *
 * Not to be confused with the other `mesh-*.js` modules here, which are the IRIS peer mesh.
 * This one talks to a Mesh LLM engine (mesh-llm / Buzz desktop), which serves an
 * OpenAI-compatible API on http://127.0.0.1:$IRIS_MESH_API_PORT/v1 (default 9337).
 *
 * Two things live here, so the tests run the same code the daemon runs:
 *
 *   1. meshCapability() — what the heartbeat reports: `llm_mesh` (bool, hard-filterable) and
 *      `llm_mesh_models` (advisory). True ONLY while GET /v1/models answers 200 with a non-empty
 *      `data` array. An engine that is up but has no model loaded cannot serve a task, so it
 *      must not attract one.
 *   2. runLlmInfer(task) — the `llm_infer` task type: one non-streaming chat completion
 *      against loopback, returned in the contract shape.
 *
 * Rules this module enforces rather than trusts (see the contract / ADRs):
 *   - The target is ALWAYS loopback. A task config naming a base_url/url/port/host is refused
 *     with bad_config — never ignored — so a caller who thinks they redirected the call learns
 *     that they did not.
 *   - Message contents are never logged: they may be sensitive. Model, latency, status only.
 *   - Nothing here throws into the heartbeat; a probe that fails reports false.
 */

const DEFAULT_PORT = 9337
const PROBE_TIMEOUT_MS = 1500
const PROBE_TTL_MS = 60 * 1000
const DEFAULT_TIMEOUT_MS = 180000
const MAX_TIMEOUT_MS = 600000

// Keys forwarded to /v1/chat/completions. Everything else in task.config is ignored (the cloud
// adds bookkeeping keys such as timeout_seconds), except the refused keys below.
const FORWARDED_KEYS = ['model', 'messages', 'tools', 'tool_choice', 'max_tokens', 'temperature', 'response_format']
// Keys that would steer the request somewhere other than loopback. Matched case-insensitively.
const REFUSED_KEYS = ['base_url', 'baseurl', 'url', 'port', 'host', 'hostname', 'endpoint']

function meshPort (env = process.env) {
  const n = Number.parseInt(env.IRIS_MESH_API_PORT, 10)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT
}

function meshBaseUrl (env = process.env) {
  return `http://127.0.0.1:${meshPort(env)}/v1`
}

function defaultFetch () {
  return typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null
}

// The deadline covers the WHOLE exchange — headers and body. Clearing it once headers arrive
// would let an engine that sends a 200 and then stalls hold the task open forever.
async function withDeadline (timeoutMs, fn) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fn(ctrl.signal)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Probe the loopback engine. Never throws.
 * @returns {Promise<{llm_mesh: boolean, llm_mesh_models: string[]}>}
 */
async function probeMesh ({ fetchImpl = defaultFetch(), timeoutMs = PROBE_TIMEOUT_MS, env = process.env } = {}) {
  const no = { llm_mesh: false, llm_mesh_models: [] }
  if (!fetchImpl) return no
  try {
    const body = await withDeadline(timeoutMs, async (signal) => {
      const res = await fetchImpl(`${meshBaseUrl(env)}/models`, { method: 'GET', signal })
      if (!res || res.status !== 200) return null
      return res.json()
    })
    const data = body && Array.isArray(body.data) ? body.data : []
    if (data.length === 0) return no
    const models = data
      .map(m => (m && typeof m.id === 'string' ? m.id : null))
      .filter(Boolean)
      .slice(0, 50)
    return { llm_mesh: true, llm_mesh_models: models }
  } catch {
    return no
  }
}

let _cache = null // { at, value }
let _inflight = null

function refreshMeshCapability (opts) {
  if (_inflight) return _inflight
  _inflight = probeMesh(opts)
    .then(value => { _cache = { at: Date.now(), value }; return value })
    .catch(() => { _cache = { at: Date.now(), value: { llm_mesh: false, llm_mesh_models: [] } }; return _cache.value })
    .finally(() => { _inflight = null })
  return _inflight
}

/**
 * Synchronous, for the heartbeat builder: returns the last probe and kicks off a refresh when
 * it is older than 60s. Returns {} until the first probe lands — absent is read server-side as
 * "not capable", which is the safe direction. When false, the model list is omitted.
 */
function meshCapability (opts) {
  if (!_cache || Date.now() - _cache.at >= PROBE_TTL_MS) refreshMeshCapability(opts)
  if (!_cache) return {}
  const v = _cache.value
  return v.llm_mesh ? { llm_mesh: true, llm_mesh_models: v.llm_mesh_models } : { llm_mesh: false }
}

function _resetCacheForTests () { _cache = null; _inflight = null }

function fail (code, message) {
  return { ok: false, error: { code, message } }
}

/**
 * Validate task.config. Returns { body, timeoutMs } or { error } in the contract shape.
 */
function buildRequest (config) {
  let cfg = config
  if (typeof cfg === 'string') {
    try { cfg = JSON.parse(cfg) } catch { return { error: fail('bad_config', 'llm_infer config is not valid JSON') } }
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { error: fail('bad_config', 'llm_infer requires a config object with model and messages') }
  }
  const refused = Object.keys(cfg).filter(k => REFUSED_KEYS.includes(k.toLowerCase()))
  if (refused.length) {
    return {
      error: fail('bad_config', `llm_infer refuses ${refused.join(', ')}: the target is always this node's loopback mesh (127.0.0.1:$IRIS_MESH_API_PORT). Remove the key.`)
    }
  }
  if (typeof cfg.model !== 'string' || cfg.model.trim() === '') {
    return { error: fail('bad_config', 'llm_infer requires config.model (a string, e.g. "mesh")') }
  }
  if (!Array.isArray(cfg.messages) || cfg.messages.length === 0) {
    return { error: fail('bad_config', 'llm_infer requires config.messages (a non-empty array)') }
  }
  let timeoutMs = DEFAULT_TIMEOUT_MS
  if (cfg.timeout_ms !== undefined && cfg.timeout_ms !== null) {
    const t = Number(cfg.timeout_ms)
    if (!Number.isFinite(t) || t <= 0) {
      return { error: fail('bad_config', 'llm_infer config.timeout_ms must be a positive number of milliseconds') }
    }
    timeoutMs = Math.min(Math.floor(t), MAX_TIMEOUT_MS)
  }
  const body = { stream: false }
  for (const k of FORWARDED_KEYS) {
    if (cfg[k] !== undefined) body[k] = cfg[k]
  }
  body.stream = false
  return { body, timeoutMs }
}

/**
 * Run one chat completion against loopback. Never throws.
 * @returns {Promise<{ok:true, response:object, latency_ms:number} | {ok:false, error:{code:string, message:string}}>}
 */
async function inferMesh (config, { fetchImpl = defaultFetch(), env = process.env } = {}) {
  const req = buildRequest(config)
  if (req.error) return req.error
  if (!fetchImpl) return fail('mesh_unreachable', 'this daemon\'s Node.js has no fetch(); update Node to 18+')

  const started = Date.now()
  let stage = 'connect'
  try {
    return await withDeadline(req.timeoutMs, async (signal) => {
      const res = await fetchImpl(`${meshBaseUrl(env)}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer mesh-local' },
        body: JSON.stringify(req.body),
        signal
      })
      stage = 'read'
      if (res.status < 200 || res.status >= 300) {
        let detail = ''
        try { detail = (await res.text()).slice(0, 300) } catch (e) { if (e && e.name === 'AbortError') throw e }
        return fail(`mesh_http_${res.status}`, `mesh answered HTTP ${res.status}${detail ? `: ${detail}` : ''}`)
      }
      const text = await res.text()
      let response
      try {
        response = JSON.parse(text)
      } catch {
        return fail('mesh_unreachable', `mesh answered HTTP ${res.status} with a body that is not JSON`)
      }
      return { ok: true, response, latency_ms: Date.now() - started }
    })
  } catch (e) {
    if (e && e.name === 'AbortError') return fail('timeout', `mesh did not answer within ${req.timeoutMs}ms`)
    if (stage === 'connect') {
      return fail('mesh_unreachable', `could not reach the mesh on 127.0.0.1:${meshPort(env)} (${(e && ((e.cause && e.cause.code) || e.message)) || 'error'})`)
    }
    return fail('mesh_unreachable', `mesh response could not be read (${e && e.message})`)
  }
}

/**
 * The task-executor entry point: returns the submitResult payload. The contract result is
 * `data`; `output` carries it as a string for readers of the legacy field.
 */
async function runLlmInfer (task, opts = {}) {
  const started = Date.now()
  const result = await inferMesh(task && task.config, opts)
  const model = task && task.config && typeof task.config === 'object' ? task.config.model : undefined
  const code = result.ok ? 'ok' : result.error.code
  // Model, latency and status only — never message contents.
  console.log(`[llm-infer] model=${typeof model === 'string' ? model.slice(0, 80) : '-'} status=${code} latency=${result.ok ? result.latency_ms : Date.now() - started}ms`)
  return {
    status: result.ok ? 'completed' : 'failed',
    data: result,
    output: JSON.stringify(result),
    ...(result.ok ? {} : { error: `${result.error.code}: ${result.error.message}` }),
    duration_ms: Date.now() - started,
    metadata: { llm_infer: true, model: typeof model === 'string' ? model : null, code, latency_ms: result.ok ? result.latency_ms : null }
  }
}

module.exports = {
  meshPort,
  meshBaseUrl,
  probeMesh,
  meshCapability,
  refreshMeshCapability,
  buildRequest,
  inferMesh,
  runLlmInfer,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  _resetCacheForTests
}
