'use strict'

/**
 * Find a file on this machine (#188665) — one search, a different engine per platform.
 *
 * `iris locate` (and `iris hive search --type files`) ask every node the same question; each node
 * answers with the best engine it has. Providers, in order of preference:
 *
 *   macOS    fsearch  (github.com/noahdunnagan/fsearch, MIT, no network code) — ~7 ms, typo-
 *                     tolerant, `grep:` searches inside files. Built from source; used when present.
 *            spotlight  mdfind — on every Mac, ~35 ms, misses hidden folders and typos.
 *   Linux    plocate / locate — whole disk, when a locate database exists.
 *   Windows  windows-search — the Windows Search index, built in. Covers INDEXED folders (the
 *                     user's folders by default), not the whole disk.
 *   any      scan — a time-boxed walk of the home folder, labelled as such, so "nothing in 8 s of
 *                     $HOME" is never read as "not on this machine".
 *
 * The query is user text: it is always ONE argv element, or (PowerShell) an environment variable
 * the script reads — never spliced into a shell or a script string.
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

function defaultLocateDb () {
  return ['/var/lib/plocate/plocate.db', '/var/lib/mlocate/mlocate.db', '/var/lib/locate/locatedb'].some((p) => fs.existsSync(p))
}

const clampLimit = (limit) => String(Math.max(1, Math.min(Number(limit) || 10, 200)))

// PowerShell reads the query from IRIS_Q, so nothing the user typed is ever part of the script.
// Windows Search SQL: double single quotes; [ ] make % _ [ literal inside LIKE.
const WINDOWS_SEARCH_PS = [
  "$q = ($env:IRIS_Q -replace \"'\", \"''\") -replace '([%_\\[])', '[$1]'",
  '$n = [int]$env:IRIS_N',
  '$c = New-Object -ComObject ADODB.Connection',
  "$c.Open(\"Provider=Search.CollatorDSO;Extended Properties='Application=Windows';\")",
  "$rs = $c.Execute(\"SELECT TOP $n System.ItemPathDisplay FROM SYSTEMINDEX WHERE System.FileName LIKE '%$q%'\")",
  "while (-not $rs.EOF) { $rs.Fields.Item('System.ItemPathDisplay').Value; $rs.MoveNext() }"
].join('; ')

const WINDOWS_SCAN_PS = [
  '$p = \'*\' + [Management.Automation.WildcardPattern]::Escape($env:IRIS_Q) + \'*\'',
  'Get-ChildItem -Path $env:USERPROFILE -Recurse -Force -ErrorAction SilentlyContinue -Filter $p | Select-Object -First ([int]$env:IRIS_N) -ExpandProperty FullName'
].join('; ')

const psArgs = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]

/**
 * Every provider: where it runs, how to tell it is usable, what it covers, how to call it.
 * `available(ctx)` returns the binary path, or null; `why` says what is missing when it is null.
 */
const PROVIDERS = [
  {
    name: 'fsearch', platforms: ['darwin'], coverage: 'whole disk', lineBased: false,
    available: (c) => c.which('fsearch'),
    why: 'not installed — `iris locate setup` builds it (needs ~1 GB free while building)',
    command: (bin, q, n) => [bin, [`${q} limit:${n}`, '--json']]
  },
  {
    name: 'spotlight', platforms: ['darwin'], coverage: 'whole disk (not hidden folders)', lineBased: true,
    available: (c) => c.which('mdfind') || (c.exists('/usr/bin/mdfind') ? '/usr/bin/mdfind' : null),
    why: 'mdfind not found',
    command: (bin, q) => [bin, ['-name', q]]
  },
  {
    name: 'plocate', platforms: ['linux'], coverage: 'whole disk (as of the last updatedb)', lineBased: true,
    available: (c) => (c.locateDb() ? c.which('plocate') : null),
    why: 'not installed, or no database yet — `iris locate setup` installs it',
    command: (bin, q, n) => [bin, ['-i', '-l', n, '--', q]]
  },
  {
    name: 'locate', platforms: ['linux'], coverage: 'whole disk (as of the last updatedb)', lineBased: true,
    available: (c) => (c.locateDb() ? c.which('locate') : null),
    why: 'not installed, or no database yet',
    command: (bin, q, n) => [bin, ['-i', '-l', n, '--', q]]
  },
  {
    name: 'windows-search', platforms: ['win32'], coverage: 'indexed folders (your user folders by default)', lineBased: true,
    available: (c) => c.which('powershell.exe') || c.which('powershell'),
    why: 'PowerShell not found',
    command: (bin, q, n) => [bin, psArgs(WINDOWS_SEARCH_PS), { IRIS_Q: q, IRIS_N: n }]
  },
  {
    name: 'scan', platforms: ['darwin', 'linux'], coverage: 'home folder only (8 s scan)', lineBased: true,
    available: (c) => c.which('find'),
    why: 'find not found',
    command: (bin, q, n, home) => {
      // -iname wildcards are find's own, not a shell's; escape the ones the user typed.
      const pat = `*${q.replace(/[\\*?[\]]/g, (ch) => '\\' + ch)}*`
      return [bin, [home, '-xdev', '-maxdepth', '8', '(', '-name', '.*', '-o', '-name', 'node_modules', ')', '-prune', '-o', '-iname', pat, '-print']]
    }
  },
  {
    name: 'scan', platforms: ['win32'], coverage: 'home folder only (8 s scan)', lineBased: true,
    available: (c) => c.which('powershell.exe') || c.which('powershell'),
    why: 'PowerShell not found',
    command: (bin, q, n) => [bin, psArgs(WINDOWS_SCAN_PS), { IRIS_Q: q, IRIS_N: n }]
  }
]

