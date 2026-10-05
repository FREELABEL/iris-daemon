'use strict'

/**
 * computer_use — drive a desktop app through Cua Driver, on THIS node (#187922, GAP K).
 *
 * WHY THIS EXISTS. A Hive agent got a shell; GUI control existed only for browsers and Electron,
 * so an agent could not use the app the work is actually in. Cua Driver and Lume are MIT
 * (github.com/trycua/cua, LICENSING.md) and run on the machine whose desktop they drive — no
 * relay, so no third party sees the screen. We drive them; we do not write our own driver, and we
 * do not use Cua Spaces (FSL-1.1-MIT, hosted relay) — which also rules out the trycua/cua-xfce
 * image, because it runs cua-spacesd. See docs/computer-use.md for install steps.
 *
 * Task shape (fl-iris-api validates the same, app/Services/Hive/ComputerUseTask.php):
 *   config.desktop  host | macos | linux   (no default: driving a real desktop is a choice)
 *   config.steps    [{ tool, args }]       tools from the Cua Driver contract, allowlisted
 *   config.agent_id / config.run_id        the kill switch and the live view this task answers to
 *
 * Every step ASKS FIRST: POST …/steps {phase:'tool_call'} → {continue}. The answer is the kill
 * switch (#187908 AgentRunGate, or a cancel), so a paused agent stops between clicks, not after
 * the script. The same call feeds the run's live view (#187921). If the cloud cannot be reached
 * the task STOPS — a kill switch that a network blip bypasses is not one.
 *
 * PHI (#187918): a PHI task's screens never leave the node. Images in a tool result are written to
 * the task directory and stripped from everything sent; `upload` is never called; step events
 * carry tool names and argument SHAPES only, for every task.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile, spawn } = require('child_process')
const { isPhiTask } = require('../lib/phi-task')

// Cua Driver contract 0.8.0 (libs/cua-driver/contract/manifest.json), minus escalate_session
// (widens permissions mid-run) and the agent-cursor cosmetics. Same list as the server.
const TOOLS = new Set([
  'list_apps', 'list_windows', 'get_window_state', 'get_desktop_state', 'get_screen_size',
  'get_cursor_position', 'verify_state', 'click', 'drag', 'scroll', 'move_cursor', 'type_text',
  'press_key', 'hotkey', 'invoke_menu', 'set_window_frame', 'clipboard_read', 'clipboard_write',
  'start_session', 'end_session', 'get_session', 'get_session_state'
])
const DESKTOPS = new Set(['host', 'macos', 'linux'])
const MAX_STEPS = 200
const IMAGE_KEY = /^(screenshot|screenshots|image|images|png|image_base64|frame|recording)$/i

/**
 * Both Cua Driver and Lume send pseudonymous telemetry to PostHog BY DEFAULT (cua-driver docs
 * "Keep it running" § telemetry; libs/lume/README.md § Telemetry). The ticket's bar is "no
 * traffic leaves our nodes", so every process we start gets every documented off switch.
 */
function quietEnv (base = process.env) {
  return {
    ...base,
    DO_NOT_TRACK: '1',
    CUA_TELEMETRY: '0',
    CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false',
    LUME_TELEMETRY_ENABLED: 'false'
  }
}

/** Returns { desktop, steps } or throws with a message the caller can act on. */
function validate (config = {}) {
  if (!DESKTOPS.has(config.desktop)) {
    throw new Error(`computer_use needs config.desktop: one of ${[...DESKTOPS].join(', ')}`)
  }
  const steps = config.steps
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS) {
    throw new Error(`computer_use needs config.steps: 1-${MAX_STEPS} {tool, args} steps`)
  }
  steps.forEach((s, i) => {
    if (!s || !TOOLS.has(s.tool)) throw new Error(`computer_use step ${i}: tool "${s && s.tool}" is not allowed. Allowed: ${[...TOOLS].join(', ')}`)
    if (s.args !== undefined && (typeof s.args !== 'object' || s.args === null || Array.isArray(s.args))) {
      throw new Error(`computer_use step ${i}: args must be an object`)
    }
  })
  return { desktop: config.desktop, steps }
}

