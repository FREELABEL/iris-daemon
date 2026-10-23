'use strict'

/**
 * Whether THIS machine answers whole-disk file searches, and the local route that answers them
 * (#188665, epic #188696 O3).
 *
 * WHY THE NODE DECIDES. A machine registered to an account is not always that person's machine:
 * qb-host-vanguard is a client's Windows server, and every `iris hive search` searched its whole
 * disk. A skip-list in the CLI only protects callers that carry it — an old CLI, the MCP tool, a
 * direct mesh call would all still search. So the refusal lives here, and the caller is only
 * TOLD about it (heartbeat `bridge_capabilities.file_search`) so it can skip the node up front.
 *
 *   ~/.iris/config.json   { "hive_search": { "files": false } }   → file search off on this node
 *
 * Absent means ON: every existing node keeps working. A refusal is always an explicit row that
 * says so — never an empty result, which reads as "no such file on that machine".
 *
 * THE ROUTE. `GET /api/files/search?q=&limit=` lets `iris hive search` reach a node directly over
 * ssh on the owner's Tailscale mesh (curl to 127.0.0.1 inside the ssh session) instead of through
 * the cloud task queue, which costs ~3 s. It is on the loopback-only listener, and it still
 * demands the operator key (X-Bridge-Key = ~/.iris/bridge-token, constant-time): loopback is not
 * an authentication boundary — any page that DNS-rebinds onto 127.0.0.1, or any local process of
 * another user, could otherwise list file names on this disk. Results pass through the same
 * patient-data guard as the hive_search task, so the direct path cannot return what the task path
 * would withhold.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const CONFIG_KEY = 'hive_search.files'

function readNodeConfig () {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.iris', 'config.json'), 'utf-8')) } catch { return {} }
}

const isOff = (v) => v === false || v === 0 || v === '0' || v === 'false' || v === 'off'

/** { enabled, reason } for whole-disk file search on this node. Default: enabled. */
function fileSearchPolicy ({ nodeConfig = readNodeConfig() } = {}) {
  const hs = nodeConfig && typeof nodeConfig === 'object' ? nodeConfig.hive_search : null
  const off = hs === false || (hs && typeof hs === 'object' && isOff(hs.files))
  if (off) {
    return {
      enabled: false,
      reason: `file search is turned off on this machine (${CONFIG_KEY} = false in ~/.iris/config.json)`
    }
  }
  return { enabled: true, reason: null }
}

/** The hive_search row for a node that refuses: explicit, never silently zero hits. */
function disabledRow (policy) {
  return { source: 'files', match: '(file search disabled)', preview: policy.reason, date: null, disabled: true }
}

/**
 * The file rows a hive_search task returns (before the patient-data guard). Off → one explicit
 * refusal row and the disk is never touched; on → the engine's hits, plus its note if any.
 */
async function fileRowsForSearch (query, { limit = 10, provider = null, nodeConfig, search } = {}) {
  const policy = fileSearchPolicy(nodeConfig === undefined ? {} : { nodeConfig })
  if (!policy.enabled) {
    console.log(`[hive-search] files refused: ${policy.reason}`)
    return [disabledRow(policy)]
  }
  try {
    const disk = await (search || require('./disk-search').searchDisk)(query, { limit, provider })
    const rows = (disk.rows || []).slice()
    if (disk.note) rows.push({ source: 'files', match: '(no file results)', preview: disk.note, date: null })
    console.log(`[hive-search] files via ${disk.backend || 'none'}: ${(disk.rows || []).length} hit(s)${disk.took_ms != null ? ` in ${disk.took_ms} ms` : ''}`)
    return rows
  } catch (e) {
    console.error(`[hive-search] file search failed: ${e.message}`)
    return [{ source: 'files', match: '(no file results)', preview: `file search failed: ${String(e.message || e).slice(0, 120)}`, date: null }]
  }
}

/** Heartbeat `bridge_capabilities.file_search` — what callers read to skip a node up front. */
function capability ({ nodeConfig, listProviders } = {}) {
  const policy = fileSearchPolicy(nodeConfig === undefined ? {} : { nodeConfig })
  if (!policy.enabled) return { available: false, reason: policy.reason, detail: null, functions: ['search_files'], route: true }
  let detail = null
  try {
    const p = (listProviders || require('./disk-search').listProviders)()
    const chosen = p.providers.find((x) => x.name === p.chosen)
    detail = chosen ? `${chosen.name} · ${chosen.coverage}` : null
  } catch { /* detail is a nicety */ }
  // route: this daemon serves GET /api/files/search, so a caller on the mesh may ask directly.
  return { available: true, reason: null, detail, functions: ['search_files'], route: true }
}

function safeEqual (a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

function readBridgeToken () {
  const file = process.env.IRIS_BRIDGE_TOKEN_FILE || path.join(os.homedir(), '.iris', 'bridge-token')
  try { return fs.readFileSync(file, 'utf-8').trim() || null } catch { return null }
}

/**
 * The route, without express, so every branch is testable: (query, headers) → { status, body }.
 * deps: { token, nodeConfig, search, guard } — each defaults to the real thing.
 */
async function handleFilesSearch (query = {}, headers = {}, deps = {}) {
  const token = deps.token !== undefined ? deps.token : readBridgeToken()
  const key = headers['x-bridge-key']
  // Fail closed: no token on this machine means nobody is the operator.
  if (!token || !safeEqual(String(key || ''), token)) {
    return { status: 403, body: { error: 'operator key required (X-Bridge-Key)' } }
  }
  const policy = fileSearchPolicy(deps.nodeConfig === undefined ? {} : { nodeConfig: deps.nodeConfig })
  if (!policy.enabled) return { status: 403, body: { disabled: true, error: policy.reason, rows: [disabledRow(policy)] } }

  const q = String(query.q || query.query || '').trim()
  if (!q) return { status: 400, body: { error: 'q is required' } }
  if (q.length > 500) return { status: 400, body: { error: 'q is too long' } }
  const limit = Math.max(1, Math.min(200, parseInt(query.limit || '10', 10) || 10))
  const provider = query.provider ? String(query.provider) : null

  const search = deps.search || require('./disk-search').searchDisk
  const guard = deps.guard || ((rows) => require('../lib/file-search-guard').guardSearchResults(rows, { task: null }))
  const started = Date.now()
  const r = await search(q, { limit, provider })
  const rows = (r.rows || []).slice()
  if (r.note) rows.push({ source: 'files', match: '(no file results)', preview: r.note, date: null })
  return {
    status: 200,
    body: {
      backend: r.backend || null,
      coverage: r.coverage || null,
      took_ms: r.took_ms != null ? r.took_ms : Date.now() - started,
      rows: guard(rows)
    }
  }
}

/** Mount on the daemon's express app (loopback listener). */
function mount (app, prefix = '') {
  app.get(`${prefix}/api/files/search`, async (req, res) => {
    try {
      const out = await handleFilesSearch(req.query || {}, req.headers || {})
      res.status(out.status).json(out.body)
    } catch (e) {
      res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 200) })
    }
  })
}

module.exports = { fileSearchPolicy, fileRowsForSearch, disabledRow, capability, handleFilesSearch, mount, safeEqual, CONFIG_KEY }
