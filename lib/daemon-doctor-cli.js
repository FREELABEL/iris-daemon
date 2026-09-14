'use strict'

/**
 * Collects the facts lib/daemon-doctor.js evaluates, and renders them.
 *
 * Kept separate from the evaluation on purpose: this half touches launchctl, lsof,
 * ps, the filesystem and HTTP, none of which can be exercised on a machine that is
 * healthy. The half that decides pass/fail is pure and fully tested.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { execFileSync } = require('child_process')
const { evaluate } = require('./daemon-doctor')

const HOME = os.homedir()
const BRIDGE = path.join(HOME, '.iris', 'bridge')
const PORT = parseInt(process.env.A2A_PORT || '3200', 10)
const LABEL = 'io.heyiris.daemon'

function sh (cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function launchdPid () {
  if (process.platform !== 'darwin') return null
  const out = sh('launchctl', ['list'])
  if (!out) return null
  for (const line of out.split('\n')) {
    const cols = line.split('\t')
    if (cols[cols.length - 1] === LABEL) {
      const pid = parseInt(cols[0], 10)
      return Number.isInteger(pid) && pid > 0 ? pid : null
    }
  }
  return null
}

function portHolderPid () {
  const out = sh('lsof', ['-ti', ':' + PORT, '-sTCP:LISTEN'])
  if (!out) return null
  const pid = parseInt(out.split('\n')[0], 10)
  return Number.isInteger(pid) ? pid : null
}

/** Every process running the bridge's own entry points — index.js or daemon.js. */
function bridgeProcessPids () {
  const out = sh('ps', ['-eo', 'pid=,command='])
  if (!out) return null
  const pids = []
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/)
    if (!m) continue
    const pid = parseInt(m[1], 10)
    const cmd = m[2]
    if (!/\bnode\b/.test(cmd)) continue
    if (/ps -eo/.test(cmd)) continue
    // `node daemon.js` (launchd, cwd=bridge) or `node <bridge>/index.js`.
    // `node daemon.js` has a SPACE before the filename, not a slash — the first
    // version of this required ^ or / and so found nothing while the pid checks
    // above were finding the process fine. The doctor's own blind spot.
    const isDaemonEntry = /(^|[\s/])daemon\.js(\s|$)/.test(cmd) || /(^|[\s/])index\.js(\s|$)/.test(cmd)
    if (isDaemonEntry) pids.push(pid)
  }
  return pids
}

function processStartedMs (pid) {
  if (!pid) return null
  const out = sh('ps', ['-o', 'lstart=', '-p', String(pid)])
  if (!out) return null
  const t = Date.parse(out.trim())
  return Number.isFinite(t) ? t : null
}

