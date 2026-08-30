const { describe, it } = require('node:test')
const assert = require('node:assert')
const { planPeerExec, PEER_EXEC_MAX_SECONDS } = require('../daemon/peer-exec')

/**
 * `peer_exec` — a Hive peer running a command on this machine.
 *
 * Two things were wrong with the original, and they compound:
 *
 *   1. It used execSync, which BLOCKS THE DAEMON'S EVENT LOOP. The heartbeat lives in the
 *      same process, and the daemon collects pending work on that heartbeat — so a peer
 *      command froze the node for its whole duration, made it look offline, and stopped it
 *      picking up any other work.
 *   2. The timeout was capped at 60s, which is shorter than a real `brew install`. The stated
 *      use for this capability is helping someone set their machine up, and the cap killed
 *      exactly that — halfway, which can leave a package half-installed.
 */
describe('planPeerExec — what a peer is allowed to run, and for how long', () => {
  const defaults = { dataDir: '/share' }

  it('takes the command from config, and the cwd defaults to the share', () => {
    const p = planPeerExec({ config: { command: 'brew --version' } }, defaults)
    assert.equal(p.ok, true)
    assert.equal(p.command, 'brew --version')
    assert.equal(p.cwd, '/share')
  })

  it('a command is REQUIRED, and a non-string is not a command', () => {
    for (const bad of [undefined, '', '   ', 42, null, {}, []]) {
      const p = planPeerExec({ config: { command: bad } }, defaults)
      assert.equal(p.ok, false, `must refuse: ${JSON.stringify(bad)}`)
    }
  })

  it('allows long enough for a real install', () => {
    // The whole point. 60s killed `brew install` halfway.
    assert.ok(PEER_EXEC_MAX_SECONDS >= 300,
      'the cap must outlive a real package install, or this capability cannot do its job')
    const p = planPeerExec({ config: { command: 'brew install x' }, timeout_seconds: 500 }, defaults)
    assert.equal(p.timeoutMs, 500 * 1000)
  })

  /**
   * A CAP STILL EXISTS. Unbounded would mean a peer could hold a slot on someone else's
   * machine forever — the timeout is what makes the grant revocable in practice.
   */
  it('clamps an absurd timeout rather than honouring it', () => {
    const p = planPeerExec({ config: { command: 'sleep 99999' }, timeout_seconds: 999999 }, defaults)
    assert.equal(p.timeoutMs, PEER_EXEC_MAX_SECONDS * 1000)
  })

  it('a missing or nonsense timeout falls back to the default, never to zero', () => {
    for (const bad of [undefined, null, 0, -5, 'soon', NaN]) {
      const p = planPeerExec({ config: { command: 'ls' }, timeout_seconds: bad }, defaults)
      assert.ok(p.timeoutMs > 0, `timeout must be positive for ${JSON.stringify(bad)}`)
    }
  })

  it('a peer may choose its working directory', () => {
    // Unlike file browsing, exec is NOT confined to the share — `terminal` is the stronger
    // permission and grants the machine. That asymmetry is deliberate, and worth stating so
    // nobody mistakes the file sandbox for a limit on this.
    const p = planPeerExec({ config: { command: 'ls', cwd: '/tmp' } }, defaults)
    assert.equal(p.cwd, '/tmp')
  })
})
