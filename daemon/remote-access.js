'use strict'

/**
 * "Allow access to this computer" (epic #192964, W2).
 *
 * IRIS Desktop → Settings → Hive writes ~/.iris/remote-access.json as { "allow": true|false }.
 * The file is absent on every machine that never touched the switch, and absent means ON, the
 * same as the CLI, where signing in brings the machine online (#185896).
 *
 * While OFF this daemon:
 *   - tells the hub it is offline on every heartbeat (`going_offline: true`), so it leaves
 *     `iris hive nodes list` / `iris hive sessions` and nothing new is routed to it;
 *   - refuses inbound control, i.e. a `session_message` task (`iris hive send-input`, `ask`,
 *     `answer`) that was already queued or races the flip;
 *   - keeps running everything local, including its own schedules.
 * Whether OFF should instead stop the daemon outright is an open question on the epic. This is
 * the proposal: refuse inbound only.
 *
 * Read on every use (one small file), so a flip needs no restart. `watch()` lets the heartbeat
 * report a flip within seconds instead of at the next 30 s beat.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

function remoteAccessFile (home = os.homedir()) {
  return path.join(home, '.iris', 'remote-access.json')
}

/** True unless the file says `"allow": false`. Unreadable or malformed counts as ON (the default). */
function remoteAccessAllowed (file = remoteAccessFile()) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return true
  }
  try {
    return JSON.parse(raw).allow !== false
  } catch {
    return true
  }
}

const REFUSAL =
  'Remote access to this computer is off (IRIS Desktop → Settings → Hive → "Allow access to this computer"), ' +
  'so it does not take messages or answers from other machines. Turn it on there to allow it.'

/** Calls onChange(allowed) when the switch flips. Polls every 2 s, so it works on every platform. */
function watch (onChange, file = remoteAccessFile()) {
  let last = remoteAccessAllowed(file)
  const listener = () => {
    const now = remoteAccessAllowed(file)
    if (now === last) return
    last = now
    try { onChange(now) } catch { /* a failing listener must not stop the watch */ }
  }
  fs.watchFile(file, { interval: 2000, persistent: false }, listener)
  return () => fs.unwatchFile(file, listener)
}

/** The heartbeat body while OFF: the same report, plus the goodbye the hub marks offline on. */
function withRemoteAccess (state, allowed = remoteAccessAllowed()) {
  return allowed ? state : { ...(state || {}), going_offline: true, remote_access: false }
}

module.exports = { remoteAccessFile, remoteAccessAllowed, watch, withRemoteAccess, REFUSAL }
