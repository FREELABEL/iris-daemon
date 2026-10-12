#!/usr/bin/env node
'use strict'

/**
 * Watch production and file a ticket when something changes (#189151).
 *
 *   node scripts/prod-watch.js              probe, compare with last run, file tickets for new incidents
 *   node scripts/prod-watch.js --dry-run    same, but print the ticket instead of filing it
 *
 * Run on a schedule (every 10 min) on a node:
 *   cp scripts/prod-watch.js daemon/prod-watch.js → ~/.iris/daemon-data/scripts/  (see --install)
 *   iris hive schedule add prod-watch.js --cron "*\/10 * * * *"
 *
 * State (latency history, component baseline, open incidents) lives in
 * ~/.iris/prod-watch/state.json. Probes are public health endpoints only; nothing here holds a
 * credential. Tickets go through `iris bug report`, which also shows any existing report with a
 * similar title (#189153).
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

// Installed beside this script by --install; in the repo it sits in ../daemon.
const W = fs.existsSync(path.join(__dirname, 'prod-watch-core.js'))
  ? require('./prod-watch-core.js')
  : require('../daemon/prod-watch')

const PROBES = [
  { name: 'heyiris.io', url: 'https://heyiris.io/api/health' },
  { name: 'freelabel.net', url: 'https://freelabel.net/api/health' },
]
const STATE = path.join(os.homedir(), '.iris', 'prod-watch', 'state.json')

async function probe (url) {
  const t0 = Date.now()
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'iris-prod-watch' } })
    const ms = Date.now() - t0
    let body = null
    try { body = await res.json() } catch {}
    return { http: res.status, ms, body }
  } catch {
    return { http: null, ms: null, body: null }
  }
}

function file (title, description, dry) {
  if (dry) { console.log(`  would file: ${title}\n    ${description.replace(/\n/g, '\n    ')}`); return }
  const r = spawnSync('iris', ['bug', 'report', '--title', title, '--description', description, '--severity', 'high', '--command', 'prod-watch'], { encoding: 'utf-8', timeout: 90000 })
  const id = ((r.stdout || '').match(/Item ID:\D*#?(\d+)/) || [])[1]
  console.log(r.status === 0 ? `  filed ${id ? '#' + id : ''} ${title}` : `  could not file "${title}": ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`)
}

async function main () {
  const argv = process.argv.slice(2)
  if (argv.includes('--install')) {
    const dir = path.join(os.homedir(), '.iris', 'daemon-data', 'scripts')
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(__filename, path.join(dir, 'prod-watch.js'))
    fs.copyFileSync(path.join(__dirname, '..', 'daemon', 'prod-watch.js'), path.join(dir, 'prod-watch-core.js'))
    console.log(`installed to ${dir} — now: iris hive schedule add prod-watch.js --cron "*/10 * * * *"`)
    return
  }
  const dry = argv.includes('--dry-run')
  let all = {}
  try { all = JSON.parse(fs.readFileSync(STATE, 'utf-8')) } catch {}
  const now = new Date()
  for (const p of PROBES) {
    const sample = await probe(p.url)
    const { state, opened, closed } = W.evaluate(all[p.name], sample, { now })
    all[p.name] = state
    const line = `${p.name}: ${sample.http ?? 'no answer'}${sample.ms != null ? ` · ${sample.ms} ms` : ''}`
    console.log(line + (opened.length ? ` · ${opened.length} new incident(s)` : '') + (closed.length ? ` · recovered: ${closed.join(', ')}` : ''))
    for (const o of opened) {
      file(`[prod-watch] ${p.name}: ${o.detail}`,
        `Production watch (#189151) saw a change on ${p.url} at ${now.toISOString()}.\n\n${o.detail}.\n\nIncident key: ${o.key}. Filed once; it will not be re-filed while it stays open, and the watch log shows when it recovers.\n\nNext: reproduce it, then fix it fail-first (a test that fails on the current code) — node scripts/fail-first.js in iris-daemon.`,
        dry)
    }
  }
  if (!dry) {
    fs.mkdirSync(path.dirname(STATE), { recursive: true })
    fs.writeFileSync(STATE, JSON.stringify(all, null, 1), { mode: 0o600 })
  }
}

main().catch((e) => { console.error(e.message); process.exit(1) })
