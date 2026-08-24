#!/usr/bin/env node
/**
 * backfill-mentions-to-atlas.js — #182120
 *
 * ~/.iris/mentions/*.jsonl predates the Atlas 'mentions' dataset (#182118). Everything
 * captured before that shipped is real history, sitting only on whichever machine
 * detected it. This imports it into the cross-machine dataset so it isn't permanently
 * stranded.
 *
 * MUST run on each registered node separately — the files are local to each machine,
 * there is no way to read another node's local log from here.
 *
 * Idempotent: external_id is a content hash (node_id + chat + ts + text), not the local
 * file's line position, so re-running this after a daemon restart — or after #182118
 * pushes the SAME event again for some other reason — merges rather than duplicates.
 * Uses the bulk /import endpoint (up to IMPORT_MAX=1000 rows/request, chunked here),
 * not one POST per row — a local log can hold months of history.
 *
 * Usage:
 *   node scripts/backfill-mentions-to-atlas.js           # do it
 *   node scripts/backfill-mentions-to-atlas.js --dry-run  # show what would be imported
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const https = require('https')
const http = require('http')

const MENTIONS_DIR = path.join(os.homedir(), '.iris', 'mentions')
const API_URL = process.env.IRIS_FL_API_URL || 'https://raichu.heyiris.io'
const CHUNK_SIZE = 500 // under IMPORT_MAX (1000) with room to spare
const DRY_RUN = process.argv.includes('--dry-run')

function getApiToken () {
  if (process.env.IRIS_API_KEY) return process.env.IRIS_API_KEY
  try {
    const envFile = fs.readFileSync(path.join(os.homedir(), '.iris', 'sdk', '.env'), 'utf8')
    const match = envFile.match(/IRIS_API_KEY=(.+)/)
    if (match) return match[1].trim()
  } catch { /* no SDK .env */ }
  return null
}

function getLocalNodeIdentity () {
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port: 3200, path: '/daemon/health', method: 'GET', timeout: 3000 }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try {
          const body = JSON.parse(data)
          resolve(body.node_id ? { nodeId: body.node_id, nodeName: body.node_name || os.hostname() } : null)
        } catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.end()
  })
}

function postJSON (url, body, token) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const transport = parsed.protocol === 'https:' ? https : http
    const payload = JSON.stringify(body)
    const req = transport.request({
      hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      timeout: 60000,
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`))
        try { resolve(JSON.parse(data)) } catch { resolve({ raw: data }) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')) })
    req.write(payload)
    req.end()
  })
}

/** Stable external_id — same event pushed twice (a restart re-detecting, or a re-run of
 * this script) must land on the same id, not duplicate. */
function externalId (nodeId, row) {
  return crypto.createHash('sha1').update(`${nodeId}|${row.chat || ''}|${row.ts || ''}|${row.text || ''}`).digest('hex').slice(0, 32)
}

async function main () {
  if (!fs.existsSync(MENTIONS_DIR)) {
    console.log(`No local mentions directory at ${MENTIONS_DIR} — nothing to backfill.`)
    return
  }

  const identity = await getLocalNodeIdentity()
  if (!identity) {
    console.error('Could not read this node\'s identity from the local daemon (http://127.0.0.1:3200/daemon/health).')
    console.error('The daemon must be running — node_id is required so backfilled rows carry the same attribution live pushes do.')
    process.exitCode = 1
    return
  }

  const token = getApiToken()
  if (!token) {
    console.error('No IRIS_API_KEY found (env or ~/.iris/sdk/.env) — cannot authenticate to the Atlas API.')
    process.exitCode = 1
    return
  }

  const files = fs.readdirSync(MENTIONS_DIR).filter((f) => f.endsWith('.jsonl')).sort()
  const rows = []
  for (const file of files) {
    const lines = fs.readFileSync(path.join(MENTIONS_DIR, file), 'utf-8').split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const row = JSON.parse(line)
        rows.push({
          external_id: externalId(identity.nodeId, row),
          data: {
            ts: row.ts,
            sender: row.sender ?? null,
            lead_id: row.lead_id ?? null,
            lead_name: row.lead_name ?? null,
            chat: row.chat ?? null,
            is_group: !!row.is_group,
            text: (row.text || '').slice(0, 500),
            node_id: identity.nodeId,
            node_name: identity.nodeName,
          },
        })
      } catch { /* skip a malformed line rather than aborting the whole file */ }
    }
  }

  console.log(`${files.length} local file(s), ${rows.length} mention(s) found for node ${identity.nodeName} (${identity.nodeId}).`)
  if (DRY_RUN) {
    console.log('--dry-run: nothing sent. Sample row:', rows[0] ? JSON.stringify(rows[0], null, 2) : '(none)')
    return
  }
  if (!rows.length) return

  let created = 0, updated = 0, failed = 0
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE)
    try {
      const res = await postJSON(`${API_URL}/api/v1/atlas/datasets/mentions/import`, { records: chunk }, token)
      const d = res.data || res
      created += d.created || 0
      updated += d.updated || 0
      failed += d.failed_count || 0
      console.log(`  chunk ${Math.floor(i / CHUNK_SIZE) + 1}: +${d.created || 0} created, ~${d.updated || 0} updated, ${d.failed_count || 0} failed`)
    } catch (err) {
      console.error(`  chunk ${Math.floor(i / CHUNK_SIZE) + 1} failed entirely: ${err.message}`)
      failed += chunk.length
    }
  }
  console.log(`Done. ${created} created, ${updated} updated, ${failed} failed, out of ${rows.length} total.`)
}

main().catch((err) => { console.error(err); process.exitCode = 1 })
