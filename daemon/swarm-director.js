#!/usr/bin/env node
/**
 * Swarm Director — Orchestrates multi-pane tmux swarms.
 *
 * Runs in pane 0 of a swarm session. Reads worker panes' output via
 * tmux capture-pane, makes decisions with an LLM (gpt-4.1-nano via
 * IRIS model proxy), and steers workers via tmux send-keys.
 *
 * The director is NOT a separate daemon — it's a short-lived Node.js
 * script that runs inside the swarm's first pane. When all workers
 * finish or the goal is achieved, the director exits.
 *
 * Usage (called by task-executor, never directly):
 *   node swarm-director.js --session iris-swarm-abc123 \
 *     --goal "Research competitors and write a report" \
 *     --panes 1:researcher,2:writer,3:reviewer \
 *     --model gpt-4.1-nano
 *
 * Env: IRIS_API_URL, IRIS_API_KEY (or reads from ~/.iris/sdk/.env)
 */

const { execFileSync, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const SOCKET = 'iris'
const MAX_ROUNDS = 20
const POLL_INTERVAL_MS = 5000
const PANE_CAPTURE_LINES = 30
const LOG_DIR = path.join(os.homedir(), '.iris', 'tmux-logs')

// Structured event log — one JSON object per line, tailable
let _eventLogPath = null
function initEventLog (session) {
  _eventLogPath = path.join(LOG_DIR, `${session}-events.jsonl`)
  try { fs.writeFileSync(_eventLogPath, '') } catch {}
}

function logEvent (type, data) {
  const ts = new Date().toISOString()
  const line = JSON.stringify({ ts, type, ...data })
  console.log(`[director] ${type}: ${JSON.stringify(data).substring(0, 150)}`)
  if (_eventLogPath) {
    try { fs.appendFileSync(_eventLogPath, line + '\n') } catch {}
  }
}

// ── Parse args ──────────────────────────────────────────────────────────

function parseArgs () {
  const args = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--session') args.session = argv[++i]
    else if (argv[i] === '--goal') args.goal = argv[++i]
    else if (argv[i] === '--panes') args.panes = argv[++i]
    else if (argv[i] === '--model') {
      const m = argv[++i]
      args.model = m.startsWith('iris/') ? m : `iris/${m}`
    }
    else if (argv[i] === '--max-rounds') args.maxRounds = parseInt(argv[++i], 10)
    else if (argv[i] === '--timeout') args.timeout = parseInt(argv[++i], 10)
  }
  return args
}

// ── tmux helpers ────────────────────────────────────────────────────────

function tmux (...args) {
  try {
    return execFileSync('tmux', ['-L', SOCKET, ...args], {
      timeout: 10000,
      stdio: 'pipe'
    }).toString().trim()
  } catch {
    return ''
  }
}

function capturePaneOutput (session, paneIndex, lines = PANE_CAPTURE_LINES) {
  const raw = tmux('capture-pane', '-p', '-t', `${session}:0.${paneIndex}`, '-S', `-${lines}`)
  // Strip empty lines and ANSI escape codes
  return raw
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[^[]*\\/g, '')
    .split('\n')
    .filter(l => l.trim())
    .join('\n')
}

function sendToPane (session, paneIndex, text) {
  execFileSync('tmux', ['-L', SOCKET, 'send-keys', '-t', `${session}:0.${paneIndex}`, text, 'Enter'], {
    timeout: 5000,
    stdio: 'pipe'
  })
}

function isPaneAlive (session, paneIndex) {
  try {
    const result = tmux('list-panes', '-t', session, '-F', '#{pane_index}|#{pane_pid}')
    return result.split('\n').some(l => {
      const [idx, pid] = l.split('|')
      return parseInt(idx) === paneIndex && parseInt(pid) > 0
    })
  } catch {
    return false
  }
}

function isSessionAlive (session) {
  try {
    execFileSync('tmux', ['-L', SOCKET, 'has-session', '-t', session], { stdio: 'pipe', timeout: 5000 })
    return true
  } catch {
    return false
  }
}

// ── LLM call (IRIS model proxy) ─────────────────────────────────────────

function loadApiConfig () {
  let apiKey = process.env.IRIS_API_KEY || ''
  let apiUrl = process.env.IRIS_API_URL || 'https://freelabel.net'

  if (!apiKey) {
    try {
      const envPath = path.join(os.homedir(), '.iris', 'sdk', '.env')
      const text = fs.readFileSync(envPath, 'utf-8')
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.startsWith('IRIS_API_KEY=')) apiKey = trimmed.slice(13)
        if (trimmed.startsWith('IRIS_API_URL=')) apiUrl = trimmed.slice(13)
      }
    } catch {}
  }

  // Also try the node API key (daemon config)
  if (!apiKey) {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.iris', 'config.json'), 'utf-8'))
      apiKey = config.node_api_key || ''
      if (config.iris_api_url) apiUrl = config.iris_api_url
    } catch {}
  }

  return { apiKey, apiUrl }
}

