#!/usr/bin/env node
'use strict'

/**
 * Nudge claimed Hive sessions that went quiet; tell a person when one is waiting on them (#189150).
 *
 *   node scripts/stall-sweep.js              read sessions, act, remember what was done
 *   node scripts/stall-sweep.js --dry-run    print what it would do, change nothing
 *   node scripts/stall-sweep.js --install    copy into ~/.iris/daemon-data/scripts/ for a schedule
 *
 * Schedule it (every 10 min) on one node:
 *   iris hive schedule add stall-sweep.js --cron "*\/10 * * * *"
 *
 * Unclaimed idle sessions are never touched — they are finished conversations. The rules are in
 * daemon/stall-sweep.js. State: ~/.iris/stall-sweep/state.json.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const S = fs.existsSync(path.join(__dirname, 'stall-sweep-core.js'))
  ? require('./stall-sweep-core.js')
  : require('../daemon/stall-sweep')

const STATE = path.join(os.homedir(), '.iris', 'stall-sweep', 'state.json')

function iris (args, timeout = 90000) {
  return spawnSync('iris', args, { encoding: 'utf-8', timeout })
}

function tell (a, dry) {
  const title = a.kind === 'needs_you'
    ? `[stall-sweep] Session waiting on ${a.to || 'you'}: ${a.label.slice(0, 120)}`
    : `[stall-sweep] Claimed session gone cold: ${a.label.slice(0, 120)}`
  const description = `${a.detail}.\n\nSession ${a.session_id} on ${a.node}.\nOpen it: iris hive sessions · answer it: iris hive send-input ${a.session_id} "<answer>"\n\nFiled once per question (or once per cold session) by the stall sweep (#189150).`
  if (dry) { console.log(`  would file: ${title}`); return }
  const r = iris(['bug', 'report', '--title', title, '--description', description, '--severity', 'medium', '--command', 'stall-sweep'])
  console.log(r.status === 0 ? `  filed: ${title}` : `  could not file "${title}": ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`)
}

function nudge (a, dry) {
  if (dry) { console.log(`  would nudge ${a.session_id.slice(0, 8)} (${a.detail})`); return true }
  const r = iris(['hive', 'send-input', a.session_id, a.message], 60000)
  console.log(r.status === 0 ? `  nudged ${a.session_id.slice(0, 8)} (${a.detail})` : `  could not nudge ${a.session_id.slice(0, 8)}: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`)
  return r.status === 0
}

function main () {
  const argv = process.argv.slice(2)
  if (argv.includes('--install')) {
    const dir = path.join(os.homedir(), '.iris', 'daemon-data', 'scripts')
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(__filename, path.join(dir, 'stall-sweep.js'))
    fs.copyFileSync(path.join(__dirname, '..', 'daemon', 'stall-sweep.js'), path.join(dir, 'stall-sweep-core.js'))
    console.log(`installed to ${dir} — now: iris hive schedule add stall-sweep.js --cron "*/10 * * * *"`)
    return
  }
  const dry = argv.includes('--dry-run')
  const r = iris(['hive', 'sessions', '--json'])
  let sessions
  try {
    const d = JSON.parse(r.stdout)
    sessions = Array.isArray(d) ? d : (d.sessions || [])
  } catch {
    // Could not look. Doing nothing is right: acting on a partial list would nudge the wrong set.
    console.error(`could not read sessions: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`)
    process.exit(1)
  }
  let prev = {}
  try { prev = JSON.parse(fs.readFileSync(STATE, 'utf-8')) } catch {}
  const { actions, state } = S.decide(sessions, prev)
  const waiting = sessions.filter((s) => s.waiting).length
  const claimed = sessions.filter((s) => s.claim).length
  console.log(`${sessions.length} sessions · ${waiting} waiting on a person · ${claimed} claimed · ${actions.length} action(s)`)
  for (const a of actions) {
    if (a.kind === 'nudge') {
      // A nudge that did not arrive is not a nudge: forget it so the next run tries again.
      if (!nudge(a, dry)) delete state.nudged[a.session_id]
    } else tell(a, dry)
  }
  if (!dry) {
    fs.mkdirSync(path.dirname(STATE), { recursive: true })
    fs.writeFileSync(STATE, JSON.stringify(state, null, 1), { mode: 0o600 })
  }
}

main()
