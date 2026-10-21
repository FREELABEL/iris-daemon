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

module.exports = { lockVerdict, pidAlive, ancestorPids, orphanPids, campaignCommand, hasXvfbRun, MAX_AGE_MS }
