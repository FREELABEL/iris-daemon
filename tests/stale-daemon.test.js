const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('child_process')
const { stopStaleDaemon, isDaemonCommand } = require('../daemon/stale-daemon')

const procs = []
afterEach(() => { while (procs.length) { try { process.kill(procs.pop().pid, 'SIGKILL') } catch {} } })

/** A real process whose command line ends in `daemon.js`, like ~/.iris/bridge/daemon.js. */
function fakeDaemon ({ ignoreTerm = false, name = 'daemon.js' } = {}) {
  const code = ignoreTerm
    ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
    : 'setInterval(()=>{},1000)'
  const p = spawn(process.execPath, ['-e', code, name], { stdio: 'ignore' })
  procs.push(p)
  return new Promise((resolve) => setTimeout(() => resolve(p), 150))
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

describe('is this an IRIS daemon', () => {
  it('matches the entry point however it was launched', () => {
    assert.equal(isDaemonCommand('node /Users/a/.iris/bridge/daemon.js'), true)
    assert.equal(isDaemonCommand('/Users/a/.nvm/versions/node/v22/bin/node daemon.js'), true)
  })
  it('never matches something else that happens to reuse the pid', () => {
    assert.equal(isDaemonCommand('node server.js'), false)
    assert.equal(isDaemonCommand('node mydaemon.js'), false)
    assert.equal(isDaemonCommand(null), false)
  })
})

describe('stopping a stale daemon (#188006)', () => {
  it('SIGTERMs a live daemon and waits for it to go', async () => {
    const p = await fakeDaemon()
    assert.equal(await stopStaleDaemon(p.pid, { graceMs: 2000 }), 'terminated')
    assert.equal(alive(p.pid), false)
  })

  it('SIGKILLs one that ignores SIGTERM', async () => {
    const p = await fakeDaemon({ ignoreTerm: true })
    assert.equal(await stopStaleDaemon(p.pid, { graceMs: 300 }), 'killed')
    assert.equal(alive(p.pid), false)
  })

  it('leaves a non-daemon process alone, even at the recorded pid', async () => {
    const p = await fakeDaemon({ name: 'server.js' })
    assert.equal(await stopStaleDaemon(p.pid, { graceMs: 300 }), 'not-a-daemon')
    assert.equal(alive(p.pid), true)
  })

  it('never stops itself, and treats a dead pid as nothing to do', async () => {
    assert.equal(await stopStaleDaemon(process.pid), 'self')
    assert.equal(await stopStaleDaemon(999999), 'not-running')
    assert.equal(await stopStaleDaemon(undefined), 'not-running')
  })
})
