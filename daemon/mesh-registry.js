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
    // Named peers whose /capacity is currently unreadable — so the warning is
    // emitted once per outage instead of once per 15s poll. Deliberately NOT on the
    // peer object: it must not be persisted into mesh-peers.json.
    this._capacityWarned = new Set()
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

  // Liveness is /health, and ONLY /health.
  //
  // This used to assign `peer.status = 'online'` and then request /capacity
  // inside the SAME try block. When /capacity failed — a 404 on a peer whose
  // prefix does not serve it, a timeout, non-JSON — the catch saw the 'online'
  // this very iteration had just written, read it as a down-transition, logged
  // "went offline", and marked a reachable peer offline. Every poll. Forever.
  //
  // Measured before the fix: 61,860 "went offline" lines in daemon.stdout.log,
  // 44,002 of them for one peer, at a 15s interval — not flapping, every single
  // poll for a week. And the cost was not the log: anything routing by
  // peer.status refused to dispatch to a node that was up and answering.
  //
  // Capacity is a SCHEDULING HINT. Failing to read it means we do not know how
  // busy the peer is; it does not mean the peer is gone.
  async _pollAll () {
    for (const peer of this.peers.values()) {
      const pfx = peer.prefix ?? ''
      const wasOnline = peer.status === 'online'

      try {
        const health = await this._httpGet(peer.host, peer.port, pfx + '/health')
        peer.status = 'online'
        peer.last_seen = new Date().toISOString()
        peer.node_id = health.node_id || peer.node_id
      } catch {
        // Compare against the status BEFORE this poll, so the transition is real.
        if (wasOnline) {
          console.log(`[mesh-registry] Peer ${peer.name} went offline`)
        }
        peer.status = 'offline'
        continue
      }

      try {
        peer.capacity = await this._httpGet(peer.host, peer.port, pfx + '/capacity')
        this._capacityWarned.delete(peer.name)
      } catch (err) {
        // Say it once per outage, not once per poll — and say what it does NOT mean.
        if (!this._capacityWarned.has(peer.name)) {
          console.warn(`[mesh-registry] Peer ${peer.name} is online but ${pfx}/capacity did not answer (${err.message}) — keeping last known capacity. This is a scheduling hint, NOT liveness; the peer stays online.`)
          this._capacityWarned.add(peer.name)
        }
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
