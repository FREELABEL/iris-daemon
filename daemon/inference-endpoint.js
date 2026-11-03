'use strict'

/**
 * This machine's models, served to the IRIS gateway (#191176, phase 1: the owner's own account).
 *
 *   gateway (fl-iris-api /api/v6/openai, model hive/<model>)
 *     ──https──▶ <name>.t.heyiris.io (Hive relay, blind byte pipe) ──▶ this server on 127.0.0.1
 *     ──▶ the local model server (Ollama / vLLM / llama-server / LM Studio, LOCAL_LLM_BASE_URL)
 *
 * The relay has no auth of its own: whatever listens behind a tunnel is on the public internet. So
 * this server answers NOTHING useful without a token the platform signed for this exact request:
 *
 *   hv1.<nodeId>.<expUnix>.<nonce>.<base64url(model)>.<hex hmac-sha256(nodeApiKey, "hv1|nodeId|exp|nonce|model")>
 *
 * The same key the platform already signs tasks with (NodeTaskController `_signature`), read live
 * because a healed node rotates it. A token is good for one model, on this node, once, for at most
 * MAX_TTL_S. The model must be one this node actually serves. Concurrency and max_tokens are capped
 * so a burst cannot take the machine — it is somebody's computer.
 *
 * Streaming is passed through untouched: the local server's SSE bytes go straight to the caller.
 * Off unless ~/.iris/inference.json says {"enabled": true}; `iris hive models serve on` writes it.
 */

const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')

const MAX_TTL_S = 300
const MAX_BODY = 2 * 1024 * 1024
// The model name in a probe token (#192146). Never a served model, so it cannot run a completion.
const PROBE_MODEL = '__probe__'
// How long the gateway's reachability probe waits for the local model server. It asks for the model
// list, which costs no generation; a server busy generating answers late, and that reads as `slow`.
const PROBE_UPSTREAM_MS = 2000
const DEFAULTS = { enabled: false, port: 3290, max_concurrent: 2, max_tokens: 8192, url: null, models: null, default_model: null }

const settingsFile = (home = os.homedir()) => path.join(home, '.iris', 'inference.json')

/** The owner's switch. Missing or unreadable = off. */
function readSettings (home) {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(home), 'utf8'))
    const s = { ...DEFAULTS, ...raw }
    s.enabled = raw.enabled === true
    s.port = Number.isInteger(s.port) && s.port > 1024 && s.port < 65536 ? s.port : DEFAULTS.port
    s.max_concurrent = Math.max(1, Math.min(16, Number(s.max_concurrent) || DEFAULTS.max_concurrent))
    s.max_tokens = Math.max(1, Math.min(131072, Number(s.max_tokens) || DEFAULTS.max_tokens))
    s.url = typeof s.url === 'string' && /^https:\/\//.test(s.url) ? s.url.replace(/\/+$/, '') : null
    s.models = Array.isArray(s.models) ? s.models.filter((m) => typeof m === 'string') : null
    s.default_model = typeof s.default_model === 'string' && s.default_model ? s.default_model : null
    return s
  } catch {
    return { ...DEFAULTS }
  }
}

const b64u = (s) => Buffer.from(s, 'utf8').toString('base64url')
const unb64u = (s) => Buffer.from(s, 'base64url').toString('utf8')
const mac = (key, nodeId, exp, nonce, model) =>
  crypto.createHmac('sha256', key).update(`hv1|${nodeId}|${exp}|${nonce}|${model}`).digest('hex')

/** What the platform does (mirrored in fl-iris-api HiveInferenceToken). Exported for tests. */
function signToken ({ key, nodeId, model, ttlS = 120, now = Date.now(), nonce = crypto.randomBytes(12).toString('hex') }) {
  const exp = Math.floor(now / 1000) + ttlS
  return `hv1.${nodeId}.${exp}.${nonce}.${b64u(model)}.${mac(key, nodeId, exp, nonce, model)}`
}

/**
 * Check a token. Returns {ok:true, model, nonce, exp} or {ok:false, why}. Never throws.
 * `seen(nonce)` must say whether the nonce was already used; recording it is the caller's job,
 * so a request refused for another reason does not burn the token.
 */
