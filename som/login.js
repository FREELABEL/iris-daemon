#!/usr/bin/env node
'use strict'
// Log an Instagram account in for SOM on THIS machine (#191636).
//
//   node som/login.js <handle> [--timeout <sec>] [--channel chrome]
//
// The one supported way to (re)log in an account. It is what `iris som login <handle>
// [--node <mac>]` runs, locally or as a Hive task. A headed window opens on the login page in
// the person's own screen session; they type the password and 2FA themselves; the session is
// saved (through ig-accounts.writeAuthFile) only once Instagram says it is logged in as <handle>.
//
// On a Mac the window is never a child of this process: it is a one-shot LaunchAgent in
// gui/<uid> (helpers/gui-launch.js), because a browser started under the daemon — which is what a
// Hive task is — inherits its Background throttling and tmux session and never finishes loading.
//
// Exit codes: 0 saved · 2 logged in as someone else · 3 window closed · 4 timed out ·
// 5 refused (the login is already saved under another account's name) · 1 anything else.
//
// Internal: `--run-window --result <file>` is the program the LaunchAgent runs.

const crypto = require('crypto')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const igLogin = require('./helpers/ig-login')
const gui = require('./helpers/gui-launch')

const SOM_DIR = __dirname

function parseArgs (argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--run-window') out.runWindow = true
    else if (a === '--timeout') out.timeoutSec = Number(argv[++i])
    else if (a === '--result') out.result = argv[++i]
    else if (a === '--channel') out.channel = argv[++i]
    else if (a === '--som-dir') out.somDir = argv[++i]
    else out._.push(a)
  }
  return out
}

function report (result, print = console.log) {
  const mark = result.outcome === 'saved' ? 'OK' : result.outcome.toUpperCase()
  print(`[som login] ${mark}: ${result.message}`)
  return igLogin.EXIT_CODES[result.outcome] ?? 1
}

/**
 * Decide how the window is opened on this platform. Pure: returns the plan, runs nothing.
 *   darwin, not already the GUI job → 'gui-session' (one-shot LaunchAgent)
 *   linux with a display, or --run-window → 'in-process'
 *   otherwise → 'refuse'
 */
function planLaunch ({ platform = process.platform, env = process.env, runWindow = false } = {}) {
  if (runWindow) return { mode: 'in-process' }
  if (platform === 'darwin') return { mode: 'gui-session' }
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return { mode: 'in-process' }
  return { mode: 'refuse', reason: 'this machine has no screen to open a login window on (no DISPLAY). Run it on the Mac: iris som login <handle> --node <mac>' }
}

async function main (argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv)
  const print = deps.print || console.log
  let handle
  try { handle = igLogin.parseHandle(args._[0]) } catch (err) {
    print(`usage: node som/login.js <instagram-handle> [--timeout <sec>]\n${err.message}`)
    return 1
  }
  const timeoutMs = Math.max(30, Number.isFinite(args.timeoutSec) && args.timeoutSec > 0 ? args.timeoutSec : 480) * 1000
  const somDir = args.somDir || SOM_DIR
  const plan = planLaunch({ platform: deps.platform, env: deps.env, runWindow: args.runWindow })

  if (plan.mode === 'refuse') return report({ outcome: 'error', handle, message: plan.reason }, print)

  if (plan.mode === 'in-process') {
    const result = await igLogin.runLogin({
      handle, somDir, timeoutMs, log: print,
      launch: deps.launch || igLogin.playwrightLauncher({ channel: args.channel }),
      identify: deps.identify,
    })
    if (args.result) {
      const fs = require('fs')
      fs.writeFileSync(`${args.result}.tmp`, JSON.stringify(result))
      fs.renameSync(`${args.result}.tmp`, args.result)
    }
    return report(result, print)
  }

  // gui-session (macOS)
  const id = crypto.randomBytes(4).toString('hex')
  const label = gui.jobLabel(handle, id)
  const workDir = path.join(deps.home || os.homedir(), '.iris', 'som-login', `${handle}-${id}`)
  const resultPath = path.join(workDir, 'result.json')
  const programArguments = [
    deps.nodePath || process.execPath, path.join(SOM_DIR, 'login.js'), handle,
    '--run-window', '--result', resultPath, '--som-dir', somDir, '--timeout', String(timeoutMs / 1000),
    ...(args.channel ? ['--channel', args.channel] : []),
  ]
  print(`[som login] opening a login window for @${handle} on this Mac's screen (up to ${Math.round(timeoutMs / 60000)} min)…`)
  const result = await gui.runInGuiSession({
    uid: deps.uid ?? process.getuid(),
    label, workDir, programArguments, resultPath,
    timeoutMs: timeoutMs + 60000, // the window enforces the real timeout; this is the backstop
    exec: deps.exec || ((cmd, a) => spawnSync(cmd, a, { encoding: 'utf8' })),
    sleep: deps.sleep, clock: deps.clock,
  })
  return report({ handle, ...result }, print)
}

if (require.main === module) {
  main().then(code => process.exit(code), err => { console.error(`[som login] ERROR: ${err.message}`); process.exit(1) })
}

module.exports = { main, parseArgs, planLaunch, report }