/** Key → type name. What the live view shows; never the values (typed text can be a chart note). */
function shapes (args = {}) {
  const out = {}
  for (const [k, v] of Object.entries(args || {})) {
    out[k] = v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v
  }
  return out
}

/** Pull every image out of a tool result: [cleanResult, images[{key, data}]]. Recursive. */
function splitImages (value, images = [], trail = '') {
  if (Array.isArray(value)) return [value.map((v, i) => splitImages(v, images, `${trail}[${i}]`)[0]), images]
  if (!value || typeof value !== 'object') return [value, images]
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    // MCP content blocks put pictures in {type:'image', data}; named keys are the other shape.
    if (IMAGE_KEY.test(k) || (k === 'data' && value.type === 'image')) {
      images.push({ key: `${trail}.${k}`, data: v })
      out[k] = '[kept on node]'
    } else {
      out[k] = splitImages(v, images, `${trail}.${k}`)[0]
    }
  }
  return [out, images]
}

function run (cmd, args, { timeoutMs = 60000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: quietEnv() }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} ${args[0] || ''} failed: ${String(stderr || err.message).trim().slice(-400)}`))
      resolve(String(stdout))
    })
    if (input !== undefined) { child.stdin.end(input) }
  })
}

function parseJson (text) {
  try { return JSON.parse(text) } catch { return { raw: String(text).slice(0, 2000) } }
}

/**
 * The adapter: { start(), call(tool, args) → result, stop() }. Three real targets plus whatever a
 * test injects. Commands are the documented ones (cua.ai/docs/cua-driver quickstart and "Run in a
 * VM or over SSH"): `cua-driver call <tool> '<json>'`, `lume clone|run|get --format json|stop`.
 */
function createDriver (desktop, config = {}, { exec = run } = {}) {
  const callArgs = (tool, args) => ['call', tool, JSON.stringify(args || {})]

  if (desktop === 'host') {
    return {
      start: async () => {},
      call: async (tool, args) => parseJson(await exec('cua-driver', callArgs(tool, args))),
      stop: async () => {}
    }
  }

  if (desktop === 'macos') {
    // A throwaway clone of a prepared base VM (driver installed, permissions granted — grants
    // survive a clone while CuaDriver.app keeps its release signature). Reached over SSH on the
    // host's own VM network: the screen never crosses a relay.
    const base = config.vm_base || process.env.IRIS_CUA_LUME_BASE || 'iris-cua-base'
    const vm = `iris-cu-${Date.now().toString(36)}`
    let ip = null
    let runner = null
    return {
      start: async () => {
        await exec('lume', ['clone', base, vm], { timeoutMs: 10 * 60000 })
        runner = spawn('lume', ['run', vm], { env: quietEnv(), stdio: 'ignore', detached: true })
        runner.unref()
        const deadline = Date.now() + 5 * 60000
        while (!ip && Date.now() < deadline) {
          const info = parseJson(await exec('lume', ['get', vm, '--format', 'json']).catch(() => '[]'))
          ip = (Array.isArray(info) ? info[0] : info)?.ipAddress || null
          if (!ip) await new Promise(r => setTimeout(r, 3000))
        }
        if (!ip) throw new Error(`Lume VM ${vm} did not report an IP within 5 minutes`)
      },
      call: async (tool, args) => parseJson(await exec('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
        `lume@${ip}`, '/Users/lume/.local/bin/cua-driver', ...callArgs(tool, args).map((a, i) => i === 2 ? `'${a.replace(/'/g, "'\\''")}'` : a)])),
      stop: async () => {
        await exec('lume', ['stop', vm]).catch(() => {})
        await exec('lume', ['delete', vm, '--force']).catch(() => {})
      }
    }
  }

  // linux — our own image (cua-driver from PyPI on an Xfce base; NOT trycua/cua-xfce, which runs
  // the FSL cua-spacesd). --network none: the desktop inside needs no network to be driven by
  // `docker exec`, and a container that cannot reach anything cannot leak anything.
  const image = config.image || process.env.IRIS_CUA_LINUX_IMAGE || 'iris/cua-desktop-linux:local'
  let id = null
  return {
    start: async () => {
      id = (await exec('docker', ['run', '-d', '--rm', '--network', 'none', image], { timeoutMs: 5 * 60000 })).trim()
    },
    call: async (tool, args) => parseJson(await exec('docker', ['exec', id, 'cua-driver', ...callArgs(tool, args)])),
    stop: async () => { if (id) await exec('docker', ['rm', '-f', id]).catch(() => {}) }
  }
}

