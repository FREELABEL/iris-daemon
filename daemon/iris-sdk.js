/**
 * @iris/sdk — Node.js SDK for the IRIS Platform
 *
 * Thin wrapper around the IRIS REST API. Designed to run on Hive nodes
 * where only Node.js is available (no PHP, no Docker, no iris-api).
 *
 * Auth: Reads from ~/.iris/sdk/.env (written by `iris-login` installer)
 * or accepts explicit { apiKey, apiUrl } in constructor.
 *
 * Usage:
 *   const IRIS = require('./iris-sdk')
 *   const iris = new IRIS()  // auto-reads ~/.iris/sdk/.env
 *
 *   const leads = await iris.leads.list({ type: 'competitor' })
 *   const brand = await iris.tools.invoke('websiteBrandExtractor', { url: 'https://stripe.com' })
 *   await iris.leads.update(123, { contact_info: { brand_theme: brand } })
 *
 *   // Heartbeats + Pulse (#189245) — the same rules as the Desktop Heartbeats panel
 *   const { matches } = await iris.heartbeats.query({ states: ['late', 'silent', 'failing'], since: '7d' })
 *   const linear = iris.sources.custom({ id: 'linear', read: async (q, { iris }) => ({ hits: 3, items: [] }) })
 *   const { lines } = await iris.pulse.run({ sources: [linear, iris.sources.heartbeats({ states: ['failing'] })] })
 *
 * Every method returns parsed JSON. Errors throw with status code + message.
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
// @heyiris/pulse-core, vendored and golden-checked (see vendor/README.md)
const core = require('./vendor/pulse-core.cjs')

// ============================================================================
// SDK Client
// ============================================================================

class IRIS {
  /**
   * @param {Object} opts
   * @param {string} [opts.apiKey] - API key (defaults to ~/.iris/sdk/.env IRIS_API_KEY)
   * @param {string} [opts.apiUrl] - fl-api base URL (defaults to https://raichu.heyiris.io)
   * @param {string} [opts.irisApiUrl] - iris-api base URL (defaults to https://freelabel.net)
   * @param {number} [opts.userId] - User ID (defaults to ~/.iris/sdk/.env IRIS_USER_ID)
   * @param {number} [opts.timeout] - Request timeout in ms (default: 30000)
   */
  constructor (opts = {}) {
    const env = this._readEnv()

    this.apiKey = opts.apiKey || env.IRIS_API_KEY || process.env.IRIS_API_KEY || ''
    this.apiUrl = (opts.apiUrl || env.IRIS_FL_API_URL || process.env.IRIS_FL_API_URL || 'https://raichu.heyiris.io').replace(/\/$/, '')
    this.irisApiUrl = (opts.irisApiUrl || env.IRIS_API_URL || process.env.IRIS_API_URL || 'https://freelabel.net').replace(/\/$/, '')
    this.userId = opts.userId || parseInt(env.IRIS_USER_ID || process.env.IRIS_USER_ID || '0', 10)
    this.timeout = opts.timeout || 30000
    this._readOnly = false
    this._bindResources()
  }

  _bindResources () {
    this.leads = new LeadsResource(this)
    this.tools = new ToolsResource(this)
    this.bloqs = new BloqsResource(this)
    this.pages = new PagesResource(this)
    this.schedule = new ScheduleResource(this)
    this.agents = new AgentsResource(this)
    this.heartbeats = new HeartbeatsResource(this)
    this.sources = new SourcesResource(this)
    this.pulse = new PulseResource(this)
  }

  /**
   * A client that only reads: any write is refused here, before it leaves the machine, and every
   * request carries `X-Iris-Read-Only: 1` so the server can refuse it too. This is what a pulse
   * run hands its sources — reading must never change what it measures. The original client is
   * untouched and can still write.
   */
  readOnly () {
    const ro = Object.create(this)
    ro._readOnly = true
    ro._bindResources()
    return ro
  }

  /** Read ~/.iris/sdk/.env */
  _readEnv () {
    const envPath = path.join(os.homedir(), '.iris', 'sdk', '.env')
    const env = {}
    try {
      const text = fs.readFileSync(envPath, 'utf-8')
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq > 0) {
          env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
        }
      }
    } catch {}
    return env
  }

  /**
   * Core fetch wrapper — handles auth, JSON parsing, errors.
   * @param {string} urlPath - API path (e.g., /api/v1/leads)
   * @param {Object} [options] - fetch options
   * @param {string} [base] - base URL override (defaults to this.apiUrl)
   * @returns {Promise<any>} parsed JSON response
   */
  async fetch (urlPath, options = {}, base) {
    const url = `${base || this.apiUrl}${urlPath}`
    const method = String(options.method || 'GET').toUpperCase()
    if (this._readOnly && method !== 'GET' && method !== 'HEAD') {
      const err = new Error(`read-only: ${method} ${urlPath} refused — this client only reads (inside a pulse run)`)
      err.readOnly = true
      throw err
    }
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {})
    }
    if (this._readOnly) headers['X-Iris-Read-Only'] = '1'
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)

    try {
      const res = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal
      })

      clearTimeout(timer)

      if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try {
          const body = await res.json()
          msg = body.error || body.message || msg
          if (body.errors) {
            msg += ': ' + Object.entries(body.errors)
              .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
              .join('; ')
          }
        } catch {}
        const err = new Error(msg)
        err.status = res.status
        throw err
      }

      const text = await res.text()
      if (!text) return {}
      return JSON.parse(text)
    } catch (err) {
      clearTimeout(timer)
      if (err.name === 'AbortError') {
        const timeout = new Error(`Request timed out after ${this.timeout}ms: ${urlPath}`)
        timeout.status = 408
        throw timeout
      }
      throw err
    }
  }

  /** Shorthand: GET */
  async get (path, params, base) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return this.fetch(`${path}${qs}`, {}, base)
  }

  /** Shorthand: POST */
  async post (path, body, base) {
    return this.fetch(path, { method: 'POST', body: JSON.stringify(body) }, base)
  }

  /** Shorthand: PUT */
  async put (path, body, base) {
    return this.fetch(path, { method: 'PUT', body: JSON.stringify(body) }, base)
  }

  /** Shorthand: DELETE */
  async del (path, base) {
    return this.fetch(path, { method: 'DELETE' }, base)
  }

  /** User-scoped fl-api path */
  _userPath (resource) {
    return `/api/v1/users/${this.userId}/${resource}`
  }
}

