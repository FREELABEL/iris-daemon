#!/usr/bin/env node
'use strict'

/**
 * Epic #192964 check R1 — live follow, measured between two real machines.
 *
 *   Words typed into a Claude Code session on node B reach a follower on THIS machine (A) in
 *   under 1 s, and over a 60 s follow ZERO `sessions.history` NodeTasks are created on B.
 *
 * How it "types": over ssh it appends a user record to a Claude Code transcript on B, the same
 * JSONL line Claude Code itself writes when you press enter. The transcript is a dedicated probe
 * file (~/.claude/projects/-iris-r1-probe/<uuid>.jsonl), so no real session is touched. The
 * write time is taken ON B inside the same process that writes the line, then corrected for the
 * clock offset between A and B (measured over ssh, midpoint of the round trip).
 *
 * Followers:
 *   --follower cli   (default) `iris hive sessions follow <id> --node B --json`: NDJSON on stdout.
 *                    This is the shipped client, which is what R1 is about.
 *   --follower poll  today's behaviour, replicated: `iris hive ask` reads the transcript through
 *                    the API every 2 s, and every read is a sessions.history NodeTask on B.
 *
 * Exit 0 only when every sample arrived, the slowest arrived in under --budget-ms, and B ran no
 * sessions.history task during the window.
 *
 *   IRIS_API_KEY=… node scripts/r1-live-follow.js --node iris-hive-001 [--ssh host] [--follower cli|poll]
 *                                                  [--duration 60] [--samples 6] [--budget-ms 1000]
 */

const { spawn } = require('child_process')
const crypto = require('crypto')

function arg (name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt
}
const has = (name) => process.argv.includes(`--${name}`)

const NODE_B = arg('node', 'iris-hive-001')
const SSH = arg('ssh', NODE_B)
const FOLLOWER = arg('follower', 'cli')
const DURATION_S = Number(arg('duration', 60))
const SAMPLES = Number(arg('samples', 6))
const BUDGET_MS = Number(arg('budget-ms', 1000))
const IRIS = arg('iris', 'iris')
const API = process.env.IRIS_API_URL || 'https://freelabel.net'
// The same fallback the CLI uses: ~/.iris/sdk/.env holds IRIS_API_KEY for `iris` itself.
const TOKEN = process.env.IRIS_API_KEY || (() => {
  try {
    const env = require('fs').readFileSync(require('path').join(require('os').homedir(), '.iris', 'sdk', '.env'), 'utf8')
    const m = /^IRIS_API_KEY=["']?([^"'\n]+)/m.exec(env)
    return m ? m[1].trim() : null
  } catch { return null }
})()

const log = (...a) => console.error('[r1]', ...a)
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)] : null }

async function api (path) {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' } })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status} ${JSON.stringify(body).slice(0, 200)}`)
  return body
}

/**
 * One long-lived python on B, driven over a single ssh session: each request is a JSON line, each
 * reply a line. Spawning ssh + python per sample cost ~250 ms and, worse, put the remote clock read
 * at an unknown point in the round trip; with a warm channel the round trip is network only, so the
 * midpoint offset is accurate to a few ms.
 */
const AGENT_PY = `
import json,os,sys,time
for line in sys.stdin:
  q=json.loads(line); t=int(time.time()*1000); out={'t':t}
  if q.get('op')=='append':
    p=os.path.expanduser(q['file']); os.makedirs(os.path.dirname(p),exist_ok=True)
    rec=q['rec']; rec['timestamp']=time.strftime('%Y-%m-%dT%H:%M:%S',time.gmtime(t/1000))+'.%03dZ'%(t%1000)
    with open(p,'a') as f:
      f.write(json.dumps(rec)+'\\n'); f.flush()
  elif q.get('op')=='rm':
    try: os.remove(os.path.expanduser(q['file']))
    except Exception as e: out['error']=str(e)
  sys.stdout.write(json.dumps(out)+'\\n'); sys.stdout.flush()
`
function startAgentOnB () {
  const b64 = Buffer.from(AGENT_PY).toString('base64')
  const child = spawn('ssh', ['-o', 'BatchMode=yes', SSH, `python3 -u -c 'import base64;exec(base64.b64decode("${b64}"))'`], { stdio: ['pipe', 'pipe', 'inherit'] })
  const waiting = []
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d
    let nl
    while ((nl = buf.indexOf('\n')) > -1) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); const w = waiting.shift(); if (w) w(JSON.parse(line)) }
  })
  const ask = (q) => new Promise((resolve) => { waiting.push(resolve); child.stdin.write(JSON.stringify(q) + '\n') })
  return { ask, close: () => child.stdin.end() }
}

