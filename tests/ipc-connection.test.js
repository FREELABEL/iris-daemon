// #185157 — the daemon crash-looped: 14 restarts in 15 minutes, unhandled EPIPE
// writing to a closed IPC socket.
//
// net.createServer((conn) => { conn.on('data', ...) }) wires exactly one event.
// handleIpcMessage then calls conn.end(...) from ~20 branches. Any CLI that has
// already exited — Ctrl-C, a timeout, `iris hive status | head` closing the pipe —
// leaves a socket whose write emits 'error'. With no 'error' listener node
// promotes that to an uncaught exception and the process dies.
//
// The node-level symptom is worse than the crash. A crash-looping daemon still
// reports ONLINE and heartbeats, so dispatched work goes to it and hangs to
// timeout instead of failing fast. `iris hive nodes list` said so in plain text:
// "up 7m · 14 restarts in the last 15m — crash-looping; work sent here will hang".

const test = require('node:test')
const assert = require('node:assert')
const net = require('net')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { wireIpcConnection } = require('../lib/ipc-connection')

function tmpSock () {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iris-ipc-')), 's.sock')
}

/**
 * Drive a real server over a real unix socket, with a client that hangs up before
 * the handler replies. Mocking the socket would assert the shape of the fix
 * rather than the behaviour that broke.
 */
function withServer (onMessage, clientBehaviour) {
  return new Promise((resolve, reject) => {
    const sock = tmpSock()
    const seen = []
    const live = new Set()
    const server = net.createServer((conn) => {
      live.add(conn)
      conn.on('close', () => live.delete(conn))
      wireIpcConnection(conn, onMessage, (e) => seen.push(e))
    })
    server.listen(sock, () => {
      const client = net.createConnection(sock, () => clientBehaviour(client))
      client.on('error', () => { /* the client hanging up IS the scenario */ })
      setTimeout(() => {
        // server.close() waits for open connections, and a half-dead socket can
        // keep it waiting forever — which is how the first version of this file
        // hung the whole test run instead of failing. Tear the sockets down.
        for (const c of live) c.destroy()
        client.destroy()
        server.close(() => resolve(seen))
      }, 300)
    })
    server.on('error', reject)
  })
}

test('a reply to a client that already hung up does not throw', async () => {
  const uncaught = []
  const onUncaught = (e) => uncaught.push(e)
  process.on('uncaughtException', onUncaught)
  try {
    await withServer(
      (msg, conn) => {
        // A big payload so the write reaches the socket rather than sitting in a buffer.
        setTimeout(() => { try { conn.end(JSON.stringify({ ok: true, pad: 'x'.repeat(200000) })) } catch { /* must not need this */ } }, 60)
      },
      (client) => {
        client.write(JSON.stringify({ command: 'status' }) + '\n')
        setTimeout(() => client.destroy(), 10)
      }
    )
  } finally {
    process.removeListener('uncaughtException', onUncaught)
  }
  assert.deepStrictEqual(uncaught.map(e => e.code || e.message), [],
    'a dead client must never take the daemon down')
})

test('the socket error is REPORTED, not swallowed', async () => {
  // Silently ignoring it would fix the crash and hide a real signal: if every IPC
  // reply is failing, something upstream is wrong and the log is the only place
  // that can say so.
  //
  // The error is emitted directly rather than provoked by a hang-up. The first
  // version raced the OS — whether a write to a destroyed socket surfaces as an
  // 'error' event, a synchronous throw, or a silent discard is timing- and
  // platform-dependent, so the assertion passed or failed for reasons unrelated
  // to the code. Test 1 above covers the real hang-up behaviourally; this one
  // pins the contract: an error that DOES arrive must reach the reporter intact.
  const seen = await withServer(
    (msg, conn) => {
      setTimeout(() => {
        const err = new Error('write EPIPE')
        err.code = 'EPIPE'
        conn.emit('error', err)
      }, 40)
    },
    (client) => { client.write(JSON.stringify({ command: 'status' }) + '\n') }
  )
  assert.ok(seen.length > 0, 'the handler should have been told the write failed')
  assert.ok(seen.every(e => e && typeof e.code === 'string'),
    'a reported error should carry its errno code, not be reduced to a string')
  assert.strictEqual(seen[0].code, 'EPIPE')
})