// ============================================================================
// Resource: Leads
// ============================================================================

class LeadsResource {
  constructor (client) { this.c = client }

  /** List leads. Options: { status, type, source, company, limit } */
  async list (opts = {}) {
    const params = {}
    if (opts.status) params.status = opts.status
    if (opts.type) params.lead_type = opts.type
    if (opts.source) params.source = opts.source
    if (opts.company) params.company = opts.company
    if (opts.limit) params.per_page = String(opts.limit)
    const res = await this.c.get(this.c._userPath('leads'), params)
    return res.data || res
  }

  /** Get lead by ID */
  async get (id) {
    const res = await this.c.get(this.c._userPath(`leads/${id}`))
    return res.data || res
  }

  /** Search leads by query string */
  async search (query, opts = {}) {
    return this.list({ ...opts, q: query })
  }

  /** Create a new lead */
  async create (data) {
    const res = await this.c.post(this.c._userPath('leads'), data)
    return res.data || res
  }

  /** Update a lead */
  async update (id, data) {
    const res = await this.c.put(this.c._userPath(`leads/${id}`), data)
    return res.data || res
  }

  /** Delete a lead */
  async delete (id) {
    return this.c.del(this.c._userPath(`leads/${id}`))
  }

  /** Add a note to a lead */
  async addNote (id, data) {
    const payload = typeof data === 'string' ? { content: data, type: 'general' } : data
    const res = await this.c.post(this.c._userPath(`leads/${id}/notes`), payload)
    return res.data || res
  }

  /** List competitors (leads with type=competitor) */
  async competitors (opts = {}) {
    return this.list({ ...opts, type: 'competitor' })
  }

  /** Add a competitor */
  async addCompetitor (data) {
    return this.create({ ...data, lead_type: 'competitor', source: 'competitor_intelligence' })
  }
}

// ============================================================================
// Resource: Tools
// ============================================================================

class ToolsResource {
  constructor (client) { this.c = client }

  /** List available tools */
  async list () {
    const res = await this.c.get('/api/v1/tools/list')
    return res.data || res
  }

  /**
   * Invoke a tool by name with params.
   * @param {string} name - Tool name (e.g., 'seoRankTracker')
   * @param {Object} params - Tool parameters
   * @returns {Promise<any>} Tool result (parsed JSON)
   */
  async invoke (name, params = {}) {
    const res = await this.c.post('/api/v1/tools/invoke', { tool: name, params })
    // Tool results are often JSON strings inside the response
    const result = res.result || res.data || res
    if (typeof result === 'string') {
      try { return JSON.parse(result) } catch {}
    }
    return result
  }
}

// ============================================================================
// Resource: Bloqs (Knowledge Bases)
// ============================================================================

class BloqsResource {
  constructor (client) { this.c = client }

  /** List bloqs */
  async list (opts = {}) {
    const params = {}
    if (opts.limit) params.per_page = String(opts.limit)
    const res = await this.c.get(this.c._userPath('bloqs'), params)
    return res.data || res
  }

  /** Get a bloq by ID */
  async get (id) {
    const res = await this.c.get(this.c._userPath(`bloqs/${id}`))
    return res.data || res
  }

