'use strict'

/**
 * Wire one IPC connection: parse, dispatch, and survive the client hanging up.
 *
 * The daemon crash-looped — 14 restarts in 15 minutes — on an unhandled EPIPE
 * (#185157). `net.createServer((conn) => { conn.on('data', ...) })` attached a
 * single listener, and `handleIpcMessage` replies with `conn.end(...)` from about
 * twenty branches. Any client that has already gone — Ctrl-C, a timeout, a
 * `| head` closing the pipe — turns one of those writes into an 'error' event on
 * a socket with no 'error' listener, which node promotes to an uncaught
 * exception. The process dies, launchd restarts it, the next caller repeats it.
 *
 * The node-level symptom was worse than the crash: a crash-looping daemon still
 * reports ONLINE and heartbeats, so work dispatched to it hangs to timeout rather
 * than failing fast. Losing a reply nobody is waiting for costs nothing; losing
 * the daemon costs every task queued behind it.
 *
 * Extracted from daemon.js so it can be tested against a real socket with a real
 * hang-up. The same logic inline was reachable only by crashing the daemon.
 */

/**
 * @param {import('net').Socket} conn
 * @param {(msg: object, conn: import('net').Socket) => void} onMessage
 * @param {(err: Error) => void} [onError] reporter — defaults to a console warning
 */
function wireIpcConnection (conn, onMessage, onError) {
  const report = typeof onError === 'function'
    ? onError
    // Report rather than swallow. If every IPC reply is failing, something
    // upstream is wrong and the log is the only place that can say so.
    : (err) => console.warn(`[ipc] reply not delivered (${err && err.code}): the client had already disconnected`)

  // THE FIX. Everything else here is the same behaviour it always had.
  conn.on('error', (err) => report(err))

  conn.on('data', (data) => {
    let msg
    try {
      msg = JSON.parse(data.toString().trim())
    } catch {
      safeEnd(conn, JSON.stringify({ status: 'error', message: 'Invalid JSON' }) + '\n', report)
      return
    }
    try {
      onMessage(msg, conn)
    } catch (err) {
      // A command branch throwing must not be fatal either. These branches read
      // files and reach into daemon internals; any of them can fail.
      report(err)
      safeEnd(conn, JSON.stringify({ status: 'error', message: err && err.message }) + '\n', report)
    }
  })
}

/** end() without caring whether the peer is still there. */
function safeEnd (conn, payload, report) {
  try {
    if (conn.destroyed || conn.writableEnded) return
    conn.end(payload)
  } catch (err) {
    report(err)
  }
}

module.exports = { wireIpcConnection, safeEnd }
