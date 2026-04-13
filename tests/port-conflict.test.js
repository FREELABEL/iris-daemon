const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { resolvePortConflict } = require('../lib/port-conflict-resolver')

// Helper: create a mock execSync that responds to specific commands
function mockExecSync (responses = {}) {
  const calls = []

  const fn = (cmd, opts) => {
    calls.push(cmd)

    // Check each response pattern
    for (const [pattern, handler] of Object.entries(responses)) {
      if (cmd.includes(pattern)) {
        if (typeof handler === 'function') return handler(cmd, opts)
        if (handler instanceof Error) throw handler
        return handler
      }
    }

    // Default: command not found
    throw new Error(`Command failed: ${cmd}`)
  }

  fn.calls = calls
  return fn
}

describe('resolvePortConflict', () => {
  // ─── Docker container conflicts ───────────────────────────────

  describe('Docker container', () => {
    it('stops container + returns retry when IRIS_LOCAL=1', () => {
      const exec = mockExecSync({
        'docker ps': 'fl-coding-agent-bridge',
        'docker stop': ''
      })

      const result = resolvePortConflict(3200, { isLocal: true, execSync: exec })

      assert.equal(result.action, 'retry')
      assert.equal(result.stopped, 'docker')
      assert.equal(result.target, 'fl-coding-agent-bridge')
      assert.ok(exec.calls.some(c => c.includes('docker stop')), 'Should have called docker stop')
    })

    it('returns monitor (no stop) without IRIS_LOCAL', () => {
      const exec = mockExecSync({
        'docker ps': 'fl-coding-agent-bridge'
      })

      const result = resolvePortConflict(3200, { isLocal: false, execSync: exec })

      assert.equal(result.action, 'monitor')
      assert.equal(result.stopped, null)
      assert.ok(!exec.calls.some(c => c.includes('docker stop')), 'Should NOT call docker stop')
    })

    it('falls through when no Docker container found', () => {
      const exec = mockExecSync({
        'docker ps': '', // empty = no container
        'launchctl list': new Error('not found')
      })

      const result = resolvePortConflict(3200, { isLocal: true, execSync: exec })

      assert.equal(result.action, 'monitor')
    })
  })

  // ─── launchd daemon conflicts ─────────────────────────────────

  describe('launchd daemon', () => {
    it('bootouts daemon + returns retry when IRIS_LOCAL=1', () => {
      const exec = mockExecSync({
        'docker ps': '', // no Docker container
        'launchctl list': 'PID\tStatus\tLabel\n17531\t0\tio.heyiris.daemon',
        'launchctl bootout': ''
      })

      const result = resolvePortConflict(3200, { isLocal: true, execSync: exec })

      assert.equal(result.action, 'retry')
      assert.equal(result.stopped, 'launchd')
      assert.equal(result.target, 'io.heyiris.daemon')
      assert.ok(exec.calls.some(c => c.includes('launchctl bootout')), 'Should have called bootout')
    })

    it('returns monitor (no bootout) without IRIS_LOCAL', () => {
      const exec = mockExecSync({
        'docker ps': '',
        'launchctl list': 'PID\tStatus\tLabel\n17531\t0\tio.heyiris.daemon'
      })

      const result = resolvePortConflict(3200, { isLocal: false, execSync: exec })

      assert.equal(result.action, 'monitor')
      assert.equal(result.stopped, null)
      assert.ok(!exec.calls.some(c => c.includes('launchctl bootout')), 'Should NOT call bootout')
    })

    it('falls back to kill signal when bootout fails', () => {
      const exec = mockExecSync({
        'docker ps': '',
        'launchctl list': 'PID\tStatus\tLabel\n17531\t0\tio.heyiris.daemon',
        'launchctl bootout': new Error('bootout failed'),
        'launchctl kill': ''
      })

      const result = resolvePortConflict(3200, { isLocal: true, execSync: exec })

      assert.equal(result.action, 'retry')
      assert.equal(result.stopped, 'launchd')
      assert.ok(exec.calls.some(c => c.includes('launchctl kill')), 'Should have tried kill fallback')
    })
  })

  // ─── Combined scenarios ───────────────────────────────────────

  describe('combined', () => {
    it('returns monitor when neither Docker nor launchd found', () => {
      const exec = mockExecSync({
        'docker ps': '',
        'launchctl list': 'Could not find service'
      })

      const result = resolvePortConflict(3200, { isLocal: true, execSync: exec })

      assert.equal(result.action, 'monitor')
    })

    it('Docker wins when both are present (checked first)', () => {
      const exec = mockExecSync({
        'docker ps': 'fl-coding-agent-bridge',
        'docker stop': ''
      })

      const result = resolvePortConflict(3200, { isLocal: true, execSync: exec })

      assert.equal(result.action, 'retry')
      assert.equal(result.stopped, 'docker')
      // launchctl should not have been called at all — Docker returned first
      assert.ok(!exec.calls.some(c => c.includes('launchctl')),
        'Should not check launchd when Docker was found and stopped')
    })
  })
})
