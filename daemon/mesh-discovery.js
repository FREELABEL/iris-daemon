'use strict'

const EventEmitter = require('events')
const os = require('os')

/**
 * Piece 1: mDNS service advertisement and discovery.
 * Publishes this node as `_iris-hive._tcp` and listens for peers.
 * Emits 'peer-up' and 'peer-down' events.
 */
class MeshDiscovery extends EventEmitter {
  constructor ({ nodeName, port = 3200, nodeId = null }) {
    super()
    this.nodeName = nodeName || os.hostname()
    this.port = port
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

    // Advertise this node
    this.service = this.bonjour.publish({
      name: this.nodeName,
      type: 'iris-hive',
      port: this.port,
      txt: {
        node_id: this.nodeId || '',
        version: '1'
      }
    })
    console.log(`[mesh-discovery] Advertising as "${this.nodeName}" on port ${this.port}`)

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
