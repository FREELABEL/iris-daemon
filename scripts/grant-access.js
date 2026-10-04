#!/usr/bin/env node
'use strict'

/**
 * iris-daemon grant-access — give the daemon Full Disk Access in one guided step, and prove it.
 *
 * Nothing can grant this silently: macOS only lets a person flip the switch. So this does
 * everything around the switch. It names the exact file (the one the daemon is pinned to, not
 * "node" or your terminal), copies its path, opens the right pane, shows the file in Finder,
 * waits, restarts the daemon once, and checks that the RUNNING daemon can now read Mail and
 * Messages. "Done" is printed only after that check passes.
 *
 *   iris-daemon grant-access            guided, waits until it is granted (default 5 min)
 *   iris-daemon grant-access --no-wait  print the steps and exit
 *   iris-daemon grant-access --json     print the permissions report; exit 0 granted, 1 not
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const BRIDGE = process.env.IRIS_BRIDGE_URL || 'http://127.0.0.1:3200'
const DAEMONCTL = process.env.IRIS_DAEMONCTL || path.join(__dirname, '..', 'daemonctl')

/**
 * What to do next, from a permissions report (or null when the daemon did not answer).
 * Pure, so the whole decision is testable without a Mac, a daemon or a person.
 */
function nextStep (report) {
  if (!report) return { step: 'daemon_down', say: 'The IRIS daemon is not answering. Start it first: iris-daemon start' }
  if (report.platform && report.platform !== 'darwin') return { step: 'not_applicable', say: 'Full Disk Access is a macOS setting; nothing to do on this OS.' }
  if (report.process && report.process.available === true) return { step: 'granted', say: `Full Disk Access is on for ${report.binary}. Mail and Messages are readable.` }
  if (report.restart_needed) return { step: 'restart', say: 'Access was granted; restarting the daemon so it takes effect.' }
  return { step: 'grant', say: null }
}

function instructions (binary) {
  return [
    'IRIS needs Full Disk Access to read Mail and Messages. Only you can switch it on.',
    '',
    '  1. In the Settings window that just opened: Full Disk Access → click +',
    '  2. Press ⌘⇧G, paste (already copied):',
    `       ${binary}`,
    '     then click Open. Or drag the file from the Finder window that just opened.',
    '  3. Make sure the new "node" entry is switched ON.',
    '',
    'Approve THAT file. Adding Terminal does not work: launchd starts the daemon, not your terminal.',
  ]
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function token () {
  try { return fs.readFileSync(path.join(os.homedir(), '.iris', 'bridge-token'), 'utf8').trim() } catch { return '' }
}

async function get (route) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 8000)
  try {
    return await fetch(`${BRIDGE}${route}`, { headers: { 'X-Bridge-Key': token(), Accept: 'application/json' }, signal: ctrl.signal })
  } finally { clearTimeout(t) }
}

/**
 * The permissions report, or { starting } / { old_daemon } / null (not answering).
 *
 * A 404 is NOT proof of an old daemon. Measured 2026-10-04: right after a restart the bridge
 * serves while the embedded daemon has not mounted /daemon/* yet, so /daemon/permissions 404s
 * for a few seconds. Only "health answers, permissions does not" means the code is old.
 */
async function getReport () {
  try {
    const res = await get('/daemon/permissions')
    if (res.ok) return await res.json()
    if (res.status !== 404) return null
    const health = await get('/daemon/health').catch(() => null)
    return health && health.ok ? { old_daemon: true } : { starting: true }
  } catch { return null }
}

/** Wait out a daemon that is still starting (up to `seconds`), then return the final answer. */
async function settledReport (seconds = 30) {
  let r = await getReport()
  for (let i = 0; i < seconds / 2 && (r === null || (r && r.starting)); i++) {
    await sleep(2000)
    r = await getReport()
  }
  return r && r.starting ? null : r
}

function restartDaemon () {
  const r = spawnSync(DAEMONCTL, ['restart'], { stdio: 'inherit' })
  return r.status === 0
}

/** After a restart, wait for the NEW daemon to report that it can read protected files. */
async function verifyAfterRestart (seconds = 60) {
  for (let i = 0; i < seconds / 2; i++) {
    const r = await getReport()
    if (r && r.process && r.process.available === true) return r
    await sleep(2000)
  }
  return null
}

async function main (argv) {
  const json = argv.includes('--json')
  const noWait = argv.includes('--no-wait')
  const ti = argv.indexOf('--timeout')
  const timeoutS = ti >= 0 ? Math.max(10, parseInt(argv[ti + 1], 10) || 300) : 300

  let report = await settledReport(parseInt(process.env.IRIS_GRANT_SETTLE_SECONDS || '30', 10))
  if (report && report.old_daemon) {
    console.error('This daemon is too old to check its own permissions. Update it: iris-daemon start (it pulls the latest code), then run this again.')
    return 1
  }
  if (json) {
    console.log(JSON.stringify(report || { error: 'daemon not answering' }, null, 2))
    return report && report.process && report.process.available === true ? 0 : 1
  }

  let next = nextStep(report)
  if (next.step === 'daemon_down' || next.step === 'not_applicable' || next.step === 'granted') {
    console.log(next.say)
    return next.step === 'granted' || next.step === 'not_applicable' ? 0 : 1
  }

  if (next.step === 'grant') {
    const binary = report.pinned || report.binary
    spawnSync('pbcopy', [], { input: binary })
    spawnSync('open', [report.fix.settings_url])
    spawnSync('open', ['-R', binary])
    for (const line of instructions(binary)) console.log(line)
    if (noWait) {
      console.log('', 'When it is on, run: iris-daemon restart   (or run this again and let it wait)')
      return 1
    }

    console.log('', `Waiting for the switch (up to ${Math.round(timeoutS / 60)} min). Press Enter once it is on, or Ctrl-C to stop.`)
    let enter = false
    if (process.stdin.isTTY) {
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', () => { enter = true })
    }
    const deadline = Date.now() + timeoutS * 1000
    while (Date.now() < deadline) {
      report = await getReport()
      if (report && (report.fresh?.available === true || report.process?.available === true)) break
      if (enter) break // macOS may only show the change to a restarted process; try that now.
      await sleep(2000)
    }
    if (process.stdin.isTTY) process.stdin.pause()
    if (Date.now() >= deadline && !enter) {
      console.log(`Still not on for ${binary}. Run this again when you are ready.`)
      return 1
    }
  } else {
    console.log(next.say)
  }

  console.log('Restarting the daemon so it picks up the new access…')
  if (!restartDaemon()) {
    console.log('The restart did not complete. Run: iris-daemon doctor')
    return 1
  }
  const ok = await verifyAfterRestart()
  if (ok) {
    console.log(`✓ Done. The daemon (${ok.binary}) can read Mail and Messages now.`)
    console.log('  Re-run whatever was blind, e.g. iris pulse check "<topic>"')
    return 0
  }
  const last = await getReport()
  console.log('✗ The daemon still cannot read protected files.')
  if (last && last.binary) console.log(`  It is running ${last.binary}. Make sure THAT exact file is in the list and switched on.`)
  console.log('  There can be several "node" entries; the path must match. Then run this again.')
  return 1
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(1) })
}

module.exports = { nextStep, instructions }
