'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')

const KEYS_FILE = path.join(os.homedir(), '.iris', 'mesh-keys.json')
const INVITE_TTL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Piece 3: Pre-shared key pairing and Express middleware.
 * Generates invite codes, exchanges PSKs, protects mesh routes.
 */
class MeshAuth {
  constructor () {
    this._pendingInvites = new Map() // code → { psk, expiresAt }
    this._authorizedKeys = new Set() // valid PSKs
    this._peerKeys = new Map() // peerName → psk
    this.load()
  }

  generateInvite () {
    // Clean expired invites
    const now = Date.now()
    for (const [code, inv] of this._pendingInvites) {
      if (inv.expiresAt < now) this._pendingInvites.delete(code)
    }

    // Generate human-readable 8-char code (XXXX-XXXX)
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no I/O/0/1 to avoid confusion
    let code = ''
    const bytes = crypto.randomBytes(8)
    for (let i = 0; i < 8; i++) {
      code += chars[bytes[i] % chars.length]
      if (i === 3) code += '-'
    }

    // Generate the PSK that will be shared once accepted
    const psk = crypto.randomBytes(32).toString('hex')
    const expiresAt = now + INVITE_TTL_MS

    this._pendingInvites.set(code, { psk, expiresAt })

    return { code, expiresAt: new Date(expiresAt).toISOString() }
  }

  acceptInvite (code, peerName) {
    const invite = this._pendingInvites.get(code)
    if (!invite) {
      throw new Error('Invalid or expired invite code')
    }
    if (invite.expiresAt < Date.now()) {
      this._pendingInvites.delete(code)
      throw new Error('Invite code has expired')
    }

    // Consume the invite
    this._pendingInvites.delete(code)

    // Store the PSK for this peer
    this._authorizedKeys.add(invite.psk)
    if (peerName) {
      this._peerKeys.set(peerName, invite.psk)
    }
    this.save()

    return { psk: invite.psk }
  }

  addAuthorizedKey (psk, peerName) {
    this._authorizedKeys.add(psk)
    if (peerName) this._peerKeys.set(peerName, psk)
    this.save()
  }

  getPeerKey (peerName) {
    return this._peerKeys.get(peerName) || null
  }

  getAuthorizedPeers () {
    return new Set(this._authorizedKeys)
  }

  isAuthorized (psk) {
    return this._authorizedKeys.has(psk)
  }

  /**
   * Express middleware: checks X-Mesh-Key header against authorized PSKs.
   * Apply to protected routes only.
   */
  middleware () {
    return (req, res, next) => {
      const key = req.headers['x-mesh-key']
      if (!key || !this._authorizedKeys.has(key)) {
        return res.status(403).json({ error: 'Unauthorized — invalid or missing mesh key' })
      }
      next()
    }
  }

  load () {
    try {
      if (fs.existsSync(KEYS_FILE)) {
        const data = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'))
        if (data.authorizedKeys) {
          for (const k of data.authorizedKeys) this._authorizedKeys.add(k)
        }
        if (data.peerKeys) {
          for (const [name, psk] of Object.entries(data.peerKeys)) {
            this._peerKeys.set(name, psk)
            this._authorizedKeys.add(psk)
          }
        }
      }
    } catch (err) {
      console.warn('[mesh-auth] Failed to load keys:', err.message)
    }
  }

  save () {
    try {
      const dir = path.dirname(KEYS_FILE)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

      const data = {
        authorizedKeys: [...this._authorizedKeys],
        peerKeys: Object.fromEntries(this._peerKeys)
      }
      fs.writeFileSync(KEYS_FILE, JSON.stringify(data, null, 2))
    } catch (err) {
      console.warn('[mesh-auth] Failed to save keys:', err.message)
    }
  }
}

module.exports = MeshAuth
