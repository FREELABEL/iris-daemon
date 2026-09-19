const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { tmuxPolicy } = require('../daemon/tmux-manager')

/**
 * #184726 — the daemon hard-required tmux on every platform, so no Windows machine could ever
 * become a working node. Measured on qb-host-vanguard (Windows Server 2025): fully installed,
 * "Hive daemon starting. Your machine is now a compute node.", process gone seconds later,
 * daemon.log naming `tmux -V` as the cause.
 *
 * These run on any platform because the policy is pure — which is the point, since the bug only
 * reproduces on the platform none of us develop on.
 */
describe('tmux policy', () => {
  it('WINDOWS: tmux is NOT required, because it does not exist there', () => {
    const p = tmuxPolicy('win32', {})
    assert.equal(p.required, false)
    assert.match(p.note, /Windows/)
  })

  it('WINDOWS: the node is told what it loses, not just that something failed', () => {
    // Degraded must be legible. "tmux verification failed" told an operator nothing they could act on.
    const p = tmuxPolicy('win32', {})
    assert.match(p.note, /session persistence/i)
  })

  it('macOS and Linux RECOMMEND it but never refuse to start (#185887 — a fresh Mac has no tmux)', () => {
    for (const os of ['darwin', 'linux']) {
      const p = tmuxPolicy(os, {})
      assert.equal(p.required, false)
      assert.equal(p.mode, 'recommended')
      // Degraded must be legible: what is lost, and the command that gets it back.
      assert.match(p.note, /session persistence/i)
      assert.ok(p.note.includes(p.install))
    }
  })

  it('THE REMEDIATION NAMES A COMMAND THAT EXISTS ON THE PLATFORM PRINTING IT', () => {
    // The original printed brew AND apt everywhere, including on Windows where neither runs.
    const mac = tmuxPolicy('darwin', {})
    assert.match(mac.install, /brew/)
    assert.doesNotMatch(mac.install, /apt/)

    const linux = tmuxPolicy('linux', {})
    assert.match(linux.install, /apt/)
    assert.doesNotMatch(linux.install, /brew/)

    // Windows gets no install line at all, because there is nothing to install.
    assert.equal(tmuxPolicy('win32', {}).install, undefined)
  })

  it('IRIS_NO_TMUX=1 disables it everywhere', () => {
    assert.equal(tmuxPolicy('darwin', { IRIS_NO_TMUX: '1' }).mode, 'disabled')
    assert.equal(tmuxPolicy('linux', { IRIS_NO_TMUX: '1' }).mode, 'disabled')
  })

  it('only the exact value "1" disables it — a stray truthy string must not', () => {
    assert.equal(tmuxPolicy('darwin', { IRIS_NO_TMUX: '0' }).mode, 'recommended')
    assert.equal(tmuxPolicy('darwin', { IRIS_NO_TMUX: 'false' }).mode, 'recommended')
  })
})
