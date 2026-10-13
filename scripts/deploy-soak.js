#!/usr/bin/env node
'use strict'

/**
 * Soak every production deploy for ten minutes against what production looked like before it,
 * and roll a bad one back (#189152, G6).
 *
 *   node scripts/deploy-soak.js                    one pass: measure the baseline, or soak a new deploy
 *   node scripts/deploy-soak.js --auto-rollback    on FAIL, revert the commit on the deploy branch
 *   node scripts/deploy-soak.js --dry-run          print what it would do; probe but change nothing
 *   node scripts/deploy-soak.js --install          copy into ~/.iris/daemon-data/scripts/
 *
 * Schedule it every 5 minutes on one node with `gh` signed in:
 *   iris hive schedule add deploy-soak.js --cron "*\/5 * * * *"
 *
 * Deploy status comes from the commit statuses Railway posts to GitHub ("freelabel-eco - fl-api"),
 * so this needs no Railway credential. Rollback is `git revert` of the bad commit pushed to the
 * deploy branch — it goes through CI and Wait for CI like any other change, and it only happens
 * when the bad commit is still the tip (if someone pushed after it, it reports instead).
 * Without --auto-rollback a FAIL files a ticket with the exact revert command.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const D = fs.existsSync(path.join(__dirname, 'deploy-soak-core.js'))
  ? require('./deploy-soak-core.js')
  : require('../daemon/deploy-soak')

const SERVICES = [
  { name: 'fl-api', repo: 'FREELABEL/fl-api', branch: 'master', context: 'freelabel-eco - fl-api', health: 'https://freelabel.net/api/health' },
  { name: 'fl-iris-api', repo: 'FREELABEL/fl-iris-api', branch: 'main', context: 'freelabel-eco - fl-iris-api', health: 'https://heyiris.io/api/health' },
]
const STATE = path.join(os.homedir(), '.iris', 'deploy-soak', 'state.json')
const LOCK = path.join(os.homedir(), '.iris', 'deploy-soak', 'lock')
const SOAK_MS = Number(process.env.SOAK_MINUTES || 10) * 60000
const EVERY_MS = 30000

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf-8', timeout: 120000, ...opts })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function probe (url) {
  const t0 = Date.now()
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'iris-deploy-soak' } })
    const ms = Date.now() - t0
    let body = null
    try { body = await res.json() } catch {}
    return { http: res.status, ms, body }
  } catch { return { http: null, ms: null, body: null } }
}

function tip (svc) {
  const r = run('gh', ['api', `repos/${svc.repo}/commits/${svc.branch}/status`])
  if (r.status !== 0) return null
  try {
    const d = JSON.parse(r.stdout)
    return { sha: d.sha, state: D.deployState(d.statuses, svc.context) }
  } catch { return null }
}

function commitTitle (svc, sha) {
  const r = run('gh', ['api', `repos/${svc.repo}/commits/${sha}`, '-q', '.commit.message'])
  return r.status === 0 ? r.stdout.split('\n')[0].slice(0, 120) : sha.slice(0, 10)
}

function revert (svc, sha, dry) {
  if (dry) return { ok: false, why: 'dry run' }
  const now = tip(svc)
  if (!now || now.sha !== sha) return { ok: false, why: `${svc.branch} has moved on to ${now ? now.sha.slice(0, 10) : '?'} — not reverting under someone else's commit` }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-revert-'))
  try {
    const g = (...a) => run('git', a, { cwd: dir })
    let r = run('gh', ['repo', 'clone', svc.repo, dir, '--', '--depth', '5', '-b', svc.branch])
    if (r.status !== 0) return { ok: false, why: `clone failed: ${(r.stderr || '').trim().split('\n').pop()}` }
    const parents = g('rev-list', '--parents', '-n', '1', sha).stdout.trim().split(' ').length - 1
    r = g('revert', '--no-edit', ...(parents > 1 ? ['-m', '1'] : []), sha)
    if (r.status !== 0) return { ok: false, why: `revert did not apply cleanly: ${(r.stderr || r.stdout).trim().split('\n').pop()}` }
    g('commit', '--amend', '-m', `Revert "${commitTitle(svc, sha)}" — failed its deploy soak (#189152)\n\nThis reverts commit ${sha}.\nAutomatic: scripts/deploy-soak.js --auto-rollback.`)
    r = g('push', 'origin', `HEAD:${svc.branch}`)
    if (r.status !== 0) return { ok: false, why: `push refused: ${(r.stderr || '').trim().split('\n').pop()}` }
    return { ok: true, sha: g('rev-parse', 'HEAD').stdout.trim() }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

function file (title, description, dry) {
  if (dry) { console.log(`  would file: ${title}`); return }
  const r = run('iris', ['bug', 'report', '--title', title, '--description', description, '--severity', 'high', '--command', 'deploy-soak'])
  console.log(r.status === 0 ? `  filed: ${title}` : `  could not file "${title}"`)
}

async function soak (svc, baseline) {
  const probes = []
  const end = Date.now() + SOAK_MS
  while (Date.now() < end) {
    probes.push(await probe(svc.health))
    const v = D.soakVerdict(baseline, probes)
    // Down three times in a row is already a verdict; do not make production wait out the window.
    if (v.verdict === 'FAIL' && v.reasons.some((x) => /did not answer/.test(x))) break
    await sleep(EVERY_MS)
  }
  return { probes, ...D.soakVerdict(baseline, probes) }
}

async function main () {
  const argv = process.argv.slice(2)
  if (argv.includes('--install')) {
    const dir = path.join(os.homedir(), '.iris', 'daemon-data', 'scripts')
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(__filename, path.join(dir, 'deploy-soak.js'))
    fs.copyFileSync(path.join(__dirname, '..', 'daemon', 'deploy-soak.js'), path.join(dir, 'deploy-soak-core.js'))
    console.log(`installed to ${dir} — now: iris hive schedule add deploy-soak.js --cron "*/5 * * * *"`)
    return
  }
  const dry = argv.includes('--dry-run')
  const auto = argv.includes('--auto-rollback')
  fs.mkdirSync(path.dirname(STATE), { recursive: true })
  // One soak at a time: a 10-minute soak outlives a 5-minute schedule.
  try {
    const held = Date.now() - fs.statSync(LOCK).mtimeMs
    if (held < SOAK_MS + 5 * 60000) { console.log('a soak is already running — skipping this pass'); return }
  } catch {}
  if (!dry) fs.writeFileSync(LOCK, String(process.pid))
  let all = {}
  try { all = JSON.parse(fs.readFileSync(STATE, 'utf-8')) } catch {}
  try {
    for (const svc of SERVICES) {
      const prev = all[svc.name] || {}
      const t = tip(svc)
      const step = D.nextStep(prev, t)
      if (step === 'wait') { console.log(`${svc.name}: ${t ? `${t.sha.slice(0, 10)} is ${t.state}` : 'could not read deploy status'} — waiting`); continue }
      if (step === 'baseline') {
        const p = await probe(svc.health)
        all[svc.name] = { ...prev, sha: t.sha, baseline: D.updateBaseline(prev.baseline, p), soaked: prev.soaked || {} }
        console.log(`${svc.name}: ${t.sha.slice(0, 10)} · baseline ${p.http ?? 'no answer'}${p.ms != null ? ` · ${p.ms} ms` : ''}`)
        continue
      }
      // step === 'soak'
      const title = commitTitle(svc, t.sha)
      console.log(`${svc.name}: soaking ${t.sha.slice(0, 10)} "${title}" for ${SOAK_MS / 60000} min against ${prev.sha.slice(0, 10)}`)
      const res = await soak(svc, prev.baseline)
      console.log(`  ${res.verdict}${res.reasons.length ? ' — ' + res.reasons.join('; ') : ''} (${res.probes.length} probes)`)
      const soaked = { ...(prev.soaked || {}), [t.sha]: res.verdict }
      for (const k of Object.keys(soaked).slice(0, -20)) delete soaked[k]
      if (res.verdict === 'PASS') {
        all[svc.name] = { ...prev, sha: t.sha, soaked, baseline: res.probes.reduce((b, p) => D.updateBaseline(b, p), prev.baseline) }
        continue
      }
      // FAIL: keep the PRE-deploy baseline — the bad deploy must not become the new normal.
      all[svc.name] = { ...prev, soaked }
      const cmd = `git revert --no-edit ${t.sha} && git push origin HEAD:${svc.branch}`
      let outcome = `Not rolled back automatically (--auto-rollback is off). To roll back: ${cmd}`
      if (auto) {
        const r = revert(svc, t.sha, dry)
        outcome = r.ok ? `Rolled back: revert ${r.sha.slice(0, 10)} pushed to ${svc.branch}; it deploys after CI passes.` : `Automatic rollback did not happen: ${r.why}. To roll back by hand: ${cmd}`
        if (r.ok) all[svc.name].soaked[r.sha] = 'REVERT'
      }
      console.log(`  ${outcome}`)
      file(`[deploy-soak] ${svc.name} ${t.sha.slice(0, 10)} failed its soak: ${res.reasons[0]}`,
        `Commit ${t.sha} ("${title}") went live on ${svc.name} and made production worse than it was on ${prev.sha} in the ${SOAK_MS / 60000} minutes after deploy.\n\n${res.reasons.map((r) => '- ' + r).join('\n')}\n\n${outcome}\n\nProbe: ${svc.health}. Soak rules: iris-daemon daemon/deploy-soak.js (#189152).`, dry)
    }
  } finally {
    if (!dry) {
      fs.writeFileSync(STATE, JSON.stringify(all, null, 1), { mode: 0o600 })
      try { fs.unlinkSync(LOCK) } catch {}
    }
  }
}

main().catch((e) => { console.error(e.message); try { fs.unlinkSync(LOCK) } catch {} ; process.exit(1) })
