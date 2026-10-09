'use strict'

/**
 * Just enough DER to get a certificate through a relay that must not hold it (#188585).
 *
 * Two artefacts, both P-256 / ECDSA-SHA256, both built here because Node can read X.509 but not
 * write it, and shelling out to openssl means a different openssl (LibreSSL on macOS) per machine:
 *
 *   csr(key, name)                          the PKCS#10 request ACME's finalize step takes
 *   alpnChallengeCert(key, name, keyAuth)   the self-signed certificate RFC 8737 (TLS-ALPN-01)
 *                                           asks the validator to see: SAN = name, and a CRITICAL
 *                                           acmeIdentifier extension holding sha256(keyAuth)
 *
 * Every output is checked against openssl in tests/relay-acme.test.js — a hand-rolled encoder
 * that only round-trips through itself proves nothing.
 */

const crypto = require('crypto')

const len = (n) => {
  if (n < 0x80) return Buffer.from([n])
  const b = []
  while (n > 0) { b.unshift(n & 0xff); n >>= 8 }
  return Buffer.from([0x80 | b.length, ...b])
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body])
const seq = (...xs) => tlv(0x30, Buffer.concat(xs))
const set = (...xs) => tlv(0x31, Buffer.concat(xs))
const octet = (b) => tlv(0x04, b)
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]))
const utf8 = (s) => tlv(0x0c, Buffer.from(String(s), 'utf8'))
const bits = (b) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]))
const explicit = (n, body) => tlv(0xa0 + n, body)

function int (v) {
  let b = Buffer.isBuffer(v) ? Buffer.from(v) : Buffer.from([v])
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1)
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b])
  return tlv(0x02, b)
}

function oid (dotted) {
  const p = dotted.split('.').map(Number)
  const out = [40 * p[0] + p[1]]
  for (const n of p.slice(2)) {
    const enc = [n & 0x7f]
    let v = Math.floor(n / 128)
    while (v > 0) { enc.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128) }
    out.push(...enc)
  }
  return tlv(0x06, Buffer.from(out))
}

function utcTime (d) {
  const s = d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z' // YYMMDDHHMMSSZ
  return tlv(0x17, Buffer.from(s, 'latin1'))
}

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'))
const nameCN = (cn) => seq(set(seq(oid('2.5.4.3'), utf8(cn))))
const san = (dns) => seq(oid('2.5.29.17'), octet(seq(...[].concat(dns).map((d) => tlv(0x82, Buffer.from(d, 'latin1'))))))
const spki = (key) => crypto.createPublicKey(key).export({ type: 'spki', format: 'der' })
const sign = (key, tbs) => crypto.sign('sha256', tbs, { key, dsaEncoding: 'der' })

function newKey () {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
}

function toPem (der, label) {
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n')
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`
}

/** PKCS#10 CSR for one name or several (all in the SAN; the first is the CN), as DER. */
function csr (key, names) {
  const list = [].concat(names)
  const extReq = seq(oid('1.2.840.113549.1.9.14'), set(seq(san(list))))
  const info = seq(int(0), nameCN(list[0]), spki(key), tlv(0xa0, extReq))
  return seq(info, ECDSA_SHA256, bits(sign(key, info)))
}

/** RFC 8737 challenge certificate, PEM. Valid for a day — validators connect within minutes. */
function alpnChallengeCert (key, name, keyAuthorization) {
  const digest = crypto.createHash('sha256').update(keyAuthorization).digest()
  const acmeId = seq(oid('1.3.6.1.5.5.7.1.31'), bool(true), octet(octet(digest)))
  const now = Date.now()
  const tbs = seq(
    explicit(0, int(2)),
    int(crypto.randomBytes(16)),
    ECDSA_SHA256,
    nameCN(name),
    seq(utcTime(new Date(now - 3600e3)), utcTime(new Date(now + 86400e3))),
    nameCN(name),
    spki(key),
    explicit(3, seq(san(name), acmeId))
  )
  return toPem(seq(tbs, ECDSA_SHA256, bits(sign(key, tbs))), 'CERTIFICATE')
}

module.exports = { csr, alpnChallengeCert, newKey, toPem }