function verifyToken (token, { key, nodeId, now = Date.now(), seen = () => false }) {
  if (!key || !nodeId) return { ok: false, why: 'this node has no identity yet' }
  const parts = String(token || '').split('.')
  if (parts.length !== 6 || parts[0] !== 'hv1') return { ok: false, why: 'not a Hive inference token' }
  const [, tNode, tExp, nonce, tModel, sig] = parts
  if (tNode !== String(nodeId)) return { ok: false, why: 'token is for another node' }
  const exp = Number(tExp)
  const nowS = Math.floor(now / 1000)
  if (!Number.isInteger(exp) || exp < nowS) return { ok: false, why: 'token expired' }
  if (exp > nowS + MAX_TTL_S) return { ok: false, why: 'token lives too long' }
  if (!/^[a-f0-9]{16,64}$/.test(nonce)) return { ok: false, why: 'bad nonce' }
  let model
  try { model = unb64u(tModel) } catch { return { ok: false, why: 'bad model' } }
  const want = mac(key, tNode, exp, nonce, model)
  const a = Buffer.from(sig, 'utf8')
  const b = Buffer.from(want, 'utf8')
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, why: 'bad signature' }
  if (seen(nonce)) return { ok: false, why: 'token already used' }
  return { ok: true, model, nonce, exp }
}

/** Nonces until they expire. Bounded: a flood of valid tokens cannot grow it past `max`. */
class NonceBook {
  constructor (max = 10000) { this.max = max; this.map = new Map() }
  has (n, now = Date.now()) { this.sweep(now); return this.map.has(n) }
  add (n, expS) { if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value); this.map.set(n, expS) }
  sweep (now = Date.now()) { const s = Math.floor(now / 1000); for (const [n, e] of this.map) if (e < s) this.map.delete(n) }
}

function send (res, status, body, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...extra })
  res.end(JSON.stringify(body))
}

