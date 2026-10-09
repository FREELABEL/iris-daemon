'use strict'

// Keep a node's git worktrees few (#188702). Measured 2026-10-09 on iris-hive-001: 86 worktrees,
// ~79 GB, made by agents and never removed — and a few held the ONLY copy of real work, including
// an uncommitted security fix (#188739). So this removes only what loses nothing:
//
//   clean (no uncommitted or untracked files)  AND  every commit is on a remote branch
//   AND  no process is working inside it       AND  untouched for IDLE_DAYS
//
// Everything else is kept and counted, with the reason, and reported on the heartbeat so a
// pile-up is visible instead of discovered. Agents create worktrees with `wt` (freelabel
// scripts/wt), which also caps them at 15 per machine.
//
// Async on purpose: a synchronous subprocess here would stall the daemon's event loop and the
// in-process server with it.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

const IDLE_DAYS = Number(process.env.IRIS_WORKTREE_IDLE_DAYS || 3)
const CAP = Number(process.env.IRIS_WORKTREE_CAP || 15)
const ROOTS = (process.env.IRIS_WORKTREE_ROOTS || ['work', 'src', 'sites'].map((d) => path.join(os.homedir(), d)).join(':')).split(':')

function git (cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 60_000, maxBuffer: 8 << 20 }, (err, stdout) => resolve(err ? null : String(stdout)))
  })
}

/** Repos (main checkouts) under the roots that have linked worktrees. Depth-limited. */
function reposWithWorktrees (roots = ROOTS, maxDepth = 4) {
  const out = []
  const walk = (dir, depth) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    if (entries.some((e) => e.name === '.git' && e.isDirectory())) {
      if (fs.existsSync(path.join(dir, '.git', 'worktrees'))) out.push(dir)
    }
    if (depth >= maxDepth) return
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'vendor') continue
      walk(path.join(dir, e.name), depth + 1)
    }
  }
  for (const r of roots) walk(r, 0)
  return [...new Set(out)]
}

/** Every process's working directory, once per sweep. Linux: /proc. Elsewhere: lsof. */
function processCwds () {
  return new Promise((resolve) => {
    if (fs.existsSync('/proc/self/cwd')) {
      const cwds = []
      for (const pid of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(pid)) continue
        try { cwds.push(fs.readlinkSync(`/proc/${pid}/cwd`)) } catch {}
      }
      return resolve(cwds)
    }
    execFile('lsof', ['-a', '-d', 'cwd', '-Fn'], { timeout: 30_000, maxBuffer: 16 << 20 }, (err, stdout) => {
      resolve(err && !stdout ? null : String(stdout).split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1)))
    })
  })
}

/**
 * Commits that exist only in this worktree. A commit is saved when it is on any remote branch, OR
 * when the identical change is already on the default branch (`git cherry`, patch-id — exact, not
 * a heuristic). Agents here rebase and push from other clones, so the same change routinely lands
 * on main under a new hash; without this those worktrees could never be cleaned.
 */
async function unsavedCommits (wt) {
  const local = await git(wt, ['rev-list', 'HEAD', '--not', '--remotes'])
  if (local === null) return null
  const ids = local.split('\n').filter(Boolean)
  if (ids.length === 0) return 0
  const base = ((await git(wt, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])) || 'origin/main').trim()
  const cherry = await git(wt, ['cherry', base, 'HEAD'])
  if (cherry === null) return ids.length
  const notUpstream = new Set(cherry.split('\n').filter((l) => l.startsWith('+ ')).map((l) => l.slice(2).trim()))
  return ids.filter((c) => notUpstream.has(c)).length
}

/** Why this worktree must stay, or null when removing it loses nothing. */
async function keepReason (wt, { cwds, now = Date.now(), idleDays = IDLE_DAYS }) {
  const status = await git(wt, ['status', '--porcelain'])
  if (status === null) return 'git could not read it'
  if (status.trim()) return 'uncommitted changes'
  const unsaved = await unsavedCommits(wt)
  if (unsaved === null) return 'git could not read its commits'
  if (unsaved > 0) return `${unsaved} commit(s) on no remote`
  if (cwds === null) return 'cannot tell whether a process is using it'
  if (cwds.some((c) => c === wt || c.startsWith(wt + path.sep))) return 'a process is working in it'
  let touched = 0
  try { touched = fs.statSync(wt).mtimeMs } catch {}
  const headLog = await git(wt, ['log', '-1', '--format=%ct', 'HEAD'])
  touched = Math.max(touched, (Number(headLog) || 0) * 1000)
  if (now - touched < idleDays * 86_400_000) return `used in the last ${idleDays} days`
  return null
}

async function sweep ({ apply = true, roots = ROOTS, log = console.log } = {}) {
  const cwds = await processCwds()
  const report = { count: 0, cap: CAP, removed: 0, kept: {}, at: new Date().toISOString() }
  for (const repo of reposWithWorktrees(roots)) {
    const list = await git(repo, ['worktree', 'list', '--porcelain'])
    if (!list) continue
    const wts = list.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).slice(1)
    for (const wt of wts) {
      if (!fs.existsSync(wt)) continue
      report.count++
      const why = await keepReason(wt, { cwds })
      if (why) { report.kept[why] = (report.kept[why] || 0) + 1; continue }
      if (!apply) { report.kept['would remove'] = (report.kept['would remove'] || 0) + 1; continue }
      // No --force: git refuses a worktree with changes, a last guard behind the checks above.
      if ((await git(repo, ['worktree', 'remove', wt])) !== null) {
        report.removed++; report.count--
        log(`[worktrees] removed ${wt} — clean, fully pushed, idle ${IDLE_DAYS}+ days`)
      } else {
        report.kept['git refused removal'] = (report.kept['git refused removal'] || 0) + 1
      }
    }
    await git(repo, ['worktree', 'prune'])
  }
  report.over_cap = report.count > CAP
  if (report.over_cap) log(`[worktrees] ${report.count} worktrees on this machine (cap ${CAP}) — kept: ${JSON.stringify(report.kept)}`)
  return report
}

module.exports = { sweep, keepReason, unsavedCommits, reposWithWorktrees, IDLE_DAYS, CAP }
