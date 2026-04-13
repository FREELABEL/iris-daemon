'use strict'

const fs = require('fs')
const path = require('path')
const http = require('http')
const os = require('os')

const PEERS_FILE = path.join(os.homedir(), '.iris', 'mesh-peers.json')

/**
 * Piece 2: Authoritative peer registry with health polling.
 * Tracks mDNS-discovered and manually-added peers.
 * Polls each peer's /health and /capacity endpoints.
 */
class MeshRegistry {
  constructor ({ ownNodeName }) {
    this.ownNodeName = ownNodeName
    this.peers = new Map() // name → peer record
    this._healthInterval = null
    this.load()
  }

  addPeer (name, host, port, via = 'mdns') {
    if (name === this.ownNodeName) return

    const existing = this.peers.get(name)
    const peer = {
      name,
      host,
      port,
      prefix: existing?.prefix ?? (port === 3200 ? '' : '/daemon'),
      psk: existing?.psk || null,
      status: existing?.status || 'unknown',
      capacity: existing?.capacity || {},
      node_id: existing?.node_id || null,
      last_seen: new Date().toISOString(),
      added_via: existing?.added_via || via
    }
    this.peers.set(name, peer)
    this.save()
    return peer
  }

  removePeer (name) {
    const existed = this.peers.delete(name)
    if (existed) this.save()
    return existed
  }

  getPeer (name) {
    return this.peers.get(name) || null
  }

  getAllPeers () {
    return [...this.peers.values()]
  }

  getOnlinePeers () {
    return this.getAllPeers().filter(p => p.status === 'online')
  }

  setPeerKey (name, psk) {
    const peer = this.peers.get(name)
    if (peer) {
      peer.psk = psk
      this.save()
    }
  }

  updatePeerStatus (name, status) {
    const peer = this.peers.get(name)
    if (peer) {
      peer.status = status
      if (status === 'online') peer.last_seen = new Date().toISOString()
    }
  }

  startHealthChecks (intervalMs = 15000) {
    this.stopHealthChecks()
    this._healthInterval = setInterval(() => this._pollAll(), intervalMs)
    // Do first poll immediately
    this._pollAll()
  }

  stopHealthChecks () {
    if (this._healthInterval) {
      clearInterval(this._healthInterval)
      this._healthInterval = null
    }
  }

  async _pollAll () {
    for (const peer of this.peers.values()) {
      try {
        const pfx = peer.prefix ?? ''
        const health = await this._httpGet(peer.host, peer.port, pfx + '/health')
        peer.status = 'online'
        peer.last_seen = new Date().toISOString()
        peer.node_id = health.node_id || peer.node_id

        const capacity = await this._httpGet(peer.host, peer.port, pfx + '/capacity')
        peer.capacity = capacity
      } catch {
        if (peer.status === 'online') {
          console.log(`[mesh-registry] Peer ${peer.name} went offline`)
        }
        peer.status = 'offline'
      }
    }
  }

  _httpGet (host, port, urlPath) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host, port, path: urlPath, timeout: 5000 }, (res) => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch {
            reject(new Error('Invalid JSON'))
          }
        })
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
    })
  }

  load () {
    try {
      if (fs.existsSync(PEERS_FILE)) {
        const data = JSON.parse(fs.readFileSync(PEERS_FILE, 'utf-8'))
        for (const p of data) {
          // Mark all persisted peers as unknown until health check confirms
          p.status = 'unknown'
          this.peers.set(p.name, p)
        }
      }
    } catch (err) {
      console.warn('[mesh-registry] Failed to load peers:', err.message)
    }
  }

  save () {
    try {
      const dir = path.dirname(PEERS_FILE)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(PEERS_FILE, JSON.stringify(this.getAllPeers(), null, 2))
    } catch (err) {
      console.warn('[mesh-registry] Failed to save peers:', err.message)
    }
  }
}

module.exports = MeshRegistry
