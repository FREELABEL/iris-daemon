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