test('a normal request/response round-trip still works', async () => {
  const sock = tmpSock()
  const reply = await new Promise((resolve, reject) => {
    const server = net.createServer((conn) =>
      wireIpcConnection(conn, (msg, c) => c.end(JSON.stringify({ status: 'ok', echo: msg.command }) + '\n')))
    server.listen(sock, () => {
      const client = net.createConnection(sock, () => client.write(JSON.stringify({ command: 'status' }) + '\n'))
      let buf = ''
      client.on('data', (d) => { buf += d.toString() })
      client.on('end', () => { server.close(); resolve(buf) })
      client.on('error', reject)
    })
  })
  assert.strictEqual(JSON.parse(reply).echo, 'status', 'the fix must not break the working path')
})

test('malformed JSON gets an error reply rather than a crash', async () => {
  const sock = tmpSock()
  const reply = await new Promise((resolve, reject) => {
    const server = net.createServer((conn) => wireIpcConnection(conn, () => {
      throw new Error('handler should not be called for invalid JSON')
    }))
    server.listen(sock, () => {
      const client = net.createConnection(sock, () => client.write('this is not json\n'))
      let buf = ''
      client.on('data', (d) => { buf += d.toString() })
      client.on('end', () => { server.close(); resolve(buf) })
      client.on('error', reject)
    })
  })
  assert.strictEqual(JSON.parse(reply).status, 'error')
})

test('a handler that throws does not take the process down', async () => {
  // handleIpcMessage reads files and touches daemon internals; any branch can throw.
  const uncaught = []
  const onUncaught = (e) => uncaught.push(e)
  process.on('uncaughtException', onUncaught)
  try {
    await withServer(
      () => { throw new Error('boom from inside a command branch') },
      (client) => { client.write(JSON.stringify({ command: 'status' }) + '\n') }
    )
  } finally {
    process.removeListener('uncaughtException', onUncaught)
  }
  assert.deepStrictEqual(uncaught.map(e => e.message), [])
})

// ─────────────────────────────────────────────────────────────────────────────
// The control.
//
// Everything above asserts the fixed wiring survives. That is worth nothing
// unless the harness can actually SEE the failure it claims to prevent — a
// detector that never fires passes just as happily against code that was never
// fixed. So: reproduce the ORIGINAL wiring verbatim and assert it breaks.
//
// If this test ever starts failing, the harness has stopped detecting the bug and
// every test above it became decorative.
// ─────────────────────────────────────────────────────────────────────────────

test('CONTROL: the original wiring really does emit an unhandled socket error', async () => {
  const sock = tmpSock()
  const unhandled = await new Promise((resolve) => {
    const seen = []
    const live = new Set()
    // Verbatim the pre-#185157 code: one 'data' listener, no 'error' listener.
    const server = net.createServer((conn) => {
      live.add(conn)
      conn.on('close', () => live.delete(conn))
      conn.on('data', () => {
        setTimeout(() => {
          const err = new Error('write EPIPE')
          err.code = 'EPIPE'
          // With no 'error' listener node throws this rather than delivering it.
          try { conn.emit('error', err) } catch (e) { seen.push(e) }
        }, 30)
      })
    })
    server.listen(sock, () => {
      const client = net.createConnection(sock, () => {
        client.write(JSON.stringify({ command: 'status' }) + '\n')
      })
      client.on('error', () => {})
      setTimeout(() => {
        for (const c of live) c.destroy()
        client.destroy()
        server.close(() => resolve(seen))
      }, 300)
    })
  })
  assert.strictEqual(unhandled.length, 1,
    'an EventEmitter with no error listener must throw — if this stops being true, ' +
    'the tests above are no longer testing anything')
  assert.strictEqual(unhandled[0].code, 'EPIPE')
})