/**
 * Run one computer_use task. Never throws: returns the payload for cloud.submitResult.
 * Injected so tests run the SAME loop with no desktop and no cloud:
 *   driver      — the adapter (default: createDriver for config.desktop)
 *   step(body)  — POST …/steps; resolves {continue, reason}; a throw counts as "stop"
 *   upload(files) — artifact upload (never called for PHI)
 *   isPaused()  — the node's own pause (tray / `iris hive pause`)
 *   taskDir     — where images and the full step log stay
 */
async function runComputerUseTask (task, { driver, step, upload, isPaused = () => false, taskDir } = {}) {
  const started = Date.now()
  const phi = isPhiTask(task)
  const fail = (error, extra = {}) => ({ status: 'failed', error, duration_ms: Date.now() - started, metadata: { computer_use: true, ...extra } })

  let spec
  try { spec = validate(task.config || {}) } catch (e) { return fail(e.message) }

  const dir = taskDir || fs.mkdtempSync(path.join(os.tmpdir(), 'iris-computer-use-'))
  fs.mkdirSync(dir, { recursive: true })
  const ask = async (body) => {
    if (!step) return { continue: true }
    try {
      const r = await step(body)
      return r && r.continue === true ? r : { continue: false, reason: (r && (r.reason || r.message || r.error)) || 'the cloud did not say continue' }
    } catch (e) {
      return { continue: false, reason: `could not reach the kill switch (${e.message}) — stopping rather than acting unsupervised` }
    }
  }

  const drv = driver || createDriver(spec.desktop, task.config || {})
  const log = []
  const images = []
  let stopped = null
  try {
    try { await drv.start() } catch (e) { return fail(`could not bring up the ${spec.desktop} desktop: ${e.message}`, { desktop: spec.desktop }) }

    for (let i = 0; i < spec.steps.length; i++) {
      const { tool, args = {} } = spec.steps[i]
      if (isPaused()) { stopped = 'this node is paused'; break }
      const go = await ask({ seq: i, phase: 'tool_call', tool, arguments: shapes(args) })
      if (!go.continue) { stopped = go.reason; break }

      const t0 = Date.now()
      let ok = true
      let error = null
      let result
      try {
        const [clean, imgs] = splitImages(await drv.call(tool, args))
        result = clean
        imgs.forEach((img, n) => images.push({ step: i, n, ...img }))
      } catch (e) { ok = false; error = e.message }
      const durationMs = Date.now() - t0
      log.push({ seq: i, tool, ok, duration_ms: durationMs, error, result })

      const after = await ask({ seq: i, phase: 'tool_result', tool, status: ok ? 'success' : 'error', duration_ms: durationMs, ...(error ? { error: error.slice(0, 500) } : {}) })
      if (!ok) break
      if (!after.continue) { stopped = after.reason; break }
    }
  } finally {
    await Promise.resolve().then(() => drv.stop()).catch(() => {})
  }

  // Images stay on disk here, always; whether a copy goes anywhere is decided below.
  const files = images.map(img => {
    const file = path.join(dir, `step-${img.step}-${img.n}.png`)
    try { fs.writeFileSync(file, Buffer.from(String(img.data), 'base64'), { mode: 0o600 }) } catch { return null }
    return file
  }).filter(Boolean)
  const localLog = path.join(dir, 'computer-use-steps.json')
  try { fs.writeFileSync(localLog, JSON.stringify(log, null, 2), { mode: 0o600 }) } catch {}

  let screenshots = []
  if (!phi && upload && files.length && (task.config || {}).upload_screenshots === true) {
    try {
      const urls = await upload(files.map(f => ({ filename: path.basename(f), content_base64: fs.readFileSync(f).toString('base64'), content_type: 'image/png' })))
      screenshots = (urls || []).map(u => ({ filename: u.filename, url: u.url }))
    } catch { /* the verdict stands without pictures */ }
  }

  const done = log.filter(l => l.ok).length
  const failedStep = log.find(l => !l.ok)
  const data = {
    desktop: spec.desktop,
    steps_total: spec.steps.length,
    steps_done: done,
    // Tool names and timings only: a result body can quote the screen.
    steps: log.map(({ seq, tool, ok, duration_ms: d }) => ({ seq, tool, ok, duration_ms: d })),
    stopped_reason: stopped,
    screenshots_kept_on_node: files.length,
    screenshots,
    local_ref: localLog
  }
  const metadata = { computer_use: true, desktop: spec.desktop, stopped: !!stopped }

  if (stopped) return { status: 'failed', error: `stopped before step ${log.length}: ${stopped}`, data, duration_ms: Date.now() - started, metadata }
  if (failedStep) return { status: 'failed', error: `step ${failedStep.seq} (${failedStep.tool}) failed: ${failedStep.error}`, data, duration_ms: Date.now() - started, metadata }
  return { status: 'completed', output: `computer_use: ${done}/${spec.steps.length} steps on ${spec.desktop}`, data, duration_ms: Date.now() - started, metadata }
}