async function clockOffsetMs (agent) {
  await agent.ask({ op: 'time' }) // warm
  // remote − local, from the best of 7 round trips (least queueing = least error).
  let best = null
  for (let i = 0; i < 7; i++) {
    const t0 = Date.now()
    const { t } = await agent.ask({ op: 'time' })
    const t1 = Date.now()
    if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: t - (t0 + t1) / 2 }
  }
  return best
}

const PROBE_DIR = '~/.claude/projects/-iris-r1-probe'

function userRecord (sessionId, text) {
  return ({
    type: 'user',
    sessionId,
    cwd: '/tmp/iris-r1-probe',
    uuid: crypto.randomUUID(),
    message: { role: 'user', content: text },
  })
}

/** A follower reports each message text it sees, with the local time it saw it. */
function startCliFollower (sessionId, onText, onState) {
  const child = spawn(IRIS, ['hive', 'sessions', 'follow', sessionId, '--node', NODE_B, '--provider', 'claude_code', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d
    let nl
    while ((nl = buf.indexOf('\n')) > -1) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
      let ev; try { ev = JSON.parse(line) } catch { continue }
      if (ev.event === 'state') onState(ev)
      for (const m of ev.messages || []) if (typeof m.text === 'string') onText(m.text, Date.now())
    }
  })
  let err = ''
  child.stderr.on('data', (d) => { err += d })
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve({ code, err })))
  return { stop: () => child.kill('SIGTERM'), exited }
}

function startPollFollower (sessionId, onText, onState) {
  let stopped = false
  const q = new URLSearchParams({ machine: NODE_B, provider: 'claude_code', limit: '40' })
  ;(async () => {
    onState({ event: 'state', mode: 'polling', interval_ms: 2000 })
    while (!stopped) {
      await new Promise((r) => setTimeout(r, 2000))
      if (stopped) break
      try {
        const body = await api(`/api/v6/nodes/sessions/${encodeURIComponent(sessionId)}/transcript?${q}`)
        const at = Date.now()
        for (const m of body.messages || []) if (typeof m.text === 'string') onText(m.text, at)
      } catch (e) { log('poll read failed:', e.message) }
    }
  })()
  return { stop: () => { stopped = true }, exited: new Promise(() => {}) }
}

async function historyTasksOnB (nodeId, sinceMs) {
  const me = await api('/api/v6/nodes/tasks?' + new URLSearchParams({ type: 'bridge_call', since: `${Math.ceil(DURATION_S / 60) + 3}m`, limit: '500' }))
  return (me.tasks || []).filter((t) =>
    t.node_id === nodeId &&
    /sessions\.history/.test(String(t.title || '') + String(t.prompt || '')) &&
    Date.parse(t.created_at) >= sinceMs)
}

