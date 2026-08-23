'use strict'

const EventEmitter = require('events')
const os = require('os')

/**
 * The address the a2a/bridge HTTP server binds to.
 *
 * ONE definition, used by both the bind (daemon/index.js) and the advert below, so the two
 * can never disagree about where this node can be reached. Three copies of MAX_CONCURRENT
 * disagreeing is exactly how #182091 happened; this is the same mistake waiting to be made
 * about reachability, and it is cheaper to not make it.
 */
function bridgeBindHost () {
  return process.env.BRIDGE_BIND_HOST || '127.0.0.1'
}

/**
 * Is the bridge bound somewhere only this machine can reach?
 *
 * A node bound to loopback cannot be dialled by anyone, so it must not advertise itself as
 * dialable (#182090). Exported so the rule is tested rather than assumed.
 */
function isLoopbackBind (host = bridgeBindHost()) {
  const h = String(host || '').trim().toLowerCase()
  // FAIL CLOSED on an unknown bind. An empty or missing host means we do not know where the
  // server is listening, and "we do not know" must never be treated as "reachable" — that is
  // the direction of this whole bug. The cost of staying silent is a quiet mesh; the cost of
  // advertising wrongly is every peer chasing an address that will not answer.
  if (h === '') return true
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]' || h.startsWith('127.')
}

/**
 * Piece 1: mDNS service advertisement and discovery.
 * Publishes this node as `_iris-hive._tcp` and listens for peers.
 * Emits 'peer-up' and 'peer-down' events.
 */
class MeshDiscovery extends EventEmitter {
  constructor ({ nodeName, port = 3200, nodeId = null, bindHost = null }) {
    super()
    this.nodeName = nodeName || os.hostname()
    this.port = port
    // Where the server this advert points AT is actually listening.
    this.bindHost = bindHost || bridgeBindHost()
    this.nodeId = nodeId
    this.peers = new Map() // name → { name, host, port, ip, lastSeen }
    this.bonjour = null
    this.browser = null
    this.service = null
    this._running = false
  }

  start () {
    if (this._running) return

    let Bonjour
    try {
      Bonjour = require('bonjour-service')
    } catch {
      console.warn('[mesh-discovery] bonjour-service not installed — mDNS disabled. Run: npm i bonjour-service')
      return
    }

    this.bonjour = new Bonjour.default()
    this._running = true

    // ── Advertise this node — but ONLY if it can actually be reached ────────────
    //
    // The advert names `this.port` as the way to reach this node. When the bridge is bound
    // to loopback, that is a claim no peer can act on: it will discover the record, dial it,
    // and fail — and then has to work out whether the peer is down, the network is wrong,
    // its credentials are wrong, or the advert was simply never true. Only the last is the
    // case, and nothing in the failure says so.
    //
    // An unreachable peer list is strictly worse than no peer list, so we browse (which is
    // honest and still useful) and stay silent about ourselves. #182090.
    //
    // NOTE FOR WHOEVER LIFTS THIS: do not "fix" it by defaulting BRIDGE_BIND_HOST to
    // 0.0.0.0. That listener has NO authentication — the only middleware on it is
    // express.json() — so binding it wider puts an unauthenticated JSON-RPC surface that
    // dispatches work onto every network this machine joins. Authenticate it first, then
    // bind the TAILNET address specifically, then advertise.
    if (isLoopbackBind(this.bindHost)) {
      console.log(
        `[mesh-discovery] NOT advertising: the bridge is bound to ${this.bindHost}, so no peer could reach port ${this.port}. ` +
        'Browsing for peers only. Set BRIDGE_BIND_HOST to a reachable address once the a2a surface is authenticated (#182090).'
      )
    } else {
    try {
      this.service = this.bonjour.publish({
        name: this.nodeName,
        type: 'iris-hive',
        port: this.port,
        txt: {
          node_id: this.nodeId || '',
          version: '1'
        }
      })

      // Handle the "name already in use" error that fires asynchronously
      if (this.service) {
        this.service.on('error', (err) => {
          if (err && /already in use/i.test(err.message || String(err))) {
            console.log(`[mesh-discovery] Service name "${this.nodeName}" already advertised on network — skipping`)
          } else {
            console.error('[mesh-discovery] Service error:', err)
          }
        })
      }
    } catch (err) {
      if (/already in use/i.test(err.message || String(err))) {
        console.log(`[mesh-discovery] Service name "${this.nodeName}" already advertised on network — skipping`)
      } else {
        throw err
      }
    }
    console.log(`[mesh-discovery] Advertising as "${this.nodeName}" at ${this.bindHost}:${this.port}`)
    }

    // Browse for peers
    this.browser = this.bonjour.find({ type: 'iris-hive' })

    this.browser.on('up', (service) => {
      // Skip self
      if (service.name === this.nodeName) return

      const peer = {
        name: service.name,
        host: service.host,
        port: service.port,
        ip: this._extractIp(service),
        node_id: service.txt?.node_id || null,
        lastSeen: new Date().toISOString()
      }

      const isNew = !this.peers.has(service.name)
      this.peers.set(service.name, peer)

      if (isNew) {
        console.log(`[mesh-discovery] Peer up: ${peer.name} @ ${peer.ip || peer.host}:${peer.port}`)
        this.emit('peer-up', peer)
      }
    })

    this.browser.on('down', (service) => {
      if (service.name === this.nodeName) return

      const peer = this.peers.get(service.name)
      if (peer) {
        this.peers.delete(service.name)
        console.log(`[mesh-discovery] Peer down: ${service.name}`)
        this.emit('peer-down', peer)
      }
    })
  }

  stop () {
    if (!this._running) return
    this._running = false

    if (this.service) {
      this.bonjour.unpublishAll()
      this.service = null
    }
    if (this.browser) {
      this.browser.stop()
      this.browser = null
    }
    if (this.bonjour) {
      this.bonjour.destroy()
      this.bonjour = null
    }

    console.log('[mesh-discovery] Stopped')
  }

  getPeers () {
    return new Map(this.peers)
  }

  _extractIp (service) {
    // Prefer IPv4
    if (service.addresses) {
      const ipv4 = service.addresses.find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a))
      if (ipv4) return ipv4
      return service.addresses[0] || null
    }
    return service.host || null
  }
}

module.exports = MeshDiscovery
module.exports.bridgeBindHost = bridgeBindHost
module.exports.isLoopbackBind = isLoopbackBind
