#!/usr/bin/env node
/**
 * R1 Simulator — a fake handheld, so the IRIS path is provable without hardware.
 *
 *   node scripts/r1-simulate.js --device my-r1 --token <token> "what is on my plate today"
 *   node scripts/r1-simulate.js --device my-r1 --token <token> --audio ./clip.wav
 *   node scripts/r1-simulate.js --device my-r1 --token <token> --repl
 *
 * Why this exists: without it, the first test of the whole chain would be the
 * day the R1 arrives — and every layer (pairing, WS, transcribe, agent, reply)
 * would be untested at once. This exercises all of them today. What it does NOT
 * test is the one thing it cannot: whether real hardware speaks the `openclaw`
 * dialect the way drivers/r1-dialects.js guesses. Run the simulator on
 * --dialect native to prove IRIS; use R1_CAPTURE=1 with a real device to learn
 * the wire format. Do not mistake a green simulator for a working R1.
 */

const fs = require('fs')
const readline = require('readline')
const WebSocket = require('ws')

function flag (name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : (i !== -1 ? true : fallback)
}

const DEVICE = flag('device', process.env.R1_DEVICE_ID)
const TOKEN = flag('token', process.env.R1_DEVICE_TOKEN)
const PORT = flag('port', process.env.BRIDGE_PORT || 3200)
const HOST = flag('host', '127.0.0.1')
const PATH = flag('path', '/r1')
const DIALECT = flag('dialect', 'native')
const AUDIO = flag('audio')
const REPL = flag('repl') === true

if (!DEVICE || !TOKEN) {
  console.error(`
  R1 Simulator — needs a paired device.

    node scripts/r1-setup.js pair sim-r1 --label "Simulator"
    node scripts/r1-simulate.js --device sim-r1 --token <token> "hello"

  Options:
    --device <id>     paired device id
    --token <token>   the token pair printed
    --audio <file>    send a real audio clip through /api/v1/transcribe
    --repl            interactive — type turns, see replies
    --dialect <name>  native (default) | openclaw
    --host/--port/--path
`)
  process.exit(1)
}

const prompt = process.argv.slice(2).filter(a => !a.startsWith('--') &&
  ![DEVICE, TOKEN, String(PORT), HOST, PATH, DIALECT, AUDIO].includes(a)).join(' ')

// Encode a canonical event in the chosen dialect. Kept deliberately separate
// from drivers/r1-dialects.js: if the simulator imported the server's encoder,
// a wrong dialect would agree with itself and the test would pass against a
// format no hardware speaks. A second implementation is the point.
function encode (event) {
  if (DIALECT === 'openclaw') {
    if (event.kind === 'hello') return JSON.stringify({ type: 'hello', device_id: event.deviceId, token: event.token })
    if (event.kind === 'ptt') return JSON.stringify({ type: 'audio', request_id: event.requestId, audio: event.audio, format: event.format })
    if (event.kind === 'text') return JSON.stringify({ type: 'message', request_id: event.requestId, text: event.text })
    return JSON.stringify({ type: event.kind })
  }
  if (event.kind === 'hello') return JSON.stringify({ type: 'hello', device_id: event.deviceId, token: event.token })
  if (event.kind === 'ptt') return JSON.stringify({ type: 'ptt', request_id: event.requestId, audio: event.audio, format: event.format })
  if (event.kind === 'text') return JSON.stringify({ type: 'text', request_id: event.requestId, text: event.text })
  return JSON.stringify({ type: event.kind })
}

const url = `ws://${HOST}:${PORT}${PATH}`
console.log(`\n  → ${url}  [dialect: ${DIALECT}]`)

const ws = new WebSocket(url)
let turn = 0
let rl = null
const timings = new Map()

function send (event) {
  const requestId = `sim-${++turn}`
  timings.set(requestId, Date.now())
  ws.send(encode({ ...event, requestId }))
  return requestId
}

function sendTurn (text) {
  if (AUDIO) {
    const buf = fs.readFileSync(AUDIO)
    const format = AUDIO.split('.').pop()
    console.log(`  ⇡ PTT  ${AUDIO} (${(buf.length / 1024).toFixed(0)}KB, ${format})`)
    return send({ kind: 'ptt', audio: buf.toString('base64'), format })
  }
  console.log(`  ⇡ "${text}"`)
  return send({ kind: 'text', text })
}

ws.on('open', () => {
  console.log(`  ✓ connected — saying hello as ${DEVICE}`)
  ws.send(encode({ kind: 'hello', deviceId: DEVICE, token: TOKEN }))
})

ws.on('message', (raw) => {
  let frame
  try { frame = JSON.parse(raw.toString()) } catch { return console.log(`  ⇣ <unparseable> ${raw.toString().slice(0, 200)}`) }

  const type = frame.type || frame.event
  const requestId = frame.request_id || frame.requestId
  const elapsed = timings.has(requestId) ? `${Date.now() - timings.get(requestId)}ms` : ''

  if (/welcome|session\.started/.test(type)) {
    console.log(`  ✓ paired OK — session ${(frame.session_id || '').slice(0, 8)}\n`)
    if (REPL) {
      rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '  r1> ' })
      rl.prompt()
      rl.on('line', (line) => { if (line.trim()) sendTurn(line.trim()); else rl.prompt() })
      rl.on('close', () => { ws.close(); process.exit(0) })
    } else {
      sendTurn(prompt || 'hello, who am I talking to')
    }
    return
  }

  if (/ack|transcription/.test(type)) {
    if (frame.text || frame.transcript) console.log(`  ⇣ heard: "${frame.text || frame.transcript}"  (${elapsed})`)
    return
  }

  if (/reply|response/.test(type)) {
    console.log(`\n  ⇣ ${frame.text}\n     ${elapsed}${frame.speak === false ? '' : ' · spoken'}\n`)
    if (REPL) return rl.prompt()
    ws.close()
    process.exit(0)
  }

  if (/error/.test(type)) {
    console.error(`\n  ✗ ${frame.message}\n`)
    if (REPL) return rl.prompt()
    ws.close()
    process.exit(1)
  }

  console.log(`  ⇣ ${type}`)
})

ws.on('close', (code, reason) => {
  if (code === 4401) console.error(`\n  ✗ rejected: ${reason || 'unauthorized'} — wrong token, or device not paired.\n`)
  else if (code === 4408) console.error(`\n  ✗ handshake timed out — the gateway did not accept the hello frame.\n     If --dialect openclaw, its decode mapping is unverified: run R1_CAPTURE=1.\n`)
  if (!REPL && code !== 1000) process.exit(1)
})

ws.on('error', (err) => {
  console.error(`\n  ✗ ${err.message}`)
  console.error(`     Is the gateway running?  node scripts/r1-setup.js status\n`)
  process.exit(1)
})
