const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { supervisorLabel, shouldYield, duplicateAgentMessage, acquireSocketLock } = require('../daemon/socket-lock')

const quiet = { log () {}, error () {} }
const cleanups = []
afterEach(() => { while (cleanups.length) cleanups.pop()() })

function sockPath () {
  // Unix socket paths are capped near 104 bytes on macOS — keep it short.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'd.sock')
}

/** A stand-in running daemon. `reply` decides what it says to a `replace`. */
function incumbent (sock, reply) {
  const seen = []
  const server = net.createServer((conn) => {
    conn.on('data', (d) => {
      const msg = JSON.parse(d.toString().trim())
      seen.push(msg)
      reply(msg, conn, server)
    })
  })
  cleanups.push(() => server.close())
  return new Promise((resolve) => server.listen(sock, () => resolve({ server, seen })))
}

function lock (sock, extra = {}) {
  return new Promise((resolve) => {
    const state = { acquired: false, standby: null }
    const h = acquireSocketLock({
      sockPath: sock,
      log: quiet,
      cleanupSocket: () => { try { fs.unlinkSync(sock) } catch {} },
      onAcquired: () => { state.acquired = true; resolve(state) },
      onStandby: (m) => { state.standby = m; resolve(state) },
      standbyPollMs: 100,
      releaseTimeoutMs: 1000,
      ...extra
    })
    cleanups.push(() => h.stop())
    state.handle = h
  })
}

describe('who launched me', () => {
  it('reads the launchd label, and treats a terminal as nobody', () => {
    assert.equal(supervisorLabel({ XPC_SERVICE_NAME: 'io.heyiris.daemon' }), 'io.heyiris.daemon')
    assert.equal(supervisorLabel({ XPC_SERVICE_NAME: '0' }), null)
    assert.equal(supervisorLabel({}), null)
  })
})

describe('should the running daemon hand over', () => {
  it('yes to a restart of the same job, a manual run, or an unknown holder', () => {
    assert.equal(shouldYield('io.heyiris.daemon', 'io.heyiris.daemon'), true)
    assert.equal(shouldYield('io.heyiris.daemon', null), true)
    assert.equal(shouldYield(null, 'io.heyiris.daemon.cli'), true)
  })
  it('no to a different launch agent — that is the ping-pong', () => {
    assert.equal(shouldYield('io.heyiris.daemon', 'io.heyiris.daemon.cli'), false)
  })
  it('the refusal names both agents and the command that fixes it', () => {
    const m = duplicateAgentMessage('io.heyiris.daemon', 'io.heyiris.daemon.cli')
    assert.match(m, /io\.heyiris\.daemon \(running\)/)
    assert.match(m, /launchctl bootout gui\/\$\(id -u\)\/io\.heyiris\.daemon\.cli/)
  })
})

describe('taking the socket', () => {
  it('no socket: takes it at once', async () => {
    const s = await lock(sockPath())
    assert.equal(s.acquired, true)
  })

  it('a stale socket file with nobody listening is cleaned up and taken', async () => {
    const sock = sockPath()
    const srv = net.createServer().listen(sock)
    await new Promise((r) => srv.on('listening', r))
    // Simulate a crashed daemon: the file stays, the listener is gone.
    srv.close(); fs.writeFileSync(sock, '')
    const s = await lock(sock)
    assert.equal(s.acquired, true)
  })

  it('a running daemon that hands over: we take the socket once it is gone', async () => {
    const sock = sockPath()
    const inc = await incumbent(sock, (msg, conn, server) => {
      conn.end(JSON.stringify({ status: 'ok', message: 'Shutting down for replacement' }) + '\n')
      setTimeout(() => server.close(), 50)
    })
    const s = await lock(sock, { label: 'io.heyiris.daemon' })
    assert.equal(s.acquired, true)
    assert.deepEqual(inc.seen[0], { cmd: 'replace', label: 'io.heyiris.daemon' })
  })

  it('an old daemon that answers in plain text is still a handoff', async () => {
    const sock = sockPath()
    await incumbent(sock, (msg, conn, server) => { conn.end('bye\n'); setTimeout(() => server.close(), 50) })
    const s = await lock(sock)
    assert.equal(s.acquired, true)
  })

  it('a refusal puts us on standby — no socket, no work — and we take over once it stops', async () => {
    const sock = sockPath()
    const inc = await incumbent(sock, (msg, conn) => {
      conn.end(JSON.stringify({ status: 'refused', holder: 'io.heyiris.daemon', message: duplicateAgentMessage('io.heyiris.daemon', msg.label) }) + '\n')
    })
    const s = await lock(sock, { label: 'io.heyiris.daemon.cli' })
    assert.equal(s.acquired, false, 'must not start while the other daemon runs')
    assert.match(s.standby, /io\.heyiris\.daemon\.cli/)

    // Still refused after several polls: still standing by.
    await new Promise((r) => setTimeout(r, 350))
    assert.equal(s.acquired, false)

    // The running daemon goes away: standby takes over without a restart.
    const took = new Promise((resolve) => {
      const t = setInterval(() => { if (s.acquired) { clearInterval(t); resolve() } }, 20)
    })
    inc.server.close()
    try { fs.unlinkSync(sock) } catch {}
    await took
    assert.equal(s.acquired, true)
  })
})
