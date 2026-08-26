'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { ensureSocketFree, cleanupSocket } = require('../daemon/socket-guard')

/**
 * The stale unix socket that wedged a node for eight hours (#182371).
 *
 * daemon.js had:
 *
 *     function cleanupSocket () {
 *       try { fs.unlinkSync(SOCKET_PATH) } catch {}
 *     }
 *
 * SOCKET_PATH was never defined — the file defines SOCK_FILE. So every call threw a
 * ReferenceError that the bare `catch {}` swallowed, and the socket was NEVER removed. The
 * daemon then failed to bind on every subsequent start:
 *
 *     [ipc] Server error: listen EADDRINUSE ... /Users/…/.iris/daemon.sock
 *
 * It stayed "online" in the fleet view throughout, because each restart heartbeats once.
 *
 * The catch is what made it invisible: a cleanup that cannot be told apart from one that
 * runs. These tests assert the socket is actually GONE, not that a function was called.
 */

function tmpSock (name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sockguard-')), name)
}

test('a stale socket file with no listener is removed', async () => {
  const p = tmpSock('daemon.sock')
  fs.writeFileSync(p, '')            // a leftover file, nothing listening
  assert.ok(fs.existsSync(p))
  const r = await ensureSocketFree(p)
  assert.strictEqual(fs.existsSync(p), false, 'the stale file must be gone')
  assert.strictEqual(r.freed, true)
})

test('a LIVE socket is left alone — never unlink a running daemon out from under itself', async () => {
  const p = tmpSock('live.sock')
  const srv = net.createServer(() => {})
  await new Promise((res) => srv.listen(p, res))
  try {
    const r = await ensureSocketFree(p)
    assert.strictEqual(r.freed, false)
    assert.strictEqual(r.inUse, true, 'must report that something is listening')
    assert.ok(fs.existsSync(p), 'a live socket must survive')
  } finally {
    await new Promise((res) => srv.close(res))
    try { fs.unlinkSync(p) } catch {}
  }
})

test('a missing socket is not an error', async () => {
  const r = await ensureSocketFree(tmpSock('never-existed.sock'))
  assert.strictEqual(r.freed, false)
  assert.strictEqual(r.inUse, false)
})

test('cleanupSocket actually deletes, and REPORTS whether it did', () => {
  // The original returned nothing and swallowed everything, so "it ran" and "it worked"
  // were indistinguishable. The caller now gets an answer it can log or act on.
  const p = tmpSock('c.sock')
  fs.writeFileSync(p, '')
  assert.strictEqual(cleanupSocket(p), true)
  assert.strictEqual(fs.existsSync(p), false)
  assert.strictEqual(cleanupSocket(p), false, 'second call: nothing to remove')
})

test('cleanupSocket does not throw on an undefined path', () => {
  // The exact original defect: an undefined identifier reached unlinkSync. It must be
  // impossible for that to pass silently again.
  assert.doesNotThrow(() => cleanupSocket(undefined))
  assert.strictEqual(cleanupSocket(undefined), false)
})

test('daemon.js has no CODE reference to the undefined SOCKET_PATH', () => {
  // Comments may name it — the fix is documented in one. Strip line comments so the check
  // is about executable code, not prose about the bug.
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf-8')
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.strictEqual(/\bSOCKET_PATH\b/.test(code), false,
    'SOCKET_PATH is not defined in daemon.js; referencing it throws inside a swallowing catch')
})

test('the swallowing catch is gone — cleanupSocket delegates and returns', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf-8')
  assert.match(src, /return socketGuard\.cleanupSocket\(SOCK_FILE\)/)
  assert.match(src, /ensureSocketFree\(SOCK_FILE\)/, 'a stale socket must be cleared BEFORE binding')
})
