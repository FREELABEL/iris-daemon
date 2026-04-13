'use strict'

const http = require('http')
const crypto = require('crypto')

/**
 * Piece 4: Direct peer-to-peer task dispatch over HTTP.
 * Sends tasks to peer daemons and receives tasks from them.
 * Reuses the existing task executor — all 28+ task types work.
 */
class MeshDispatch {
  constructor ({ registry, auth, ownNodeName }) {
    this.registry = registry
    this.auth = auth
    this.ownNodeName = ownNodeName
    this._meshTasks = new Map() // taskId → { status, result, error }
  }

  /**
   * Dispatch a task to a specific peer by name.
   * Returns the task ID for status polling.
   */
  async dispatchToPeer (peerName, task) {
    const peer = this.registry.getPeer(peerName)
    if (!peer) throw new Error(`Unknown peer: ${peerName}`)
    if (peer.status !== 'online') throw new Error(`Peer ${peerName} is ${peer.status}`)

    const psk = this.auth.getPeerKey(peerName) || peer.psk
    if (!psk) throw new Error(`No shared key with peer ${peerName} — pair first`)

    const taskId = task.id || crypto.randomUUID()
    const payload = JSON.stringify({
      id: taskId,
      type: task.type || 'code_generation',
      title: task.title || `Mesh task from ${this.ownNodeName}`,
      prompt: task.prompt,
      config: task.config || {},
      origin_node: this.ownNodeName
    })

    const prefix = peer.prefix ?? ''
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: peer.host,
        port: peer.port,
        path: `${prefix}/mesh/task`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Mesh-Key': psk,
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 10000
      }, (res) => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          try {
            const result = JSON.parse(data)
            if (res.statusCode >= 400) {
              reject(new Error(result.error || `HTTP ${res.statusCode}`))
            } else {
              resolve({ taskId, ...result })
            }
          } catch {
            reject(new Error(`Invalid response from ${peerName}`))
          }
        })
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('Dispatch timeout')) })
      req.end(payload)
    })
  }

  /**
   * Dispatch to the peer with the best capacity (most idle).
   */
  async dispatchToBest (task) {
    const online = this.registry.getOnlinePeers()
    if (online.length === 0) throw new Error('No online peers')

    // Sort by capacity level: idle > light > busy
    const levelOrder = { idle: 0, light: 1, busy: 2, overloaded: 3, hibernating: 4 }
    const sorted = online
      .filter(p => p.psk || this.auth.getPeerKey(p.name))
      .sort((a, b) => {
        const la = levelOrder[a.capacity?.level] ?? 5
        const lb = levelOrder[b.capacity?.level] ?? 5
        return la - lb
      })

    if (sorted.length === 0) throw new Error('No paired online peers')
    return this.dispatchToPeer(sorted[0].name, task)
  }

  /**
   * Track a received mesh task's completion.
   */
  trackTask (taskId, status, result, error) {
    this._meshTasks.set(taskId, {
      status,
      result: result || null,
      error: error || null,
      updated_at: new Date().toISOString()
    })
    // Keep last 100
    if (this._meshTasks.size > 100) {
      const oldest = this._meshTasks.keys().next().value
      this._meshTasks.delete(oldest)
    }
  }

  getTaskStatus (taskId) {
    return this._meshTasks.get(taskId) || null
  }
}

module.exports = MeshDispatch
