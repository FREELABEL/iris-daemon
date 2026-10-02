const { describe, it, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const { execFileSync } = require('child_process')

// An isolated tmux server — never the live daemon's `iris` socket.
process.env.IRIS_TMUX_SOCKET = `iris-test-name-${process.pid}`
const { TmuxManager } = require('../daemon/tmux-manager')

/**
 * #187456 — "A name is not an identity."
 *
 * The session name was built from the FIRST 8 characters of the task id. Task ids are UUIDv7, and
 * the first 8 hex characters of a UUIDv7 are the top of a millisecond timestamp — so every task of
 * one type created within ~65 s got the same name. The second task's createForTask then ran
 * `kill-session -t <name>` (killing the first) and deleted its exit file, and the first task's
 * waiter, finding no exit file, reported exit code 1: a FAILURE whose output was correct.
 *
 * Measured 2026-10-01: a fan-out of 3–4 tasks to one node lost one to a false failure, twice. All six
 * fan-out ids that day began `01a0f939-` — the ids below are two of them.
 */
const A = '01a0f939-2a1d-7119-841e-5f8777d9c92b'
const B = '01a0f939-2d29-7182-aaf7-6ea716d8ca8c'

describe('tmux session names', () => {
  const m = new TmuxManager()

  it('two tasks created in the same minute get different names', () => {
    assert.notEqual(m._sessionName({ id: A, type: 'sandbox_execute' }), m._sessionName({ id: B, type: 'sandbox_execute' }))
  })

  it('the same task always gets the same name', () => {
    assert.equal(m._sessionName({ id: A, type: 'sandbox_execute' }), m._sessionName({ id: A, type: 'sandbox_execute' }))
  })

  it('names stay tmux-safe (no dots or colons) and bounded', () => {
    const n = m._sessionName({ id: 'a.b:c-' + A, type: 'sandbox.execute' })
    assert.match(n, /^[A-Za-z0-9_-]+$/)
    assert.ok(n.length <= 64, `name too long: ${n.length}`)
  })
})

let hasTmux = true
try { execFileSync('tmux', ['-V']) } catch { hasTmux = false }

describe('tmux: two concurrent tasks keep their own exit codes', { skip: !hasTmux && 'tmux not installed' }, () => {
  const socket = process.env.IRIS_TMUX_SOCKET
  after(() => { try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }) } catch {} })

  it('A (exit 0, slower) is not killed by B (exit 3) starting while it runs', async () => {
    const m = new TmuxManager()
    m.available = true
    const a = m.createForTask({ id: A, type: 'sandbox_execute' }, '/bin/sh', ['-c', 'sleep 1; exit 0'], {}, os.tmpdir())
    await new Promise(r => setTimeout(r, 200))
    const b = m.createForTask({ id: B, type: 'sandbox_execute' }, '/bin/sh', ['-c', 'exit 3'], {}, os.tmpdir())
    const exitOf = async (s) => {
      const deadline = Date.now() + 15000
      while (!fs.existsSync(s.exitFile) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100))
      return fs.existsSync(s.exitFile) ? parseInt(fs.readFileSync(s.exitFile, 'utf8').trim(), 10) : null
    }
    const [codeA, codeB] = await Promise.all([exitOf(a), exitOf(b)])
    assert.equal(codeB, 3, 'B did not report its own exit code')
    assert.equal(codeA, 0, 'A did not finish with its own exit code — it was killed or its exit file overwritten')
    m.cleanup(a.sessionName); m.cleanup(b.sessionName)
  })
})
