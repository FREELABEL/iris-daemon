'use strict'

const http = require('http')
const crypto = require('crypto')

const MAX_MESSAGES = 500

/**
 * Piece 5: Direct peer-to-peer chat over HTTP.
 * Ring buffer of messages, long-poll for real-time.
 */
class MeshChat {
  constructor ({ registry, auth, ownNodeName }) {
    this.registry = registry
    this.auth = auth
    this.ownNodeName = ownNodeName
    this._messages = [] // { id, from, to, text, timestamp }
    this._pollWaiters = [] // resolve functions for long-poll
  }

  /**
   * Send a message to a specific peer.
   */
  async sendMessage (peerName, text) {
    const peer = this.registry.getPeer(peerName)
    if (!peer) throw new Error(`Unknown peer: ${peerName}`)

    const psk = this.auth.getPeerKey(peerName) || peer.psk
    if (!psk) throw new Error(`No shared key with peer ${peerName}`)

    const msg = {
      id: crypto.randomUUID(),
      from: this.ownNodeName,
      to: peerName,
      text,
      timestamp: new Date().toISOString()
    }

    // Store locally
    this._addMessage(msg)

    // Send to peer
    const payload = JSON.stringify(msg)
    const prefix = peer.prefix ?? ''

    return new Promise((resolve, reject) => {
      const req = http.request({
        host: peer.host,
        port: peer.port,
        path: `${prefix}/mesh/chat`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Mesh-Key': psk,
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 5000
      }, (res) => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`Chat delivery failed: HTTP ${res.statusCode}`))
          } else {
            resolve(msg)
          }
        })
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('Chat send timeout')) })
      req.end(payload)
    })
  }

  /**
   * Receive a message from a peer (called by route handler).
   */
  receiveMessage (msg) {
    this._addMessage(msg)
    // Wake up any long-poll waiters
    for (const resolve of this._pollWaiters) {
      resolve(msg)
    }
    this._pollWaiters = []
  }

  /**
   * Get messages, optionally filtered by timestamp and peer.
   */
  getMessages ({ since, peer } = {}) {
    let msgs = this._messages
    if (since) {
      const sinceDate = new Date(since)
      msgs = msgs.filter(m => new Date(m.timestamp) > sinceDate)
    }
    if (peer) {
      msgs = msgs.filter(m => m.from === peer || m.to === peer)
    }
    return msgs
  }

  /**
   * Get conversation with a specific peer.
   */
  getConversation (peerName) {
    return this.getMessages({ peer: peerName })
  }

  /**
   * Long-poll: wait up to timeoutMs for a new message.
   */
  waitForMessage (timeoutMs = 30000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this._pollWaiters.indexOf(resolve)
        if (idx >= 0) this._pollWaiters.splice(idx, 1)
        resolve(null) // timeout — no new message
      }, timeoutMs)

      this._pollWaiters.push((msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
    })
  }

  _addMessage (msg) {
    this._messages.push(msg)
    if (this._messages.length > MAX_MESSAGES) {
      this._messages = this._messages.slice(-MAX_MESSAGES)
    }
  }
}

module.exports = MeshChat
