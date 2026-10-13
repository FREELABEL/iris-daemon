#!/usr/bin/env node
'use strict'

/**
 * Merge parallel agents' branches into one, in code (#189179 claims, #189180 integrator).
 *
 *   node scripts/integrate.js --branches agent-1,agent-2,agent-3 -- node --test tests/
 *   node scripts/integrate.js --branches a,b --claims claims.json --into integrate/basket -- npm test
 *   node scripts/integrate.js --branches a,b,c --json --record --ticket 189180 -- php artisan test
 *
 * For each branch, in the order given:
 *   1. claims   (with --claims) its diff must stay inside what it claimed — else RETURNED
 *   2. merge    onto the integration branch — a conflict is aborted and RETURNED, both sides kept
 *   3. tests    the command runs on the combination — a failure undoes that merge, RETURNED
 * A branch returned for the second time (counted in .git/integrate-returns.json) is STOPPED.
 *
 * The integration branch (--into, default integrate/<timestamp>) is left with every branch that
 * passed; nothing is pushed. Run from the repo (or a package folder: the command runs there).
 * Exit: 0 every branch merged · 1 any returned/stopped · 2 usage or git error.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const I = require('../daemon/integrate')

function parseArgs (argv) {
  const dash = argv.indexOf('--')
  const own = dash === -1 ? argv : argv.slice(0, dash)
  const out = { cmd: dash === -1 ? [] : argv.slice(dash + 1), branches: [] }
  for (let i = 0; i < own.length; i++) {
    const a = own[i]
    if (['--json', '--record', '--help', '-h'].includes(a)) { out[a.replace(/^-+/, '')] = true; continue }
    if (a === '--branches') { out.branches.push(...String(own[++i] || '').split(',').map((s) => s.trim()).filter(Boolean)); continue }
    if (a === '--base') { out.base = own[++i]; continue }
    if (a === '--into') { out.into = own[++i]; continue }
    if (a === '--claims') { out.claims = own[++i]; continue }
    if (a === '--ticket') { out.ticket = String(own[++i] || '').replace(/^#/, ''); continue }
    if (a === '--max-returns') { out.maxReturns = Number(own[++i]); continue }
    if (a === '--timeout') { out.timeout = Number(own[++i]); continue }
    throw new Error(`unknown option ${a}`)
  }
  return out
}

function git (args, cwd, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' })
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')}: ${(r.stderr || r.stdout || '').trim()}`)
  return allowFail ? r : r.stdout.trim()
}

function runTests (cmd, dir, timeoutMs) {
  const r = spawnSync(cmd.join(' '), { cwd: dir, shell: true, encoding: 'utf-8', timeout: timeoutMs })
  const tail = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-8)
  return { exit: r.error || r.status === null ? null : r.status, tail }
}

function main () {
  let a
  try { a = parseArgs(process.argv.slice(2)) } catch (e) { console.error(e.message); process.exit(2) }
  if (a.help || !a.branches.length || !a.cmd.length) {
    console.error('usage: node scripts/integrate.js --branches a,b,c [--base ref] [--claims claims.json] [--into name] [--json] [--record] -- <test command>')
    process.exit(a.help ? 0 : 2)
  }
  const cwd = process.cwd()
  let root, prefix, base, gitDir, claims = null
  try {
    root = git(['rev-parse', '--show-toplevel'], cwd)
    prefix = git(['rev-parse', '--show-prefix'], cwd)
    gitDir = git(['rev-parse', '--git-common-dir'], cwd)
    if (!path.isAbsolute(gitDir)) gitDir = path.join(cwd, gitDir)
    base = git(['rev-parse', a.base || 'HEAD'], root)
    for (const b of a.branches) git(['rev-parse', '--verify', `${b}^{commit}`], root)
    if (a.claims) claims = I.normalizeClaims(JSON.parse(fs.readFileSync(path.resolve(cwd, a.claims), 'utf-8')))
  } catch (e) { console.error(e.message); process.exit(2) }

  const into = a.into || `integrate/${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`
  const returnsFile = path.join(gitDir, 'integrate-returns.json')
  let returns = {}
  try { returns = JSON.parse(fs.readFileSync(returnsFile, 'utf-8')) } catch {}
  const maxReturns = a.maxReturns > 0 ? a.maxReturns : 2
  const timeoutMs = (a.timeout > 0 ? a.timeout : 900) * 1000

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'integrate-'))
  const wt = path.join(tmp, 'wt')
  const results = []
  try {
    git(['worktree', 'add', '-B', into, wt, base], root)
    git(['config', 'user.email', 'integrator@iris.local'], wt)
    git(['config', 'user.name', 'IRIS integrator'], wt)
    for (const rel of new Set(['', prefix])) {
      for (const d of ['node_modules', 'vendor']) {
        const src = path.join(root, rel, d)
        const dst = path.join(wt, rel, d)
        if (fs.existsSync(src) && !fs.existsSync(dst)) fs.symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir')
      }
    }
    const back = (branch, why, reason, detail) => {
      const b = I.returnBudget(returns, branch, maxReturns)
      returns[branch] = b.count
      results.push({ branch, status: b.exhausted ? 'STOPPED' : 'RETURNED', why, reason: `${reason}${b.exhausted ? ` (returned ${b.count}×, stopping)` : ` (return ${b.count} of ${maxReturns})`}`, detail })
    }
    for (const branch of a.branches) {
      // 1 · claims, in code
      if (claims) {
        const diff = git(['diff', '-U0', '--no-color', '--no-ext-diff', `${base}...${branch}`], root)
        const v = I.claimViolations(branch, I.parseHunks(diff), claims)
        if (v === null) { back(branch, 'claims', 'no claims recorded for this branch', []); continue }
        if (v.length) { back(branch, 'claims', `edited outside its claims in ${v.length} place(s)`, v.map((x) => `${x.file} · ${x.where}${x.claimed.length ? ` (claimed: ${x.claimed.join(', ')})` : ''}`)); continue }
      }
      // 2 · merge, one at a time
      const m = git(['merge', '--no-ff', '--no-edit', '-m', `integrate: ${branch}`, branch], wt, { allowFail: true })
      if (m.status !== 0) {
        const files = git(['diff', '--name-only', '--diff-filter=U'], wt, { allowFail: true }).stdout.trim().split('\n').filter(Boolean)
        git(['merge', '--abort'], wt, { allowFail: true })
        back(branch, 'conflict', 'conflicts with what is already merged — both versions kept on their branches', files.map((f) => `conflict: ${f}`))
        continue
      }
      // 3 · tests on the combination
      const t = runTests(a.cmd, path.join(wt, prefix), timeoutMs)
      if (t.exit !== 0) {
        git(['reset', '--hard', 'HEAD~1'], wt)
        back(branch, 'tests', t.exit === null ? 'tests did not finish on the combination' : `tests fail on the combination (exit ${t.exit})`, t.tail.map((l) => `| ${l}`))
        continue
      }
      delete returns[branch]
      results.push({ branch, status: 'MERGED' })
    }
  } catch (e) {
    console.error(e.message)
    process.exitCode = 2
  } finally {
    git(['worktree', 'remove', '--force', wt], root, { allowFail: true })
    fs.rmSync(tmp, { recursive: true, force: true })
    try { fs.writeFileSync(returnsFile, JSON.stringify(returns, null, 1)) } catch {}
  }
  if (process.exitCode === 2) return

  const rep = I.report(results, { into, base })
  const tip = git(['rev-parse', into], root)
  if (a.json) console.log(JSON.stringify({ outcome: rep.outcome, into, base, tip, results }))
  else console.log(rep.text)
  if (a.record) record(a, results, { root, base, tip })
  process.exit(rep.outcome === 'DONE' ? 0 : 1)
}

/** One row per branch in hive-gate-verdicts (#189146). Never changes the outcome. */
function record (a, results, { root, base, tip }) {
  let repo = ''
  try { const u = git(['remote', 'get-url', 'origin'], root); const m = u.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/); repo = m ? m[1] : u } catch {}
  for (const r of results) {
    const sha = git(['rev-parse', r.branch], root)
    const row = {
      verdict_id: `${repo || 'unknown'}@${sha.slice(0, 12)}:integrate`,
      repo, sha, base_sha: base, check: 'integrate', verdict: r.status, passed: r.status === 'MERGED',
      caught_regression: r.why === 'tests', ticket: a.ticket ? `#${a.ticket}` : '',
      author_vendor: process.env.IRIS_AUTHOR_VENDOR || '', author_model: process.env.IRIS_AUTHOR_MODEL || '',
      author_session: process.env.IRIS_AUTHOR_SESSION || '', author_node: os.hostname(),
      gate_session: process.env.IRIS_GATE_SESSION || '', playbook: process.env.IRIS_PLAYBOOK || '',
      measured_at: new Date().toISOString(), note: `${r.reason || 'merged'} · integration tip ${tip.slice(0, 12)}`,
    }
    const p = spawnSync('iris', ['datasets', 'records', 'upsert', '-s', 'hive-gate-verdicts', '--bloq', '381', '--external-id', row.verdict_id, '--data', JSON.stringify(row)], { encoding: 'utf-8', timeout: 60000 })
    console.error(p.status === 0 ? `  recorded ${row.verdict_id}` : `  could not record ${row.verdict_id} — the result above stands`)
  }
}

if (require.main === module) main()
module.exports = { parseArgs }
