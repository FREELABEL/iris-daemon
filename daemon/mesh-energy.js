'use strict'

const http = require('http')

const MAX_ALERTS = 50

/**
 * Piece 6: Battery/energy alerts to mesh peers.
 * Listens to resource-monitor capacity changes, notifies peers
 * when this node is hibernating or overloaded.
 */
class MeshEnergy {
  constructor ({ registry, auth, resourceMonitor, ownNodeName }) {
    this.registry = registry
    this.auth = auth
    this.resourceMonitor = resourceMonitor
    this.ownNodeName = ownNodeName
    this._alerts = [] // received alerts from peers
    this._listener = null
    this._lastBroadcastLevel = null
  }

  start () {
    if (this._listener) return

    this._listener = ({ level, previous, capacity }) => {
      // Only broadcast on meaningful transitions
      const critical = ['hibernating', 'overloaded']
      const wasCritical = critical.includes(previous)
      const isCritical = critical.includes(level)

      if (isCritical && !wasCritical) {
        this._broadcastAlert(level, capacity)
      } else if (!isCritical && wasCritical) {
        // Recovered — notify peers
        this._broadcastAlert(level, capacity)
      }
      this._lastBroadcastLevel = level
    }

    this.resourceMonitor.on('capacity-changed', this._listener)
    console.log('[mesh-energy] Monitoring capacity for peer alerts')
  }

  stop () {
    if (this._listener && this.resourceMonitor) {
      this.resourceMonitor.removeListener('capacity-changed', this._listener)
      this._listener = null
    }
  }

  /**
   * Receive an energy alert from a peer (called by route handler).
   */
  receiveAlert (alert) {
    this._alerts.push({
      ...alert,
      received_at: new Date().toISOString()
    })
    if (this._alerts.length > MAX_ALERTS) {
      this._alerts = this._alerts.slice(-MAX_ALERTS)
    }

    console.log(`[mesh-energy] Alert from ${alert.node}: ${alert.level} (battery: ${alert.battery_pct ?? 'N/A'}%)`)
  }

  getAlerts () {
    return this._alerts
  }

  async _broadcastAlert (level, capacity) {
    const alert = {
      node: this.ownNodeName,
      level,
      battery_pct: capacity.battery_pct,
      cpu_pct: capacity.cpu_pct,
      timestamp: new Date().toISOString()
    }

    const peers = this.registry.getOnlinePeers()
    for (const peer of peers) {
      const psk = this.auth.getPeerKey(peer.name) || peer.psk
      if (!psk) continue

      const payload = JSON.stringify(alert)
      const prefix = peer.prefix ?? ''

      try {
        await new Promise((resolve, reject) => {
          const req = http.request({
            host: peer.host,
            port: peer.port,
            path: `${prefix}/mesh/energy`,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Mesh-Key': psk,
              'Content-Length': Buffer.byteLength(payload)
            },
            timeout: 3000
          }, (res) => {
            res.resume()
            resolve()
          })
          req.on('error', reject)
          req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
          req.end(payload)
        })
      } catch {
        // Best effort — don't fail if a peer is unreachable
      }
    }

    console.log(`[mesh-energy] Broadcast ${level} alert to ${peers.length} peers`)
  }
}

module.exports = MeshEnergy