async function callLLM (messages, model = 'gpt-4.1-nano') {
  const { apiKey, apiUrl } = loadApiConfig()

  const res = await fetch(`${apiUrl}/api/v6/openai/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.3,
      max_tokens: 1024
    }),
    signal: AbortSignal.timeout(30000)
  })

  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`LLM call failed (${res.status}): ${err.substring(0, 200)}`)
  }

  const data = await res.json()
  return data.choices?.[0]?.message?.content || ''
}

// ── Director loop ───────────────────────────────────────────────────────

async function runDirector () {
  const args = parseArgs()
  const session = args.session
  const goal = args.goal || 'Complete the assigned tasks'
  const model = args.model || 'iris/gpt-4.1-nano'
  const maxRounds = args.maxRounds || MAX_ROUNDS
  const timeoutMs = (args.timeout || 600) * 1000

  if (!session) {
    console.error('Usage: node swarm-director.js --session <name> --goal <text> --panes <spec>')
    process.exit(1)
  }

  // Parse pane spec: "1:researcher,2:writer,3:reviewer"
  const workerPanes = (args.panes || '').split(',').filter(Boolean).map(p => {
    const [idx, role] = p.split(':')
    return { index: parseInt(idx), role: role || `worker-${idx}` }
  })

  if (workerPanes.length === 0) {
    console.error('No worker panes specified')
    process.exit(1)
  }

  initEventLog(session)

  logEvent('start', { session, goal, workers: workerPanes, model, maxRounds })
  console.log(`\n[director] Session: ${session}`)
  console.log(`[director] Goal: ${goal}`)
  console.log(`[director] Workers: ${workerPanes.map(p => `${p.role} (pane ${p.index})`).join(', ')}`)
  console.log(`[director] Model: ${model}`)
  console.log(`[director] Max rounds: ${maxRounds}`)
  console.log(`[director] Starting orchestration...\n`)

  const startTime = Date.now()
  const history = [] // conversation history for LLM context

  // System prompt
  const systemPrompt = `You are a swarm director orchestrating ${workerPanes.length} agents in terminal panes.

GOAL: ${goal}

WORKERS:
${workerPanes.map(p => `- Pane ${p.index}: "${p.role}"`).join('\n')}

IMPORTANT RULES:
- Workers are bash shells. They can ONLY do things if you SEND them a command.
- A worker showing "waiting" or "ready" means it needs YOU to SEND it a command.
- If one worker has produced output that another worker needs, YOU must SEND it.
- Do NOT wait for workers that are idle — they will wait forever unless you act.
- SEND commands are typed into the worker's terminal. Use echo, bash commands, or pipe data.
- Only WAIT if a worker is actively running a process (not idle/sleeping).

COMMANDS (one per line, no other text):
- DONE: <summary> — goal is complete
- SEND pane=<N> text=<shell command> — type a command into a worker's terminal
- WAIT: <reason> — only if workers are actively processing (not idle)

Examples:
  SEND pane=1 text=echo "The top 3 frameworks are LangGraph, CrewAI, and AutoGen"
  SEND pane=2 text=echo "Summary: AI agents use multi-step orchestration..."
  WAIT: Worker in pane 0 is still running playwright test
  DONE: All campaigns completed — 45 DMs sent across 3 accounts`

  history.push({ role: 'system', content: systemPrompt })

  for (let round = 1; round <= maxRounds; round++) {
    // Check timeout
    if (Date.now() - startTime > timeoutMs) {
      logEvent('timeout', { round, elapsedMs: Date.now() - startTime })
      break
    }

    // Check session still alive
    if (!isSessionAlive(session)) {
      logEvent('session_dead', { round })
      break
    }

    // Capture all worker pane outputs
    console.log(`\n[director] ── Round ${round}/${maxRounds} ──`)
    let workerStatus = ''
    let allDone = true
    const workerSnapshots = []

    for (const w of workerPanes) {
      const alive = isPaneAlive(session, w.index)
      const output = alive ? capturePaneOutput(session, w.index) : '(pane exited)'
      const lastLines = output.split('\n').slice(-15).join('\n')
      // Extract the very last meaningful line for the snapshot
      const lastLine = output.split('\n').filter(l => l.trim()).pop() || ''

      workerStatus += `\n--- ${w.role} (pane ${w.index}) ${alive ? 'RUNNING' : 'EXITED'} ---\n${lastLines}\n`
      workerSnapshots.push({ role: w.role, pane: w.index, alive, lines: output.split('\n').length, lastLine: lastLine.substring(0, 200) })

      if (alive) allDone = false
      console.log(`  [${w.role}] ${alive ? 'running' : 'exited'} (${output.split('\n').length} lines)`)
    }

    logEvent('round', { round, maxRounds, workers: workerSnapshots, elapsedMs: Date.now() - startTime })

    // If all workers exited, we're done
    if (allDone) {
      logEvent('all_workers_exited', { round })
      break
    }

    // Ask LLM what to do
    history.push({
      role: 'user',
      content: `Round ${round}. Worker output:\n${workerStatus}`
    })

    let decision
    try {
      decision = await callLLM(history, model)
    } catch (err) {
      console.error(`[director] LLM error: ${err.message}`)
      console.log('[director] Waiting 10s before retry...')
      await sleep(10000)
      continue
    }

    history.push({ role: 'assistant', content: decision })

    // Keep history manageable (last 10 exchanges)
    if (history.length > 22) {
      // Keep system prompt + last 10 pairs
      history.splice(1, history.length - 21)
    }

    logEvent('decision', { round, decision: decision.substring(0, 500) })
    console.log(`[director] Decision:\n${decision}\n`)

    // Parse decision
    const lines = decision.split('\n').map(l => l.trim()).filter(Boolean)
    let shouldWait = false

    for (const line of lines) {
      if (line === 'DONE' || line.startsWith('DONE:') || line.startsWith('DONE ')) {
        const summary = line.replace(/^DONE[: ]*/, '').trim() || 'Goal achieved'
        logEvent('done', { round, summary, elapsedMs: Date.now() - startTime })
        console.log(`\n[director] GOAL ACHIEVED: ${summary}`)
        // Write summary to a file for the task result
        try {
          const summaryFile = path.join(os.homedir(), '.iris', 'tmux-logs', `${session}-summary.txt`)
          fs.writeFileSync(summaryFile, `Goal: ${goal}\nSummary: ${summary}\nRounds: ${round}\nDuration: ${Math.round((Date.now() - startTime) / 1000)}s\n`)
        } catch {}
        process.exit(0)
      }

      if (line.startsWith('SEND')) {
        const paneMatch = line.match(/pane=(\d+)/)
        const textMatch = line.match(/text=(.+)/)
        if (paneMatch && textMatch) {
          const paneIdx = parseInt(paneMatch[1])
          const text = textMatch[1].trim()
          const worker = workerPanes.find(w => w.index === paneIdx)
          if (worker && isPaneAlive(session, paneIdx)) {
            logEvent('send', { round, pane: paneIdx, role: worker.role, text: text.substring(0, 200) })
            console.log(`  -> Sending to ${worker.role} (pane ${paneIdx}): ${text.substring(0, 80)}`)
            try {
              sendToPane(session, paneIdx, text)
            } catch (err) {
              console.error(`  -> Send failed: ${err.message}`)
            }
          } else {
            console.log(`  -> Pane ${paneIdx} not found or exited, skipping`)
          }
        }
      }

      if (line.startsWith('WAIT:')) {
        shouldWait = true
        console.log(`  -> Waiting: ${line.substring(5).trim()}`)
      }
    }

    // Wait before next round
    const waitTime = shouldWait ? POLL_INTERVAL_MS * 2 : POLL_INTERVAL_MS
    await sleep(waitTime)
  }

  // Final summary
  console.log(`\n[director] Orchestration complete after ${Math.round((Date.now() - startTime) / 1000)}s`)

  // Capture final output from all workers
  let finalOutput = `Goal: ${goal}\n\n`
  for (const w of workerPanes) {
    const output = capturePaneOutput(session, w.index, 50)
    finalOutput += `--- ${w.role} (pane ${w.index}) ---\n${output}\n\n`
  }

  // Write final output
  try {
    const summaryFile = path.join(os.homedir(), '.iris', 'tmux-logs', `${session}-summary.txt`)
    fs.writeFileSync(summaryFile, finalOutput)
    console.log(`[director] Summary written to ${summaryFile}`)
  } catch {}
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Run ─────────────────────────────────────────────────────────────────

runDirector().catch(err => {
  console.error(`[director] Fatal: ${err.message}`)
  process.exit(1)
})
