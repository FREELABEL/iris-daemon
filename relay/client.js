'use strict'

/**
 * The node side of a Hive tunnel (#188585). Keeps ONE outbound TLS control connection to the relay;
 * for each visitor the relay announces, opens one more outbound TLS connection, terminates the
 * visitor's TLS HERE with this node's certificate, and pipes plaintext to the local target. Nothing
 * listens on this machine, so no port is opened and no router is touched.
 *
 * Reconnect (opt-in) uses capped backoff; an auth refusal (bad token, name in use) is final, because
 * retrying a refused credential is noise, not resilience.
 */

const net = require('net')
const tls = require('tls')
const { EventEmitter } = require('events')

const FINAL = /bad token|name in use/

function connectTunnel (opts) {
  const ev = new EventEmitter()
  let closed = false
  let control = null
  let firstSettled = false
  let backoff = 200
  const live = new Set()

  const relayConn = () => tls.connect({ host: opts.relay.host, port: opts.relay.port, servername: opts.relayHost, ca: opts.relayCa })

  const poolSize = opts.poolSize ?? 8
  let idleCount = 0

  /** A data connection: `id` answers a specific visitor; no id parks it in the relay's warm pool. */
  function openData (id) {
    const pooled = !id
    if (pooled) idleCount++
    let used = false
    const d = relayConn()
    live.add(d)
    d.on('close', () => {
      live.delete(d)
      if (pooled && !used) { idleCount--; if (!closed && control && !control.destroyed) setTimeout(fillPool, 200) }
    })
    d.on('error', () => d.destroy())
    d.on('secureConnect', () => {
      d.write(JSON.stringify(pooled ? { op: 'idle', name: opts.name, token: opts.token } : { op: 'data', id, name: opts.name, token: opts.token }) + '\n')
      // The rest of this stream is the visitor's own TLS — terminated here, never at the relay.
      const inner = new tls.TLSSocket(d, { isServer: true, cert: opts.cert, key: opts.key, ALPNProtocols: opts.alpn })
      inner.on('error', () => { inner.destroy(); d.destroy() })
      inner.on('secure', () => {
        // A pooled connection just got a visitor: replace it so the next burst finds it warm.
        if (pooled && !used) { used = true; idleCount--; fillPool() }
        const up = net.connect(opts.target.port, opts.target.host)
        up.on('error', () => { up.destroy(); inner.destroy() })
        inner.pipe(up).pipe(inner)
        up.on('close', () => inner.destroy())
        inner.on('close', () => up.destroy())
      })
    })
  }

  function fillPool () {
    while (!closed && control && !control.destroyed && idleCount < poolSize) openData(null)
  }

  return new Promise((resolve, reject) => {
    const settle = (err) => {
      if (firstSettled) return
      firstSettled = true
      if (err) reject(err); else resolve(api)
    }

    function connect () {
      if (closed) return
      const c = relayConn()
      control = c
      let buf = ''
      c.on('secureConnect', () => c.write(JSON.stringify({ op: 'hello', name: opts.name, token: opts.token }) + '\n'))
      c.on('data', (d) => {
        buf += d
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1)
          let m
          try { m = JSON.parse(line) } catch { continue }
          if (m.op === 'ok') { backoff = 200; ev.emit('ready', m.host); settle(); fillPool() }
          else if (m.op === 'err') {
            const e = new Error(m.error)
            if (FINAL.test(m.error)) closed = true
            // Emitting 'error' with no listener THROWS in Node — a refused token would crash the
            // process hosting the tunnel. The promise carries the first refusal; later ones are events.
            if (ev.listenerCount('error') > 0) ev.emit('error', e)
            settle(e)
          } else if (m.op === 'open' && m.id) openData(String(m.id))
          else if (m.op === 'ping') c.write(JSON.stringify({ op: 'pong' }) + '\n')
        }
      })
      c.on('error', (e) => { if (!firstSettled && !opts.reconnect) settle(e) })
      c.on('close', () => {
        ev.emit('down')
        if (!closed && opts.reconnect) { setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 5000) }
        else if (!firstSettled) settle(new Error('relay closed the control connection'))
      })
    }

    const api = Object.assign(ev, {
      close () {
        closed = true
        if (control) control.destroy()
        for (const d of live) d.destroy()
      }
    })
    connect()
  })
}

module.exports = { connectTunnel }