/** Newest mtime among the files the daemon actually loads. */
function newestCodeMs () {
  let newest = 0
  const roots = [path.join(BRIDGE, 'daemon'), path.join(BRIDGE, 'lib')]
  const files = [path.join(BRIDGE, 'index.js'), path.join(BRIDGE, 'daemon.js')]
  for (const r of roots) {
    let entries = []
    try {
      entries = fs.readdirSync(r, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.js')) files.push(path.join(r, e.name))
    }
  }
  for (const f of files) {
    try {
      newest = Math.max(newest, fs.statSync(f).mtimeMs)
    } catch { /* gone */ }
  }
  return newest || null
}

function healthStatus () {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 5000 }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

function configFacts () {
  const p = path.join(HOME, '.iris', 'config.json')
  let mode = null
  try {
    mode = fs.statSync(p).mode
  } catch {
    return { parsed: false, mode: null, keys: [] }
  }
  try {
    // Keys only. The values include a live node key and must never leave this function.
    const keys = Object.keys(JSON.parse(fs.readFileSync(p, 'utf-8')))
    return { parsed: true, mode, keys }
  } catch {
    return { parsed: false, mode, keys: [] }
  }
}

/**
 * Kills split into "since this process started" and "older".
 *
 * A lifetime count is useless as a health signal: it cannot distinguish kills that
 * a fix already stopped from kills happening now, so it reads red forever. The
 * watchdog line carries an ISO timestamp for exactly this, and lines without one
 * (written before that change) are reported as UNBOUNDED rather than assumed old —
 * assuming would be a guess presented as a measurement.
 */
function watchdogKills (processStart) {
  const p = path.join(HOME, '.iris', 'logs', 'daemon.stderr.log')
  let txt
  try {
    txt = fs.readFileSync(p, 'utf-8')
  } catch {
    return null
  }
  const lines = txt.split('\n').filter((l) => l.includes('MAIN THREAD BLOCKED'))
  if (lines.length === 0) return { sinceStart: 0, historical: 0 }

  let sinceStart = 0
  let historical = 0
  let untimestamped = 0
  for (const l of lines) {
    const m = l.match(/\[watchdog\]\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)
    if (!m) { untimestamped++; continue }
    const t = Date.parse(m[1])
    if (processStart != null && Number.isFinite(t) && t >= processStart) sinceStart++
    else historical++
  }
  // If we cannot bound ANY of them, say so rather than reporting a confident zero.
  if (untimestamped > 0 && sinceStart === 0) {
    return { sinceStart: null, historical: historical + untimestamped }
  }
  return { sinceStart, historical: historical + untimestamped }
}

function stdoutLogBytes () {
  try {
    return fs.statSync(path.join(HOME, '.iris', 'logs', 'daemon.stdout.log')).size
  } catch {
    return null
  }
}

/**
 * Which of the candidate processes actually OWNS an executor mutex.
 *
 * An executor holds :3200 (index.js, embedded mode) or ~/.iris/daemon.sock (daemon.js,
 * single-instance). A process running an entry point but holding NEITHER is an attached
 * monitor — it printed "Bridge already running — attaching as monitor" and runs no
 * executor. Counting monitors as executors is what made this check cry wolf.
 */
function socketHolderPids () {
  const sock = path.join(HOME, '.iris', 'daemon.sock')
  const out = sh('lsof', ['-t', sock])
  if (!out) return []
  return out.split('\n').map((x) => parseInt(x, 10)).filter(Number.isInteger)
}

function splitExecutorsAndMonitors (candidates, portHolder) {
  const owners = new Set(socketHolderPids())
  if (portHolder) owners.add(portHolder)
  const execs = []
  const mons = []
  for (const pid of candidates || []) {
    if (owners.has(pid)) execs.push(pid)
    else mons.push(pid)
  }
  return { execs, mons }
}

async function collectFacts () {
  const holder = portHolderPid()
  const candidates = bridgeProcessPids()
  const { execs, mons } = splitExecutorsAndMonitors(candidates, holder)
  return {
    launchdPid: launchdPid(),
    portHolderPid: holder,
    bridgeProcessPids: candidates,
    executorPids: execs,
    monitorPids: mons,
    processStartedMs: processStartedMs(holder),
    newestCodeMs: newestCodeMs(),
    healthStatus: await healthStatus(),
    config: configFacts(),
    watchdogKills: watchdogKills(processStartedMs(holder)),
    stdoutLogBytes: stdoutLogBytes()
  }
}

const ESC = String.fromCharCode(27)
const GREEN = ESC + '[92m'
const RED = ESC + '[91m'
const YELLOW = ESC + '[93m'
const RESET = ESC + '[0m'
const MARK = { pass: GREEN + 'OK' + RESET, fail: RED + 'FAIL' + RESET, unknown: YELLOW + '??' + RESET }

async function main () {
  const json = process.argv.includes('--json')
  const result = evaluate(await collectFacts())

  if (json) {
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.exitCode)
  }

  console.log('\niris daemon doctor\n')
  for (const c of result.checks) {
    console.log('  [' + MARK[c.status] + '] ' + c.title)
    if (c.status !== 'pass') console.log('        ' + c.detail)
  }
  const bad = result.checks.filter((c) => c.status !== 'pass')
  console.log('')
  if (result.ok) {
    console.log('  ' + GREEN + 'All ' + result.checks.length + ' checks passed.' + RESET + '\n')
  } else {
    console.log('  ' + RED + bad.length + ' of ' + result.checks.length + ' check(s) need attention.' + RESET)
    console.log('  A green /health does NOT mean healthy — it was green through every failure above.\n')
  }
  process.exit(result.exitCode)
}

if (require.main === module) main()
module.exports = { collectFacts }