function context (over = {}) {
  return {
    platform: over.platform || process.platform,
    which: over.which || ((n) => onPath(n)),
    exists: over.exists || ((p) => fs.existsSync(p)),
    locateDb: over.locateDbExists || defaultLocateDb,
    home: over.home || os.homedir()
  }
}

/** Every provider for this platform, in preference order, with whether it is usable here. */
function listProviders (over = {}) {
  const c = context(over)
  const list = PROVIDERS.filter((p) => p.platforms.includes(c.platform)).map((p) => {
    const bin = p.available(c)
    return { name: p.name, coverage: p.coverage, available: !!bin, bin: bin || null, reason: bin ? null : p.why }
  })
  const chosen = list.find((p) => p.available)
  return { platform: c.platform, chosen: chosen ? chosen.name : null, providers: list }
}

/**
 * The provider this node would use — or the one asked for by name. Returns null when nothing is
 * usable (or the named one is not), with the reason in `.reason` of listProviders.
 */
function pickBackend (over = {}, wanted = null) {
  const c = context(over)
  for (const p of PROVIDERS) {
    if (!p.platforms.includes(c.platform)) continue
    if (wanted && p.name !== wanted) continue
    const bin = p.available(c)
    if (bin) return { name: p.name, bin, coverage: p.coverage, wholeDisk: p.name !== 'scan' && p.name !== 'windows-search' }
  }
  return null
}

const byName = (name, platform = process.platform) =>
  PROVIDERS.find((p) => p.name === name && p.platforms.includes(platform)) || PROVIDERS.find((p) => p.name === name)

/** [bin, argv, extraEnv?] for a backend. Nothing here is a shell string. */
function commandFor (backend, query, limit, home = os.homedir(), platform = process.platform) {
  const p = byName(backend.name, platform)
  if (!p) throw new Error(`unknown backend ${backend.name}`)
  return p.command(backend.bin, query, clampLimit(limit), home)
}

/** Backend stdout → [{ path, score?, line?, text? }]. */
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
    // `grep:` / `regex:` queries answer with files and their matching lines, not name hits.
    if (Array.isArray(v.files)) {
      return v.files.slice(0, n).map((f) => {
        const m = (f.matches || [])[0]
        return { path: String(f.path || ''), line: m ? m.line : null, text: m ? String(m.text || '').trim() : null }
      }).filter((h) => h.path)
    }
    return (v.hits || []).slice(0, n).map((h) => ({ path: String(h.path || ''), score: h.score ?? null })).filter((h) => h.path)
  }
  return String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, n).map((p) => ({ path: p }))
}

/**
 * Run a backend WITHOUT blocking the daemon: hive_search runs inside the daemon process, and a
 * synchronous 8 s scan would stall heartbeats and every other task for those 8 s. Line-based
 * backends are stopped as soon as they have printed `limit` paths.
 */
function runBackend (bin, args, { limit = 10, lineBased = true, timeoutMs = TIMEOUT_MS, env = null } = {}) {
  return new Promise((resolve, reject) => {
    let out = ''
    let done = false
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'], env: env ? { ...process.env, ...env } : process.env, windowsHide: true })
    const finish = (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { child.kill('SIGKILL') } catch {}
      // A scan stopped by the time box still printed real results first. Keep them.
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
 * Search this node's disk. Returns hive_search result rows plus which provider answered and what
 * it covers, so "no results" from a home-folder scan is never read as "not on this machine".
 * `provider` forces one by name; if it is not usable here the answer says so instead of silently
 * falling back.
 */
async function searchDisk (query, { limit = 10, provider = null, backend, run = runBackend, ctx = {} } = {}) {
  const q = String(query || '').trim()
  const b = backend !== undefined ? backend : pickBackend(ctx, provider)
  if (!q) return { backend: b && b.name, rows: [] }
  if (!b) {
    const note = provider
      ? `provider ${provider} is not available here — ${(listProviders(ctx).providers.find((p) => p.name === provider) || {}).reason || 'not a provider on this platform'}`
      : 'no file index on this node'
    return { backend: null, rows: [], note }
  }
  const started = Date.now()
  const [bin, args, env] = commandFor(b, q, limit, (ctx && ctx.home) || os.homedir(), (ctx && ctx.platform) || process.platform)
  const p = byName(b.name, (ctx && ctx.platform) || process.platform)
  let hits = []
  try {
    hits = parseOutput(b, await run(bin, args, { limit, lineBased: p ? p.lineBased : true, env }), limit)
  } catch (e) {
    return { backend: b.name, rows: [], note: `file search failed: ${String(e.message || e).slice(0, 160)}` }
  }
  const took = Date.now() - started
  const coverage = b.coverage || (p && p.coverage) || ''
  const rows = hits.map((h) => {
    let date = null
    try { date = fs.statSync(h.path).mtime.toISOString() } catch {}
    return {
      source: 'files',
      match: h.path,
      preview: h.text ? `line ${h.line}: ${h.text.slice(0, 100)}` : `${b.name} · ${coverage} · ${took} ms`,
      date,
      provider: b.name
    }
  })
  return { backend: b.name, coverage, wholeDisk: !!b.wholeDisk, took_ms: took, rows }
}

module.exports = { PROVIDERS, listProviders, pickBackend, commandFor, parseOutput, searchDisk, runBackend, WINDOWS_SEARCH_PS, WINDOWS_SCAN_PS }
