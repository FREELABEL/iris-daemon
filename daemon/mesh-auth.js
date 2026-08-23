'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')

// Paths are env-overridable so tests never touch the operator's real secrets on a live machine.
const KEYS_FILE = process.env.IRIS_MESH_KEYS_FILE || path.join(os.homedir(), '.iris', 'mesh-keys.json')
const BRIDGE_TOKEN_FILE = process.env.IRIS_BRIDGE_TOKEN_FILE || path.join(os.homedir(), '.iris', 'bridge-token')
const INVITE_TTL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Constant-time string equality. A plain `===` (or `Set.has`) on a secret leaks its length and
 * a prefix-match timing signal. Once the mesh listener is bound to a routable address (#182079)
 * these comparisons are reachable by anyone on the network, so they must not be a side channel.
 * Returns false on any length mismatch — timingSafeEqual throws on unequal-length buffers, so we
 * guard that first (the length itself is not the secret; a 32-byte hex PSK is always 64 chars).
 */
function safeEqual (a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/**
 * The local operator secret — the same `~/.iris/bridge-token` the bridge server's global
 * bridgeAuth uses. Read fresh each call so a rotated token takes effect without a restart.
 * Returns null if absent, in which case operator-gated routes fail closed (deny).
 */
function readBridgeToken () {
  try {
    if (fs.existsSync(BRIDGE_TOKEN_FILE)) {
      return fs.readFileSync(BRIDGE_TOKEN_FILE, 'utf-8').trim() || null
    }
  } catch { /* fall through to null — fail closed */ }
  return null
}

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
    if (typeof psk !== 'string' || psk === '') return false
    // Constant-time scan: compare against every authorized key rather than a Set.has() lookup,
    // so neither the outcome nor the timing reveals which key (or how much of one) matched.
    let ok = false
    for (const k of this._authorizedKeys) {
      if (safeEqual(psk, k)) ok = true
    }
    return ok
  }

  /**
   * PEER auth. Express middleware: checks X-Mesh-Key against authorized PSKs (constant-time).
   * Apply to every route a paired peer may call — dispatch, chat, energy, AND all reads. A read
   * that skips this leaks mesh state (chat history, topology, telemetry) to any reachable host
   * once the listener is bound routably (#182094).
   */
  middleware () {
    return (req, res, next) => {
      const key = req.headers['x-mesh-key']
      if (!this.isAuthorized(key)) {
        return res.status(403).json({ error: 'Unauthorized — invalid or missing mesh key' })
      }
      next()
    }
  }

  /**
   * OPERATOR auth. Express middleware: checks X-Bridge-Key against the local bridge token
   * (constant-time). Gates the credential factory and registry mutation — minting an invite,
   * adding or removing a peer. Only the machine's operator holds this token, so an invite can
   * only be created locally and its code handed to the joiner out-of-band. Without this,
   * /mesh/invite mints a valid PSK to anyone who can reach the port (#182092): the loopback bind
   * was the only thing making that safe, and the whole point of #182079 is to remove it.
   */
  operatorMiddleware () {
    return (req, res, next) => {
      const token = readBridgeToken()
      const key = req.headers['x-bridge-key']
      if (!token || !safeEqual(String(key || ''), token)) {
        return res.status(403).json({ error: 'Unauthorized — operator key required for mesh pairing/registry' })
      }
      next()
    }
  }

  load () {
    try {
      if (fs.existsSync(KEYS_FILE)) {
        // Repair permissions on a file an older build wrote at the default umask, on startup —
        // don't wait for the next pairing (which may never come) to tighten a leaked secret.
        try { fs.chmodSync(KEYS_FILE, 0o600) } catch { /* best effort */ }
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
      // 0600 — this file holds the authorized PSKs. A secret at the default umask is the same
      // class of hole as an open invite route. mode on writeFileSync only applies when CREATING
      // the file, so chmod after to repair a file written loosely by an older build.
      fs.writeFileSync(KEYS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 })
      try { fs.chmodSync(KEYS_FILE, 0o600) } catch { /* best effort on platforms without chmod */ }
    } catch (err) {
      console.warn('[mesh-auth] Failed to save keys:', err.message)
    }
  }
}

module.exports = MeshAuth
