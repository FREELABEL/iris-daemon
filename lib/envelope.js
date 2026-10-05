'use strict'

/**
 * envelope.js — the daemon's ihw.v1 primitives (#177946 phase 3), shared.
 *
 * WHY THIS FILE: the inbox (task-executor.js) only ever UNWRAPPED a DEK. Encrypted Hive vaults
 * (lib/encrypted-vault.js) must WRAP their vault DEK to platform escrow when the tenant's escrow
 * policy says so (fl-iris-api EscrowPolicy::resolve). That is the same frozen construction —
 * DHKEM(X25519) + HKDF-SHA256 + AES-256-GCM, AAD-bound to (transfer id, target id) — so it lives
 * in ONE place here rather than a fourth hand-copied implementation. A vault's id plays the role
 * of the transfer id, so a vault's escrow wrap cannot be replayed onto another vault or transfer.
 *
 * FROZEN FORMAT: bytes produced here are opened by PHP's EnvelopeCrypto::unwrapDek(). Pinned by
 * tests/envelope-vector.test.js (PHP-produced vector) — never edit the binding to pass a test.
 */

const crypto = require('crypto')

const ENVELOPE_VERSION = 'ihw.v1'
const RS = '\x1e'
const US = '\x1f'
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')

/**
 * The frozen ihw.v1 binding. LENGTH-PREFIXED, not joined. BYTE length, not string length: PHP's
 * strlen() counts bytes, JS .length counts UTF-16 units — a mismatch derives a different key for
 * any non-ASCII id and surfaces only as "this file will not open".
 */
function envelopeBind (purpose, fields) {
  const parts = [ENVELOPE_VERSION, purpose]
  for (const value of fields) parts.push(`${Buffer.byteLength(value, 'utf8')}${US}${value}`)
  return parts.join(RS)
}

function x25519Public (raw) {
  return crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
}

function x25519Private (raw) {
  return crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' })
}

function wrapKeyFor (shared, ephPublic, recipientPublic, transferId, targetId) {
  const info = envelopeBind('wrap', [ephPublic.toString('hex'), recipientPublic.toString('hex'), transferId, targetId])
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from(info, 'utf8'), 32))
}

/**
 * Wrap a 32-byte DEK to one X25519 public key. Fresh ephemeral keypair per call (two wraps of the
 * same DEK share no key material), mirroring EnvelopeCrypto::wrapDek().
 * @returns {{eph_public:Buffer, nonce:Buffer, ciphertext:Buffer, tag:Buffer}}
 */
function wrapDek (dek, recipientPublic, transferId, targetId) {
  if (!Buffer.isBuffer(dek) || dek.length !== 32) throw new Error('DEK must be exactly 32 bytes')
  if (!Buffer.isBuffer(recipientPublic) || recipientPublic.length !== 32) throw new Error('recipient public key must be 32 bytes')
  const eph = crypto.generateKeyPairSync('x25519')
  const ephPublic = eph.publicKey.export({ format: 'der', type: 'spki' }).subarray(X25519_SPKI_PREFIX.length)
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: x25519Public(recipientPublic) })
  const wrapKey = wrapKeyFor(shared, ephPublic, recipientPublic, transferId, targetId)
  const nonce = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', wrapKey, nonce, { authTagLength: 16 })
  c.setAAD(Buffer.from(envelopeBind('wrap', [transferId, targetId]), 'utf8'))
  const ciphertext = Buffer.concat([c.update(dek), c.final()])
  shared.fill(0); wrapKey.fill(0)
  return { eph_public: ephPublic, nonce, ciphertext, tag: c.getAuthTag() }
}

/** Unwrap a DEK (and optionally open content) — pinned against PHP in envelope-vector.test.js. */
function openEnvelopeBuffers ({ ephPublic, wrapNonce, wrappedDek, wrapTag, recipientSecret, recipientPublic, envelopeId, targetId, contentNonce, contentTag, sealed }) {
  const shared = crypto.diffieHellman({ privateKey: x25519Private(recipientSecret), publicKey: x25519Public(ephPublic) })
  const wrapKey = wrapKeyFor(shared, ephPublic, recipientPublic, envelopeId, targetId)

  const wd = crypto.createDecipheriv('aes-256-gcm', wrapKey, wrapNonce, { authTagLength: 16 })
  wd.setAAD(Buffer.from(envelopeBind('wrap', [envelopeId, targetId]), 'utf8'))
  wd.setAuthTag(wrapTag)
  const dek = Buffer.concat([wd.update(wrappedDek), wd.final()])

  if (!sealed) return { dek, plaintext: null }

  const cd = crypto.createDecipheriv('aes-256-gcm', dek, contentNonce, { authTagLength: 16 })
  cd.setAAD(Buffer.from(envelopeBind('content', [envelopeId]), 'utf8'))
  cd.setAuthTag(contentTag)

  return { dek, plaintext: Buffer.concat([cd.update(sealed), cd.final()]) }
}

module.exports = { ENVELOPE_VERSION, envelopeBind, wrapDek, openEnvelopeBuffers, x25519Public, x25519Private, X25519_SPKI_PREFIX, X25519_PKCS8_PREFIX }
