'use strict'

/**
 * Whole-disk file search on a node (#188665).
 *
 * `iris hive search` used to search only the Hive inbox (files other nodes SENT this one) and
 * iMessage. "Where is that file?" across your own machines was not answerable, though every Mac
 * already keeps an index of its whole disk. This picks the best index the node has:
 *
 *   1. fsearch  (github.com/noahdunnagan/fsearch, MIT) — ~1 ms by name, typo-tolerant, content
 *               search with `grep:`. macOS only, built from source; used whenever it is installed.
 *   2. mdfind   — Spotlight. On every Mac, whole disk, no install.
 *   3. plocate / locate — Linux, when a locate database exists.
 *   4. find     — last resort: the home folder only, time-boxed, and labelled as a scan so nobody
 *                 mistakes "nothing found in 8 s of $HOME" for "not on this machine".
 *
 * Every backend is run with execFile (argv, never a shell) — the query is user text.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const TIMEOUT_MS = 8000

function onPath (name, env = process.env) {
  const extra = [path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.cargo', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
  for (const dir of [...String(env.PATH || '').split(path.delimiter), ...extra]) {
    if (!dir) continue
    const p = path.join(dir, name)
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch {}
  }
  return null
}

/** Which backend this node would use, in order of preference. Pure given its inputs. */
function pickBackend ({ platform = process.platform, which = onPath, locateDbExists = defaultLocateDb } = {}) {
  const fsearch = platform === 'darwin' ? which('fsearch') : null
  if (fsearch) return { name: 'fsearch', bin: fsearch, wholeDisk: true }
  if (platform === 'darwin') {
    const mdfind = which('mdfind') || (fs.existsSync('/usr/bin/mdfind') ? '/usr/bin/mdfind' : null)
    if (mdfind) return { name: 'spotlight', bin: mdfind, wholeDisk: true }
  }
  if (platform === 'linux') {
    for (const n of ['plocate', 'locate']) {
      const b = which(n)
      if (b && locateDbExists()) return { name: n, bin: b, wholeDisk: true }
    }
  }
  if (platform !== 'win32') {
    const find = which('find')
    if (find) return { name: 'scan', bin: find, wholeDisk: false }
  }
  return null
}

function defaultLocateDb () {
  return ['/var/lib/plocate/plocate.db', '/var/lib/mlocate/mlocate.db', '/var/lib/locate/locatedb'].some((p) => fs.existsSync(p))
}

/** The argv for a backend. The query is ONE argv element; nothing here is a shell string. */
function commandFor (backend, query, limit, home = os.homedir()) {
  const n = String(Math.max(1, Math.min(Number(limit) || 10, 200)))
  switch (backend.name) {
    case 'fsearch': return [backend.bin, [`${query} limit:${n}`, '--json']]
    case 'spotlight': return [backend.bin, ['-name', query]]
    case 'plocate':
    case 'locate': return [backend.bin, ['-i', '-l', n, '--', query]]
    case 'scan': {
      // -iname wildcards are find's own, not a shell's; escape the ones the user typed.
      const pat = `*${query.replace(/[\\*?[\]]/g, (c) => '\\' + c)}*`
      return [backend.bin, [home, '-xdev', '-maxdepth', '8', '(', '-name', '.*', '-o', '-name', 'node_modules', ')', '-prune', '-o', '-iname', pat, '-print']]
    }
  }
  throw new Error(`unknown backend ${backend.name}`)
}

/** Backend stdout → [{ path, score? }]. */
function parseOutput (backend, stdout, limit) {
  const n = Math.max(1, Number(limit) || 10)
  if (backend.name === 'fsearch') {
    let v = null
    for (const line of String(stdout).split('\n')) {
      const s = line.trim()
      if (!s.startsWith('{')) continue
      try { v = JSON.parse(s) } catch {}
    }
    if (!v) return []
    if (v.ok === false) throw new Error(v.error || 'fsearch failed')
    return (v.hits || []).slice(0, n).map((h) => ({ path: String(h.path || ''), score: h.score ?? null })).filter((h) => h.path)
  }
  return String(stdout).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, n).map((p) => ({ path: p }))
}

/**
 * Run a backend WITHOUT blocking the daemon: hive_search runs inside the daemon process, and a
 * synchronous 8 s scan would stall heartbeats and every other task for those 8 s. Line-based
 * backends are stopped as soon as they have printed `limit` paths — `find` otherwise keeps
 * walking until the time box even after it has its answer.
 */
function runBackend (bin, args, { limit = 10, lineBased = true, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let out = ''
    let done = false
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    const finish = (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { child.kill('SIGKILL') } catch {}
      // A scan stopped by the time box, or `find` complaining about one unreadable folder,
      // still printed real results first. Keep them.
      if (err && !out) reject(err)
      else resolve(out)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    child.stdout.on('data', (b) => {
      out += b
      if (out.length > 8 * 1024 * 1024) finish(null)
      else if (lineBased && out.split('\n').filter(Boolean).length >= limit) finish(null)
    })
    child.on('error', (e) => finish(e))
    // A non-zero exit with nothing printed means "no matches" for these tools (`find` exits 1 on
    // any unreadable folder, locate exits 1 on no match) — not a failure to report. A backend
    // that could not START is the error case, and that arrives on 'error' above.
    child.on('close', () => finish(null))
  })
}

/**
 * Search this node's disk. Returns hive_search result rows plus which backend answered, so the
 * person reading them knows whether "no results" covered the whole disk or only a scan of $HOME.
 */
async function searchDisk (query, { limit = 10, backend = pickBackend(), run = runBackend } = {}) {
  const q = String(query || '').trim()
  if (!q) return { backend: backend && backend.name, rows: [] }
  if (!backend) return { backend: null, rows: [], note: 'no file index on this node' }
  const started = Date.now()
  const [bin, args] = commandFor(backend, q, limit)
  let hits = []
  try {
    hits = parseOutput(backend, await run(bin, args, { limit, lineBased: backend.name !== 'fsearch' }), limit)
  } catch (e) {
    return { backend: backend.name, rows: [], note: `file search failed: ${String(e.message || e).slice(0, 160)}` }
  }
  const took = Date.now() - started
  const rows = hits.map((h) => {
    let date = null
    try { date = fs.statSync(h.path).mtime.toISOString() } catch {}
    return {
      source: 'files',
      match: h.path,
      preview: backend.wholeDisk ? `found by ${backend.name} · ${took} ms` : `home-folder scan · ${took} ms`,
      date,
    }
  })
  return { backend: backend.name, wholeDisk: backend.wholeDisk, took_ms: took, rows }
}

module.exports = { pickBackend, commandFor, parseOutput, searchDisk, runBackend }
