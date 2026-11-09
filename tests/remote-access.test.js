'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const ra = require('../daemon/remote-access')

/**
 * "Allow access to this computer" (epic #192964, W2). Desktop writes ~/.iris/remote-access.json;
 * the daemon reads it. These pin the default (absent = ON, like the CLI), what OFF sends the hub,
 * and that inbound control is refused before anything else in session_message runs.
 */
function file (content) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-'))
  const f = path.join(d, 'remote-access.json')
  if (content !== undefined) fs.writeFileSync(f, content)
  return f
}

test('absent, malformed, or allow:true is ON; only allow:false is OFF', () => {
  assert.strictEqual(ra.remoteAccessAllowed(file()), true, 'absent = the default, ON')
  assert.strictEqual(ra.remoteAccessAllowed(file('{not json')), true, 'unreadable must not lock a machine out')
  assert.strictEqual(ra.remoteAccessAllowed(file('{"allow":true}')), true)
  assert.strictEqual(ra.remoteAccessAllowed(file('{}')), true)
  assert.strictEqual(ra.remoteAccessAllowed(file('{"allow":false}')), false)
})

test('OFF: the heartbeat carries the goodbye the hub marks offline on; ON leaves it untouched', () => {
  const state = { capacity: { level: 'ok' }, sessions: [] }
  assert.strictEqual(ra.withRemoteAccess(state, true), state)
  assert.deepStrictEqual(ra.withRemoteAccess(state, false), { ...state, going_offline: true, remote_access: false })
})

test('watch reports a flip, and only a flip', async () => {
  const f = file('{"allow":true}')
  const seen = []
  const stop = ra.watch((a) => seen.push(a), f)
  try {
    fs.writeFileSync(f, '{"allow":false}')
    await new Promise((r) => setTimeout(r, 4500))
    fs.writeFileSync(f, '{"allow":false,"updated_at":"x"}')
    await new Promise((r) => setTimeout(r, 4500))
  } finally { stop() }
  assert.deepStrictEqual(seen, [false])
})

const EXEC = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'task-executor.js'), 'utf8')
const DAEMON = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'index.js'), 'utf8')

test('session_message (send-input, ask, answer) is refused first while OFF', () => {
  const at = EXEC.indexOf("case 'session_message': {")
  const refusal = EXEC.indexOf("remoteAccessAllowed()", at)
  const firstUse = EXEC.indexOf('if (!sessionId)', at)
  assert.ok(at > 0 && refusal > at && refusal < firstUse, 'the refusal must come before the task is looked at')
  assert.match(EXEC.slice(refusal, refusal + 200), /reject\(new Error\(require\('\.\/remote-access'\)\.REFUSAL\)\)/)
})

test('the daemon wraps every heartbeat with the switch, and says goodbye at once when it flips', () => {
  assert.match(DAEMON, /getStateCallback = \(\) => remoteAccess\.withRemoteAccess\(reportState\(\)\)/)
  assert.match(DAEMON, /remoteAccess\.watch\(/)
})