  /** Add an item to a bloq list */
  async addItem (bloqId, listId, data) {
    const payload = typeof data === 'string' ? { content: data } : data
    const res = await this.c.post(this.c._userPath(`bloqs/${bloqId}/lists/${listId}/items`), payload)
    return res.data || res
  }

  /** Search bloq items */
  async search (bloqId, query) {
    const res = await this.c.get(this.c._userPath(`bloqs/${bloqId}/items`), { q: query })
    return res.data || res
  }
}

// ============================================================================
// Resource: Pages (Genesis Page Builder)
// ============================================================================

class PagesResource {
  constructor (client) { this.c = client }

  /** List pages */
  async list (opts = {}) {
    const params = {}
    if (opts.status) params.status = opts.status
    if (opts.limit) params.per_page = String(opts.limit)
    const res = await this.c.get('/api/v1/pages', params)
    return res.data || res
  }

  /** Get page by slug */
  async getBySlug (slug) {
    const res = await this.c.get(`/api/v1/pages/by-slug/${slug}`, { include_json: 'true' })
    return res.data || res
  }

  /** Create a page */
  async create (data) {
    const res = await this.c.post('/api/v1/pages', data)
    return res.data || res
  }

  /** Update a page */
  async update (id, data) {
    const res = await this.c.put(`/api/v1/pages/${id}`, data)
    return res.data || res
  }

  /** Publish a page */
  async publish (id) {
    const res = await this.c.post(`/api/v1/pages/${id}/publish`)
    return res.data || res
  }
}

// ============================================================================
// Resource: Schedule
// ============================================================================

class ScheduleResource {
  constructor (client) { this.c = client }

  /** List scheduled jobs */
  async list (opts = {}) {
    const params = {}
    if (opts.limit) params.per_page = String(opts.limit)
    if (opts.agentId) params.agent_id = String(opts.agentId)
    const res = await this.c.get(this.c._userPath('bloqs/scheduled-jobs'), params)
    return res.data || res
  }

  /** Create a scheduled job */
  async create (data) {
    const res = await this.c.post(this.c._userPath('bloqs/scheduled-jobs'), data)
    return res.data || res
  }

  /** Trigger a job to run now */
  async run (id) {
    const res = await this.c.post(this.c._userPath(`bloqs/scheduled-jobs/${id}/run`), {})
    return res.data || res
  }

  /** Delete a scheduled job */
  async delete (id) {
    return this.c.del(this.c._userPath(`bloqs/scheduled-jobs/${id}`))
  }
}

// ============================================================================
// Resource: Agents
// ============================================================================

class AgentsResource {
  constructor (client) { this.c = client }

  /** List agents */
  async list (opts = {}) {
    const params = {}
    if (opts.limit) params.per_page = String(opts.limit)
    const res = await this.c.get(this.c._userPath('bloqs/agents'), params)
    return res.data || res
  }

  /** Get agent by ID */
  async get (id) {
    const res = await this.c.get(this.c._userPath(`bloqs/agents/${id}`))
    return res.data || res
  }

  /** Chat with an agent */
  async chat (agentId, message, opts = {}) {
    const res = await this.c.post('/api/v6/chat/execute', {
      query: message,
      agent_id: agentId,
      user_id: this.c.userId,
      ...opts
    }, this.c.irisApiUrl)
    return res
  }
}

// ============================================================================
// Export
// ============================================================================

// ============================================================================
// Resource: Heartbeats (#189245)
// ============================================================================

/**
 * Your agents' heartbeats, with the Desktop panel's own rules (@heyiris/pulse-core): a state
 * here is the state the panel draws. A list that cannot be read THROWS (err.measured = false) —
 * it is never returned as an empty fleet.
 */
class HeartbeatsResource {
  constructor (client) { this.c = client }

  /** Every live heartbeat as a HeartbeatRow, each with its runs. Unread runs are marked, not empty. */
  async rows () {
    let list
    try {
      list = await this.c.get(this.c._userPath('bloqs/scheduled-jobs'), { agent_jobs_only: '1' })
    } catch (err) {
      err.measured = false
      err.message = `heartbeats not measured — ${err.message}`
      throw err
    }
    const jobs = core.unwrap(list).filter((j) => core.isHeartbeatJob(j) && core.LIVE_STATUSES.has(String(j.status)))
    return Promise.all(jobs.map(async (j) => {
      try {
        const runs = await this.c.get(this.c._userPath(`bloqs/scheduled-jobs/${j.id}/executions`), { limit: String(core.RUNS_PER_ROW) })
        return core.readHeartbeat(j, core.unwrap(runs))
      } catch {
        return core.readHeartbeat(j, null)
      }
    }))
  }

