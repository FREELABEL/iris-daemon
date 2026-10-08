'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { agentCommand } = require('../daemon/agent-cli')

test('no iris-code installed: runs the iris CLI non-interactively (was exit 127 on every node)', () => {
  const r = agentCommand('do the thing', { home: '/h', exists: (p) => p === '/h/.iris/bin/iris' })
  assert.deepStrictEqual(r, { cmd: '/h/.iris/bin/iris', args: ['run', 'do the thing'], via: 'iris' })
})

test('a real iris-code keeps its own arguments', () => {
  const r = agentCommand('x', { home: '/h', exists: (p) => p === '/usr/local/bin/iris-code' })
  assert.deepStrictEqual(r.args, ['--non-interactive', '--prompt', 'x'])
  assert.strictEqual(r.via, 'iris-code')
})

test('nothing found on disk: the bare name `iris`, never `iris-code`', () => {
  const r = agentCommand('x', { home: '/h', exists: () => false })
  assert.strictEqual(r.cmd, 'iris')
  assert.deepStrictEqual(r.args, ['run', 'x'])
})

test('the prompt is one argument, never split or shell-interpolated', () => {
  const p = 'reply "OK"; rm -rf ~ $(whoami)'
  assert.deepStrictEqual(agentCommand(p, { exists: () => false }).args, ['run', p])
})

const { opencodeCommand } = require('../daemon/agent-cli')

test('the opencode runtime uses `opencode run`, never the TUI flag that hangs (#188351)', () => {
  assert.deepStrictEqual(opencodeCommand('fix it', { opencode: '/usr/bin/opencode' }), { cmd: '/usr/bin/opencode', args: ['run', 'fix it'], via: 'opencode' })
})

test('no opencode on the node: the node\'s own iris runs it non-interactively', () => {
  const r = opencodeCommand('fix it', { opencode: null, home: '/h', exists: (p) => p === '/h/.iris/bin/iris' })
  assert.deepStrictEqual(r.args, ['run', 'fix it'])
  assert.strictEqual(r.via, 'iris')
})

const { unattendedPermissionEnv } = require('../daemon/agent-cli')
const perm = (r) => JSON.parse(r.OPENCODE_PERMISSION)

test('an unwatched agent is told to stay in its workspace instead of asking nobody (#188292)', () => {
  assert.deepStrictEqual(perm(unattendedPermissionEnv({ config: {} }, {})), { external_directory: 'deny' })
})

test("the operator's OPENCODE_PERMISSION is kept, and their external_directory rule is never overridden", () => {
  assert.deepStrictEqual(perm(unattendedPermissionEnv({}, { OPENCODE_PERMISSION: '{"bash":"allow"}' })), { bash: 'allow', external_directory: 'deny' })
  assert.deepStrictEqual(unattendedPermissionEnv({}, { OPENCODE_PERMISSION: '{"external_directory":"allow"}' }), {})
})

test('a task that needs another folder opts out explicitly', () => {
  assert.deepStrictEqual(unattendedPermissionEnv({ config: { allow_outside_workspace: true } }, {}), {})
})

test('a malformed operator value is replaced, not crashed on', () => {
  assert.deepStrictEqual(perm(unattendedPermissionEnv({}, { OPENCODE_PERMISSION: 'not json' })), { external_directory: 'deny' })
})
