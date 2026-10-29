// The SOM batch lock: is another batch really running on this machine? (#190291)
// Age alone isn't enough. A batch that crashes leaves the lock behind, and an age-only check then
// blocks every run for 30 minutes while each blocked run exits 0 and reports "completed".
const MAX_AGE_MS = 30 * 60 * 1000

function pidAlive (pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }   // EPERM: alive, not ours
}

// 'busy' when a live batch holds the lock and is under 30 minutes old; otherwise 'stale'.
function lockVerdict (lock, now = Date.now(), isAlive = pidAlive) {
  if (!lock || !Number.isInteger(lock.pid) || !Number.isFinite(lock.started)) return 'stale'
  if (!isAlive(lock.pid)) return 'stale'
  return now - lock.started < MAX_AGE_MS ? 'busy' : 'stale'
}

// Every PID above us: parent, grandparent… up to init. The tmux client and shell that launched this run are
// in here, and so is anything wrapping it (timeout, a shell), so none of them is ever an "orphan".
function ancestorPids (pid = process.pid) {
  const { execSync } = require('child_process')
  const out = []
  let p = pid
  for (let i = 0; i < 64; i++) {
    let pp
    try { pp = parseInt(execSync(`ps -o ppid= -p ${p}`, { encoding: 'utf8' }).trim(), 10) } catch { break }
    if (!Number.isInteger(pp) || pp <= 1 || out.includes(pp)) break
    out.push(pp); p = pp
  }
  return out
}

// From `ps -eo pid,args` lines: the PIDs that are OTHER `node … som-all.js` processes. Shells, tmux and
// grep lines that merely mention som-all.js are not SOM runs and are never killed. Neither are we or our ancestors.
function orphanPids (psOut, myPid, ancestors) {
  const spare = new Set([myPid, ...ancestors])
  return psOut.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const m = l.match(/^(\d+)\s+(.*)$/); if (!m) return null
    const [, pid, args] = m
    const exe = args.split(/\s+/)[0]
    return /(^|\/)node$/.test(exe) && /som-all\.js/.test(args) ? parseInt(pid, 10) : null
  }).filter(pid => pid !== null && !spare.has(pid))
}

// How to start one campaign: `node <script> …`, wrapped in xvfb-run on a Linux machine with no display,
// because the SOM's browser is headed and Chromium won't start without an X server.
function campaignCommand (platform, env, hasXvfb, script, args) {
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY && hasXvfb) {
    return { cmd: 'xvfb-run', args: ['-a', '--server-args=-screen 0 1440x900x24', 'node', script, ...args] }
  }
  return { cmd: 'node', args: [script, ...args] }
}

function hasXvfbRun () {
  try { require('child_process').execSync('command -v xvfb-run', { stdio: 'ignore', shell: '/bin/sh' }); return true } catch { return false }
}

// From `ps -eo pid=,ppid=` lines: every PID below root (children, grandchildren…). A campaign is
// node → (xvfb-run) → node som.js → npx playwright → Chromium and its helpers; killing only the top
// one leaves the browsers running, which is how stopped batches piled up Chrome until the Mac fell over.
function descendantPids (psOut, root) {
  const kids = new Map()
  for (const l of psOut.split('\n')) {
    const m = l.trim().match(/^(\d+)\s+(\d+)/); if (!m) continue
    const pid = parseInt(m[1], 10), ppid = parseInt(m[2], 10)
    if (!kids.has(ppid)) kids.set(ppid, [])
    kids.get(ppid).push(pid)
  }
  const out = []
  const stack = [...(kids.get(root) || [])]
  while (stack.length) {
    const pid = stack.pop()
    if (out.includes(pid)) continue
    out.push(pid)
    stack.push(...(kids.get(pid) || []))
  }
  return out
}

// From `ps -eo pid=,ppid=,args=` lines: Playwright Chromium browsers whose owner is gone. A browser
// Playwright launched carries --remote-debugging-pipe; when the test process dies it is re-parented to
// PID 1 (init or launchd). Only those are orphans. The old `pkill -f ms-playwright.*chromium` killed
// every Playwright browser on the machine, including ones a live run, an MCP or the Desktop app owned.
function orphanBrowserPids (psOut) {
  return psOut.split('\n').map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .filter(([, , ppid, args]) => ppid === '1' && /ms-playwright/.test(args) && /--remote-debugging-pipe/.test(args))
    .map(([, pid]) => parseInt(pid, 10))
}

// How many campaigns (one headed Chromium each) to run at once. Busier machine → fewer browsers;
// the old check went from "all" to 3 under moderate load, which could ADD a browser (default was 2).
// cpuPct is real CPU use, 0-100 (sampleCpuPct). It used to be loadavg/cores*100 (#191622): on a Mac
// waiting on a busy or full disk, load 28 on 10 cores read as "281%" while the cores were 28% busy,
// so SOM ran one campaign at a time for no reason.
function parallelLimit ({ freeGb, cpuPct, battery = null, charging = true, requested = 2 }) {
  const busy = freeGb < 4 || cpuPct > 50 || (battery !== null && battery < 30 && !charging)
  return Math.max(1, Math.min(requested, busy ? 1 : 2))
}

// Real CPU use, 0-100 across all cores, from two os.cpus() snapshots `ms` apart — the same math the
// daemon's resource monitor uses for /daemon/capacity cpu_pct (#191603). cpus/sleep are injectable.
async function sampleCpuPct ({ ms = 750, cpus = () => require('os').cpus(), sleep = t => new Promise(r => setTimeout(r, t)) } = {}) {
  const { cpuTimeTotals, cpuPercent } = require('../daemon/resource-monitor')
  const before = cpuTimeTotals(cpus())
  await sleep(ms)
  return cpuPercent(before, cpuTimeTotals(cpus())).pct
}

module.exports = { lockVerdict, pidAlive, ancestorPids, orphanPids, campaignCommand, hasXvfbRun, MAX_AGE_MS, descendantPids, orphanBrowserPids, parallelLimit, sampleCpuPct }
