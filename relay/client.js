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
const { Duplex } = require('stream')
const { readClientHello, MAX_HELLO } = require('./sni')

const FINAL = /bad token|name in use/

/**
 * `sock`, with `head` (bytes already read from it) delivered first. Not `sock.unshift(head)`:
 * TLS over a TLS socket stacks on its NATIVE handle and never sees bytes put back in the JS
 * buffer — measured, every visitor hung. A plain Duplex makes Node use the JS stream path.
 */
/** Node 18's TLS takes PEM/Buffer keys only — a KeyObject (what x509.newKey makes) is converted. */
const pemKey = (k) => (k && typeof k === 'object' && typeof k.export === 'function' && !Buffer.isBuffer(k) ? k.export({ type: 'pkcs8', format: 'pem' }) : k)

function replay (sock, head) {
  const dup = new Duplex({
    read () { sock.resume() },
    write (chunk, enc, cb) { sock.write(chunk, cb) },
    final (cb) { sock.end(); cb() },
    destroy (err, cb) { sock.destroy(); cb(err) }
  })
  dup.push(head)
  sock.on('data', (c) => { if (!dup.push(c)) sock.pause() })
  sock.on('end', () => dup.push(null))
  sock.on('close', () => dup.destroy())
  sock.on('error', () => dup.destroy())
  return dup
}

function connectTunnel (opts) {
  const ev = new EventEmitter()
  let closed = false
  let control = null
  let firstSettled = false
  let backoff = 200
  const live = new Set()

  // The certificate can change under a live tunnel (first issuance, renewal) — read it per visitor.
  let identity = opts.cert && opts.key ? { cert: opts.cert, key: opts.key } : null
  const challenges = new Map() // hostname -> { cert, key } while an ACME TLS-ALPN-01 check is pending
  let session = null // issued by the relay at registration; data connections prove membership with it

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
      d.write(JSON.stringify(pooled ? { op: 'idle', name: opts.name, session } : { op: 'data', id, name: opts.name, session }) + '\n')
      // The rest of this stream is the visitor's own TLS — terminated here, never at the relay.
      // Read its ClientHello first: an ACME validator (ALPN acme-tls/1) gets the challenge
      // certificate, everyone else gets this node's certificate.
      let buf = Buffer.alloc(0)
      const onHello = (chunk) => {
        buf = Buffer.concat([buf, chunk])
        const h = readClientHello(buf)
        if (h.status === 'need_more' && buf.length <= MAX_HELLO) return
        d.removeListener('data', onHello)
        d.pause()
        // A pooled connection just got a visitor: replace it so the next burst finds it warm.
        if (pooled && !used) { used = true; idleCount--; fillPool() }
        const acme = Array.isArray(h.alpn) && h.alpn.includes('acme-tls/1')
        const id = acme ? challenges.get(h.sni) : identity
        if (!id) return d.destroy() // no certificate yet, or a validator we are not expecting
        const inner = new tls.TLSSocket(replay(d, buf), { isServer: true, cert: id.cert, key: id.key, ALPNProtocols: acme ? ['acme-tls/1'] : opts.alpn })
        inner.on('error', () => { inner.destroy(); d.destroy() })
        if (acme) return inner.on('secure', () => inner.end()) // the handshake IS the answer
        inner.on('secure', () => {
          const up = net.connect(opts.target.port, opts.target.host)
          up.on('error', () => { up.destroy(); inner.destroy() })
          inner.pipe(up).pipe(inner)
          up.on('close', () => inner.destroy())
          inner.on('close', () => up.destroy())
        })
      }
      d.on('data', onHello)
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
      c.on('secureConnect', async () => {
        // getToken() lets a long-lived tunnel fetch a fresh token on every reconnect — tokens expire.
        let token = opts.token
        try { if (typeof opts.getToken === 'function') token = await opts.getToken() } catch (e) { token = null; ev.emit('warn', e) }
        c.write(JSON.stringify({ op: 'hello', name: opts.name, token }) + '\n')
      })
      c.on('data', (d) => {
        buf += d
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1)
          let m
          try { m = JSON.parse(line) } catch { continue }
          if (m.op === 'ok') { backoff = 200; session = m.session || null; ev.emit('ready', m.host); settle(); fillPool() }
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
      /** Swap the certificate visitors see — first issuance or renewal — without dropping anyone. */
      setCertificate (cert, key) { identity = cert && key ? { cert, key: pemKey(key) } : null },
      /** Serve (or with null, stop serving) an RFC 8737 challenge certificate for `host`. */
      setChallenge (host, c) { if (c) challenges.set(String(host).toLowerCase(), { cert: c.cert, key: pemKey(c.key) }); else challenges.delete(String(host).toLowerCase()) },
      hasCertificate () { return !!identity },
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