async function main () {
  if (!TOKEN) { console.error('IRIS_API_KEY is not set'); process.exit(2) }
  const nodes = (await api('/api/v6/nodes')).nodes || []
  const b = nodes.find((n) => n.name === NODE_B || n.id === NODE_B)
  if (!b) throw new Error(`node ${NODE_B} is not in this account's Hive`)
  log(`B = ${b.name} (${b.id}), ${b.connection_status}; follower = ${FOLLOWER}`)

  const sessionId = crypto.randomUUID()
  const file = `${PROBE_DIR}/${sessionId}.jsonl`
  const agent = startAgentOnB()
  await agent.ask({ op: 'append', file, rec: userRecord(sessionId, 'iris r1 probe: session opened') })
  const clock = await clockOffsetMs(agent)
  log(`probe session ${sessionId} on B; clock offset B−A ${Math.round(clock.offset)} ms (ssh rtt ${clock.rtt} ms)`)

  const seen = new Map() // nonce → local ms
  const states = []
  let firstTextAt = null // when the follower first showed anything: its snapshot (or first poll)
  const onText = (text, at) => {
    if (firstTextAt === null) firstTextAt = at
    const m = /r1-nonce-([a-f0-9]{12})/.exec(text)
    if (m && !seen.has(m[1])) seen.set(m[1], at)
  }
  const onState = (ev) => { states.push({ at: Date.now(), ...ev }); log('follower state:', JSON.stringify(ev)) }

  const follower = FOLLOWER === 'poll' ? startPollFollower(sessionId, onText, onState) : startCliFollower(sessionId, onText, onState)
  let early = null
  follower.exited.then((x) => { early = x })

  // R1 scores words typed into a session someone is ALREADY following, so the window opens once the
  // follower shows its first view (snapshot), not after a fixed guess. How long that took is reported
  // on its own as follower_ready_ms: a cold start is a separate number, never folded into a sample.
  const spawnedAt = Date.now()
  while (firstTextAt === null && !early && Date.now() - spawnedAt < 20000) await new Promise((r) => setTimeout(r, 50))
  const followerReadyMs = firstTextAt === null ? null : firstTextAt - spawnedAt
  log(`follower ready (first view) after ${followerReadyMs} ms`)
  await new Promise((r) => setTimeout(r, 500))
  const windowStart = Date.now()
  const samples = []
  const gap = (DURATION_S * 1000) / SAMPLES
  for (let i = 0; i < SAMPLES; i++) {
    const at = windowStart + i * gap + 1000
    await new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())))
    if (early) break
    const nonce = crypto.randomBytes(6).toString('hex')
    const { t: writtenB } = await agent.ask({ op: 'append', file, rec: userRecord(sessionId, `r1-nonce-${nonce} typed on B, sample ${i + 1}`) })
    samples.push({ nonce, writtenA: writtenB - clock.offset })
  }
  await new Promise((r) => setTimeout(r, Math.max(0, windowStart + DURATION_S * 1000 - Date.now())))
  // Grace for the last sample to land before scoring it missing.
  await new Promise((r) => setTimeout(r, 3000))
  follower.stop()
  const exit = early || (await Promise.race([follower.exited, new Promise((r) => setTimeout(() => r(null), 2000))]))

  const tasks = await historyTasksOnB(b.id, windowStart)
  if (!has('keep')) await agent.ask({ op: 'rm', file })
  agent.close()

  const rows = samples.map((s) => ({ nonce: s.nonce, latency_ms: seen.has(s.nonce) ? Math.round(seen.get(s.nonce) - s.writtenA) : null }))
  const lat = rows.filter((r) => r.latency_ms !== null).map((r) => r.latency_ms)
  const missing = rows.filter((r) => r.latency_ms === null).length
  const worst = lat.length ? Math.max(...lat) : null
  const pass = samples.length === SAMPLES && missing === 0 && worst !== null && worst < BUDGET_MS && tasks.length === 0

  const report = {
    check: 'R1', epic: 192964, at: new Date().toISOString(), from: require('os').hostname(), node_b: b.name,
    follower: FOLLOWER, follower_ready_ms: followerReadyMs, window_s: DURATION_S, samples: rows,
    latency_ms: { p50: pct(lat, 50), p95: pct(lat, 95), max: worst }, missing,
    sessions_history_tasks_on_b: tasks.length,
    follower_states: states.map((s) => s.mode || s.state).filter(Boolean),
    follower_exit: exit && exit.code !== 0 && exit.code !== null ? { code: exit.code, stderr: exit.err.trim().split('\n').slice(-3).join(' | ') } : undefined,
    verdict: pass ? 'PASS' : 'FAIL',
    why: pass ? undefined : [
      samples.length < SAMPLES && `follower exited early (${samples.length}/${SAMPLES} samples written)`,
      missing && `${missing}/${rows.length} samples never reached A`,
      worst !== null && worst >= BUDGET_MS && `slowest sample ${worst} ms ≥ ${BUDGET_MS} ms`,
      tasks.length && `${tasks.length} sessions.history NodeTasks created on ${b.name} in ${DURATION_S} s`,
    ].filter(Boolean),
  }
  console.log(JSON.stringify(report, null, 2))
  process.exit(pass ? 0 : 1)
}

main().catch((e) => { console.error('[r1] error:', e.message); process.exit(2) })
