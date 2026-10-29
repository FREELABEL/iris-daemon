'use strict'
// Start a program in the logged-in person's GUI (Aqua) session on a Mac, from anywhere —
// a Hive task, an SSH shell, the daemon itself (#191636).
//
// Why not just spawn it: a Hive task is a child of the daemon, which launchd runs with
// `ProcessType Background` (installers/macos/io.heyiris.daemon.plist) and, on most nodes, inside
// the daemon's `tmux -L iris` server. Everything it spawns inherits that: background CPU, disk
// and network throttling, and whatever bootstrap namespace the tmux server was born in. A
// headed Chromium started there opens a window that never finishes loading. A one-shot
// LaunchAgent bootstrapped into gui/<uid> is a fresh process launchd starts in the person's
// own session, as an Interactive job, with none of the daemon's ancestry.
//
// `launchctl asuser` is not used: it needs root. `launchctl bootstrap gui/<uid>` as that same
// user does not, provided they are logged in at the screen (checked first via /dev/console).
//
// Pure command/plist construction plus an injected exec, so it is unit-tested on Linux.

const fs = require('fs')
const path = require('path')

const LABEL_PREFIX = 'io.heyiris.som-login'

function xmlEscape (s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function jobLabel (handle, id) {
  const safe = String(handle).replace(/[^a-z0-9._-]/gi, '_')
  return `${LABEL_PREFIX}.${safe}.${String(id).replace(/[^a-z0-9-]/gi, '')}`
}

/** A one-shot LaunchAgent: runs once at bootstrap, Interactive, Aqua-only, never restarted. */
function buildPlist ({ label, programArguments, env = {}, workingDirectory, stdoutPath, stderrPath }) {
  const str = (v) => `<string>${xmlEscape(v)}</string>`
  const envXml = Object.entries(env)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>${str(v)}`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${str(label)}
  <key>ProgramArguments</key>
  <array>
${programArguments.map(a => `    ${str(a)}`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
${workingDirectory ? `  <key>WorkingDirectory</key>${str(workingDirectory)}\n` : ''}${stdoutPath ? `  <key>StandardOutPath</key>${str(stdoutPath)}\n` : ''}${stderrPath ? `  <key>StandardErrorPath</key>${str(stderrPath)}\n` : ''}  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
</dict>
</plist>
`
}

/** The launchctl calls, as [cmd, args] — what runs is exactly what the tests assert. */
function commands ({ uid, label, plistPath }) {
  const domain = `gui/${uid}`
  return {
    consoleOwner: ['stat', ['-f', '%u', '/dev/console']],
    bootstrap: ['launchctl', ['bootstrap', domain, plistPath]],
    print: ['launchctl', ['print', `${domain}/${label}`]],
    bootout: ['launchctl', ['bootout', `${domain}/${label}`]],
  }
}

/** The environment the GUI job gets: launchd passes none, so name what it needs. */
function jobEnv (env = process.env) {
  const keep = ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'PLAYWRIGHT_BROWSERS_PATH', 'IRIS_DIR']
  const out = {}
  for (const k of keep) if (env[k]) out[k] = env[k]
  return out
}

const realSleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function readJson (file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/**
 * Run programArguments in uid's GUI session and wait for it to write resultPath.
 * exec(cmd, args) → { status, stdout, stderr } (spawnSync-shaped).
 * Resolves to the result object, or { outcome: 'error', message } when it never ran or died
 * without answering. The job is always booted out afterwards.
 */
async function runInGuiSession ({
  uid, label, workDir, programArguments, resultPath, timeoutMs,
  exec, env = jobEnv(), pollMs = 1000, sleep = realSleep, clock = () => Date.now(), log = () => {},
}) {
  const plistPath = path.join(workDir, `${label}.plist`)
  const stdoutPath = path.join(workDir, 'runner.out.log')
  const stderrPath = path.join(workDir, 'runner.err.log')
  const cmds = commands({ uid, label, plistPath })
  const run = ([cmd, args]) => exec(cmd, args) || { status: 1, stdout: '', stderr: '' }

  const owner = run(cmds.consoleOwner)
  const consoleUid = String(owner.stdout || '').trim()
  if (owner.status !== 0 || consoleUid !== String(uid)) {
    return { outcome: 'error', message: `nobody is logged in at this Mac's screen as uid ${uid} (the screen belongs to uid ${consoleUid || 'unknown'}) — a login window has nowhere to open. Log in on the Mac itself first.` }
  }

  fs.mkdirSync(workDir, { recursive: true })
  fs.writeFileSync(plistPath, buildPlist({ label, programArguments, env, workingDirectory: workDir, stdoutPath, stderrPath }), { mode: 0o600 })
  try { fs.rmSync(resultPath, { force: true }) } catch {}

  run(cmds.bootout) // a leftover job under this label would make bootstrap fail
  const boot = run(cmds.bootstrap)
  if (boot.status !== 0) {
    return { outcome: 'error', message: `launchd would not start the login window in your session: ${String(boot.stderr || boot.stdout || `exit ${boot.status}`).trim()}` }
  }
  log(`started ${label} in gui/${uid}`)

  try {
    const deadline = clock() + timeoutMs
    let goneSince = null
    while (clock() < deadline) {
      const result = readJson(resultPath)
      if (result && result.outcome) return result
      const p = run(cmds.print)
      const running = p.status === 0 && /state = running/.test(String(p.stdout || ''))
      if (!running) {
        if (goneSince == null) goneSince = clock()
        else if (clock() - goneSince > 5000) {
          let tail = ''
          try { tail = fs.readFileSync(stderrPath, 'utf8').split('\n').filter(Boolean).slice(-5).join('\n') } catch {}
          return { outcome: 'error', message: `the login window's process exited without a result${tail ? `:\n${tail}` : ''}` }
        }
      } else goneSince = null
      await sleep(pollMs)
    }
    return { outcome: 'timeout', message: 'the login window did not report back in time — nothing was saved' }
  } finally {
    run(cmds.bootout)
  }
}

module.exports = { LABEL_PREFIX, jobLabel, buildPlist, commands, jobEnv, runInGuiSession }
