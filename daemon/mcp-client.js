'use strict'

/**
 * Speak MCP to a local server over stdio: initialize -> tools/list | tools/call.
 *
 * Written rather than pulled in as @modelcontextprotocol/sdk on purpose. The daemon ships to
 * every node and its dependency tree is a liability there; this is one protocol handshake and
 * three methods, and the SDK's own transport does nothing more for this use.
 *
 * EVERY PATH IS BOUNDED. A stdio server that never answers must not wedge a task forever —
 * that is the shape of the 26-hour daemon wedge this codebase already paid for. There is a
 * timeout on the handshake, a timeout on the call, a cap on captured output, and the child is
 * killed in a `finally` whatever happens.
 */

const { spawn } = require('child_process')

const DEFAULT_TIMEOUT_MS = 120000
const HANDSHAKE_TIMEOUT_MS = 45000
/** Enough for a large tools/list; past this the server is misbehaving and we stop reading. */
const MAX_BUFFER_BYTES = 8 * 1024 * 1024
const PROTOCOL_VERSION = '2024-11-05'

/**
 * @param {{command:string,args?:string[],env?:object}} server
 * @param {{method:string, params?:object, timeoutMs?:number, cwd?:string}} req
 * @returns {Promise<{ok:boolean, result?:any, error?:string, stderr?:string}>}
 */
function callMcp (server, req) {
  return new Promise((resolve) => {
    const timeoutMs = Math.max(1000, req.timeoutMs || DEFAULT_TIMEOUT_MS)
    let child
    try {
      child = spawn(server.command, server.args || [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: req.cwd || process.cwd(),
        env: { ...process.env, ...(server.env || {}) }
      })
    } catch (e) {
      return resolve({ ok: false, error: `could not start MCP server: ${e.message}` })
    }

    let out = ''
    let err = ''
    let settled = false
    let overflowed = false

    const finish = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(handshakeTimer)
      clearTimeout(callTimer)
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      resolve({ ...payload, stderr: err.slice(-2000) || undefined })
    }

    const send = (obj) => {
      try { child.stdin.write(JSON.stringify(obj) + '\n') } catch { /* server died; timers cover it */ }
    }

    const handshakeTimer = setTimeout(
      () => finish({ ok: false, error: `MCP server did not complete initialize within ${HANDSHAKE_TIMEOUT_MS}ms` }),
      HANDSHAKE_TIMEOUT_MS
    )
    const callTimer = setTimeout(
      () => finish({ ok: false, error: `MCP call '${req.method}' exceeded ${timeoutMs}ms` }),
      timeoutMs
    )

    child.stdout.on('data', (chunk) => {
      if (overflowed) return
      out += chunk.toString()
      if (out.length > MAX_BUFFER_BYTES) {
        overflowed = true
        return finish({ ok: false, error: `MCP server returned more than ${MAX_BUFFER_BYTES} bytes` })
      }
      let i
      while ((i = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, i)
        out = out.slice(i + 1)
        if (!line.trim()) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue } // servers log non-JSON to stdout; skip it
        if (msg.id === 1) {
          clearTimeout(handshakeTimer)
          if (msg.error) return finish({ ok: false, error: `initialize failed: ${JSON.stringify(msg.error).slice(0, 300)}` })
          send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          send({ jsonrpc: '2.0', id: 2, method: req.method, params: req.params || {} })
        } else if (msg.id === 2) {
          if (msg.error) return finish({ ok: false, error: `${req.method} failed: ${JSON.stringify(msg.error).slice(0, 500)}` })
          return finish({ ok: true, result: msg.result })
        }
      }
    })

    child.stderr.on('data', (c) => { err = (err + c.toString()).slice(-8000) })

    child.on('error', (e) => finish({ ok: false, error: `MCP server could not be launched: ${e.message}` }))
    child.on('exit', (code) => {
      // Only meaningful if we never got an answer; a normal finish kills the child itself.
      finish({ ok: false, error: `MCP server exited (code ${code}) before answering ${req.method}` })
    })

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'iris-hive-node', version: '1' }
      }
    })
  })
}

const listTools = (server, opts = {}) => callMcp(server, { method: 'tools/list', timeoutMs: opts.timeoutMs, cwd: opts.cwd })

const callTool = (server, tool, args, opts = {}) =>
  callMcp(server, { method: 'tools/call', params: { name: tool, arguments: args || {} }, timeoutMs: opts.timeoutMs, cwd: opts.cwd })

module.exports = { callMcp, listTools, callTool, DEFAULT_TIMEOUT_MS, HANDSHAKE_TIMEOUT_MS, MAX_BUFFER_BYTES }