function readBody (req, max) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > max) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * The request handler, with everything it depends on injected so tests drive it without a model
 * server or a daemon: getKey/getNodeId (live identity), served() (models this node answers for),
 * settings() (the owner's switch and caps), upstream (base URL of the local server).
 */
function createHandler ({ getKey, getNodeId, served, settings, upstream, fetchFn = fetch, now = () => Date.now(), log = () => {}, probeUpstreamMs = PROBE_UPSTREAM_MS }) {
  const nonces = new NonceBook()
  let inFlight = 0

  /**
   * GET /healthz/model-server: the far end of the gateway's reachability probe (#192146). An answer
   * here proves relay, tunnel, TLS and this endpoint; the body says whether the model server behind
   * it is up. Signed like a completion, for PROBE_MODEL: what the owner runs is nobody else's to read.
   * It takes no concurrency slot, so a machine busy generating still answers.
   */
  async function probeModelServer (req, res) {
    if (!settings().enabled) return send(res, 503, { error: { message: 'this machine is not serving models right now', code: 'not_serving' } })
    const auth = String(req.headers.authorization || '')
    const v = verifyToken(auth.startsWith('Bearer ') ? auth.slice(7) : '', { key: getKey(), nodeId: getNodeId(), now: now(), seen: (n) => nonces.has(n, now()) })
    if (!v.ok || v.model !== PROBE_MODEL) return send(res, 401, { error: { message: v.ok ? 'not a probe token' : v.why, code: 'unauthorized' } })
    nonces.add(v.nonce, v.exp)
    try {
      const up = await fetchFn(`${upstream()}/models`, { signal: AbortSignal.timeout(probeUpstreamMs) })
      if (up.body && up.body.cancel) up.body.cancel().catch(() => {})
      return send(res, 200, up.ok ? { ok: true, model_server: 'up' } : { ok: false, model_server: 'down', detail: `HTTP ${up.status}` })
    } catch (err) {
      const slow = err && (err.name === 'TimeoutError' || err.name === 'AbortError')
      return send(res, 200, { ok: false, model_server: slow ? 'slow' : 'down', detail: slow ? `no answer within ${probeUpstreamMs} ms` : 'connection failed' })
    }
  }

  return async (req, res) => {
    const url = new URL(req.url, 'http://x')
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true })
    if (req.method === 'GET' && url.pathname === '/healthz/model-server') return probeModelServer(req, res)
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') return send(res, 404, { error: { message: 'not found' } })

    const s = settings()
    if (!s.enabled) return send(res, 503, { error: { message: 'this machine is not serving models right now', code: 'not_serving' } })

    const auth = String(req.headers.authorization || '')
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    const v = verifyToken(token, { key: getKey(), nodeId: getNodeId(), now: now(), seen: (n) => nonces.has(n, now()) })
    if (!v.ok) { log(`refused: ${v.why}`); return send(res, 401, { error: { message: v.why, code: 'unauthorized' } }) }

    let body
    try {
      body = JSON.parse(await readBody(req, MAX_BODY))
    } catch (err) {
      return send(res, err.status || 400, { error: { message: err.status ? err.message : 'body is not JSON' } })
    }
    if (!body || body.model !== v.model) return send(res, 403, { error: { message: 'the token is for a different model', code: 'model_mismatch' } })
    const models = served()
    if (!models.includes(v.model)) return send(res, 404, { error: { message: `this machine does not serve ${v.model}`, code: 'model_not_served' } })

    if (inFlight >= s.max_concurrent) {
      return send(res, 429, { error: { message: `this machine is busy (${inFlight}/${s.max_concurrent} running)`, code: 'node_busy' } }, { 'retry-after': '2' })
    }
    nonces.add(v.nonce, v.exp) // spent only once it is actually going to run
    inFlight++

    const cap = s.max_tokens
    const out = { ...body, model: v.model }
    for (const k of ['max_tokens', 'max_completion_tokens']) if (out[k] !== undefined) out[k] = Math.min(Number(out[k]) || cap, cap)
    if (out.max_tokens === undefined && out.max_completion_tokens === undefined) out.max_tokens = cap

    const ac = new AbortController()
    res.on('close', () => ac.abort())
    const started = now()
    try {
      const up = await fetchFn(`${upstream()}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(out),
        signal: ac.signal
      })
      res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json', 'cache-control': 'no-cache' })
      if (up.body) {
        for await (const chunk of up.body) {
          if (!res.write(chunk)) await new Promise((r) => res.once('drain', r))
        }
      }
      res.end()
      log(`served ${v.model} ${up.status} in ${now() - started}ms${out.stream ? ' (stream)' : ''}`)
    } catch (err) {
      if (!res.headersSent) send(res, 502, { error: { message: `the local model server did not answer: ${err.message}`, code: 'upstream_unreachable' } })
      else res.end()
    } finally {
      inFlight--
    }
  }
}

/**
 * The server, started and stopped as the owner's switch changes. `tick()` is called on the daemon's
 * model-probe interval; it never throws.
 */
class InferenceEndpoint {
  constructor ({ getKey, getNodeId, localModels, home, upstream, log = (m) => console.log(`[inference] ${m}`) }) {
    this.home = home
    this.localModels = localModels
    this.log = log
    this.server = null
    this.port = null
    this.handler = createHandler({
      getKey,
      getNodeId,
      settings: () => readSettings(home),
      served: () => this.served(),
      upstream,
      log
    })
  }

  /** Models this node answers for: what the local server has, narrowed by the owner's list. */
  served () {
    const r = this.localModels && this.localModels.report()
    const have = r && r.available ? r.models : []
    const s = readSettings(this.home)
    return s.models ? have.filter((m) => s.models.includes(m)) : have
  }

  tick () {
    try {
      const s = readSettings(this.home)
      if (s.enabled && (!this.server || this.port !== s.port)) this.start(s.port)
      if (!s.enabled && this.server) this.stop()
    } catch (err) {
      this.log(`tick failed: ${err.message}`)
    }
  }

  start (port) {
    if (this.server) this.stop()
    const server = http.createServer((req, res) => {
      this.handler(req, res).catch((err) => { try { send(res, 500, { error: { message: err.message } }) } catch {} })
    })
    server.on('error', (err) => { this.log(`cannot listen on 127.0.0.1:${port}: ${err.message}`); this.server = null })
    server.listen(port, '127.0.0.1', () => this.log(`serving on 127.0.0.1:${port}`))
    this.server = server
    this.port = port
  }

  stop () {
    if (!this.server) return
    this.server.close()
    this.server = null
    this.log('stopped')
  }

  /**
   * The heartbeat field. EXPLICIT when off: the hub keeps the last report when a key is absent
   * (that is how it treats an older daemon), so omitting it would leave a machine that said no
   * still routable until its report went stale.
   */
  report () {
    const s = readSettings(this.home)
    if (!s.enabled) return { enabled: false }
    const models = this.served()
    // The model to use when a request must stay on the owner's machines (PHI, `phi_local_only`)
    // and did not name one of them. Chosen by the owner; reported only if this machine serves it.
    const def = s.default_model && models.includes(s.default_model) ? s.default_model : null
    return { enabled: true, listening: !!this.server, url: s.url, port: s.port, models, default_model: def, max_concurrent: s.max_concurrent }
  }
}

module.exports = { InferenceEndpoint, createHandler, verifyToken, signToken, readSettings, settingsFile, NonceBook, MAX_TTL_S, PROBE_MODEL }