/**
 * What this node can run, for heartbeat task_capabilities. Probed, not assumed, and cached — the
 * heartbeat runs every 30s and `docker image inspect` is not free.
 *   desktop_host  — cua-driver on PATH (it drives the logged-in desktop; the daemon must run in it)
 *   desktop_macos — Apple Silicon macOS with lume on PATH and the prepared base VM present
 *   desktop_linux — docker with our cua desktop image present locally
 */
let _cap = null
function onPath (bin) {
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin'), ...String(process.env.PATH || '').split(path.delimiter)]
  return dirs.some(d => d && fs.existsSync(path.join(d, bin)))
}
function computerUseCapabilities ({ probe = probeSync } = {}) {
  if (_cap && Date.now() - _cap.at < 5 * 60 * 1000) return _cap.value
  const value = { computer_use: false, desktop_host: false, desktop_macos: false, desktop_linux: false }
  try {
    value.desktop_host = onPath('cua-driver')
    value.desktop_macos = process.platform === 'darwin' && process.arch === 'arm64' && onPath('lume') &&
      probe('lume', ['get', process.env.IRIS_CUA_LUME_BASE || 'iris-cua-base', '--format', 'json'])
    value.desktop_linux = onPath('docker') && probe('docker', ['image', 'inspect', process.env.IRIS_CUA_LINUX_IMAGE || 'iris/cua-desktop-linux:local'])
    value.computer_use = value.desktop_host || value.desktop_macos || value.desktop_linux
  } catch { /* any probe failure reports false — "could not tell" must not route work here */ }
  _cap = { at: Date.now(), value }
  return value
}
function probeSync (cmd, args) {
  try { require('child_process').execFileSync(cmd, args, { stdio: 'ignore', timeout: 5000, env: quietEnv() }); return true } catch { return false }
}
function _resetCapCache () { _cap = null }

module.exports = { runComputerUseTask, createDriver, validate, shapes, splitImages, quietEnv, computerUseCapabilities, _resetCapCache, TOOLS, DESKTOPS }