  /**
   * @param {Object} [q]
   * @param {string[]} [q.states] - late, silent, failing, running, ok, paused
   * @param {string|number} [q.since] - only states that began since: '30m', '24h', '7d', '2w', ISO or ms
   * @param {(number|string)[]} [q.agents] - agent ids or pieces of names
   * @param {number} [q.now] - the clock (ms), for a reproducible answer
   * @returns {Promise<{measured: true, now: string, counts: Object, matches: Object[]}>}
   */
  async query (q = {}) {
    const now = q.now ?? Date.now()
    // refuse a question that cannot be answered before spending a request on it
    core.queryHeartbeats([], { ...q, now })
    const res = core.queryHeartbeats(await this.rows(), { ...q, now })
    return {
      measured: true,
      now: res.now,
      counts: res.counts,
      matches: res.matches.map((m) => ({
        jobId: m.row.jobId,
        agentId: m.row.agentId,
        agentName: m.row.agentName,
        state: m.state,
        since: m.since,
        line: m.line,
        problems: m.problems,
        runsMeasured: m.row.runsMeasured
      }))
    }
  }
}

// ============================================================================
// Resource: Sources + Pulse (#189245)
// ============================================================================

const CUSTOM = 'custom · read-only not enforced'

/** What a custom read returned → a SourceResult. Anything unreadable throws (→ the stop is shut). */
function toResult (id, v, provenance) {
  if (typeof v === 'number' && Number.isFinite(v)) return { hits: v, items: [], measured: true, provenance }
  if (Array.isArray(v)) return { hits: v.length, items: v, measured: true, provenance }
  if (v && typeof v === 'object' && (Number.isFinite(v.hits) || Array.isArray(v.items))) {
    return {
      hits: Number.isFinite(v.hits) ? v.hits : v.items.length,
      items: Array.isArray(v.items) ? v.items : [],
      measured: v.measured !== false,
      reason: v.reason,
      floor: !!v.floor,
      provenance: [...(Array.isArray(v.provenance) ? v.provenance : []), ...provenance]
    }
  }
  throw new Error(`source "${id}" returned nothing readable — return a number, an array, or { hits, items }`)
}

class SourcesResource {
  constructor (client) { this.c = client }

  /**
   * Your own source. `read(query, { iris })` gets a READ-ONLY client; anything else it reaches
   * cannot be policed, so its numbers are labelled 'custom · read-only not enforced'.
   */
  custom (def = {}) {
    if (!def.id || typeof def.id !== 'string') throw new Error('sources.custom: needs an id')
    if (typeof def.read !== 'function') throw new Error(`sources.custom "${def.id}": needs a read(query, ctx) function`)
    const c = this.c
    const ctx = () => ({ iris: c.readOnly() })
    return {
      id: def.id,
      label: def.label || def.id,
      custom: true,
      read: async (query) => toResult(def.id, await def.read(query, ctx()), [CUSTOM]),
      isAvailable: def.isAvailable ? (query) => def.isAvailable(query, ctx()) : undefined
    }
  }

  /** Your agents' heartbeats as a source: hits = heartbeats matching `q` (see heartbeats.query). */
  heartbeats (q = {}) {
    const c = this.c
    return {
      id: 'heartbeats',
      label: 'Heartbeats',
      read: async () => {
        const r = await c.readOnly().heartbeats.query(q)
        return { hits: r.matches.length, items: r.matches, measured: true, counts: r.counts, provenance: [`fl-api ${c.apiUrl}${c._userPath('bloqs/scheduled-jobs')} (read-only)`] }
      }
    }
  }
}

class PulseResource {
  constructor (client) { this.c = client }

  /**
   * Walk sources (or full stops) and report each one. Read-only by construction; one source
   * failing never stops the route — it is SHUT with its reason, and never counted as 0.
   *
   * @param {Object} opts
   * @param {Object[]} [opts.sources] - from iris.sources.*
   * @param {Object[]} [opts.stops] - { id, source, extract(result, q), unavailable(reason, q) }
   * @param {*} [opts.query] - handed to every source's read
   * @param {'sequential'|'parallel'} [opts.mode]
   * @returns {Promise<{readOnly: true, outcomes: Object[], lines: string[]}>}
   */
  async run (opts = {}) {
    const stops = [
      ...(opts.stops || []),
      ...(opts.sources || []).map((source) => ({
        id: source.id,
        source,
        extract: (r) => ({ hits: r.hits, items: r.items, floor: !!r.floor }),
        unavailable: () => null
      }))
    ]
    if (!stops.length) throw new Error('pulse.run: give it sources or stops')
    const outcomes = await core.runScript({ route: 'custom', stops, readOnly: true, mode: opts.mode }, opts.query)
    const lines = outcomes.map((o) => `${o.id}: ${core.formatCount(o, o.output && Number.isFinite(o.output.hits) ? o.output.hits : 0)}`)
    return { readOnly: true, outcomes, lines }
  }
}

module.exports = IRIS
