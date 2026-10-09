'use strict'

const test = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const x509 = require('../relay/x509')
const { obtainCertificate, thumbprint, jwkOf } = require('../relay/acme')

/**
 * Certificates for Hive tunnels, issued to the node through a relay that never holds them (#188585).
 * The DER here is hand-written, so every artefact is checked by openssl — not by re-reading it
 * with the code that wrote it.
 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'acme-test-'))
const { spawnSync } = require('child_process')
// stdout AND stderr: OpenSSL 3.0 prints "verify failure" and still exits 0 (measured), so the
// verdict has to be read from the text — an exit-code check passes a corrupted CSR.
const openssl = (args, input) => { const r = spawnSync('openssl', args, { input, encoding: 'utf8' }); return r.stdout + r.stderr }

test('CSR: openssl verifies its signature and reads the hostname as CN and SAN', () => {
  const key = x509.newKey()
  const pem = x509.toPem(x509.csr(key, 'demo.t.heyiris.io'), 'CERTIFICATE REQUEST')
  const out = openssl(['req', '-verify', '-noout', '-text'], pem)
  assert.match(out, /verify OK/)
  assert.match(out, /CN\s*=\s*demo\.t\.heyiris\.io/)
  assert.match(out, /DNS:demo\.t\.heyiris\.io/)
  assert.match(out, /prime256v1|P-256/)
})

test('CSR: a different key cannot have signed it (verification is real)', () => {
  const der = x509.csr(x509.newKey(), 'demo.t.heyiris.io')
  der[der.length - 5] ^= 0xff // flip a signature byte
  const out = openssl(['req', '-verify', '-noout'], x509.toPem(der, 'CERTIFICATE REQUEST'))
  assert.doesNotMatch(out, /verify OK/)
  assert.match(out, /verify failure|unable to load|error/i)
})

test('challenge certificate: SAN = the name, acmeIdentifier is CRITICAL and holds sha256(keyAuthorization)', () => {
  const key = x509.newKey()
  const pem = x509.alpnChallengeCert(key, 'demo.t.heyiris.io', 'TOKEN.THUMB')
  const out = openssl(['x509', '-noout', '-text'], pem)
  assert.match(out, /DNS:demo\.t\.heyiris\.io/)
  assert.match(out, /1\.3\.6\.1\.5\.5\.7\.1\.31: critical/)
  const c = new crypto.X509Certificate(pem)
  assert.ok(c.verify(crypto.createPublicKey(key)), 'self-signed by the node key')
  assert.ok(c.raw.includes(crypto.createHash('sha256').update('TOKEN.THUMB').digest()))
  assert.ok(new Date(c.validTo) > new Date(), 'currently valid')
  // The extension value is an OCTET STRING wrapping a 32-byte OCTET STRING (RFC 8737 §3)
  const hex = c.raw.toString('hex')
  const at = hex.indexOf('2b0601050507011f')
  assert.ok(at > 0)
  assert.match(hex.slice(at), /^2b0601050507011f0101ff04220420/)
})

test('JWK thumbprint matches the RFC 7638 construction (sorted members, base64url sha256)', () => {
  const key = x509.newKey()
  const j = jwkOf(key)
  assert.deepStrictEqual(Object.keys(j), ['crv', 'kty', 'x', 'y'])
  const want = crypto.createHash('sha256').update(`{"crv":"P-256","kty":"EC","x":"${j.x}","y":"${j.y}"}`).digest('base64url')
  assert.strictEqual(thumbprint(key), want)
})

/** A fake ACME CA. It VERIFIES every JWS against the account key, like a real one. */
function fakeCA ({ validate = true } = {}) {
  const B = 'https://ca.test'
  let n = 0
  let accountJwk = null
  const seen = { posts: 0, csr: null, challengeCert: null, kidUsed: false }
  const st = { authz: 'pending', order: 'pending' }
  const nonce = () => 'n' + (++n)
  const res = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'replay-nonce': nonce(), ...headers } })
  const opts = {}
  const fetchImpl = async (url, init = {}) => {
    if (url === `${B}/dir`) return res(200, { newNonce: `${B}/nonce`, newAccount: `${B}/acct`, newOrder: `${B}/order` })
    if (url === `${B}/nonce`) return res(200, '')
    const body = JSON.parse(init.body)
    const prot = JSON.parse(Buffer.from(body.protected, 'base64url'))
    assert.strictEqual(prot.url, url, 'JWS url header matches the request')
    if (prot.jwk) accountJwk = prot.jwk
    else { assert.strictEqual(prot.kid, `${B}/acct/1`); seen.kidUsed = true }
    const pub = crypto.createPublicKey({ key: { ...accountJwk }, format: 'jwk' })
    const okSig = crypto.verify('sha256', Buffer.from(`${body.protected}.${body.payload}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(body.signature, 'base64url'))
    assert.ok(okSig, 'JWS signature verifies')
    seen.posts++
    const payload = body.payload ? JSON.parse(Buffer.from(body.payload, 'base64url')) : null
    if (url === `${B}/acct`) return res(201, {}, { location: `${B}/acct/1` })
    if (url === `${B}/order`) return res(201, { status: 'pending', authorizations: [`${B}/authz/1`], finalize: `${B}/finalize` }, { location: `${B}/order/1` })
    if (url === `${B}/authz/1`) return res(200, { status: st.authz, challenges: [{ type: 'http-01', url: `${B}/ch/0`, token: 'x' }, { type: 'tls-alpn-01', url: `${B}/ch/1`, token: 'TOK', ...(st.authz === 'invalid' ? { error: { detail: 'Connection refused' } } : {}) }] })
    if (url === `${B}/ch/1`) {
      // The "validator": the challenge cert must be served right now, for this key authorization.
      const c = opts.current
      seen.challengeCert = c && c.cert
      const want = crypto.createHash('sha256').update(`TOK.${thumbprint(opts.accountKey)}`).digest()
      st.authz = validate && c && new crypto.X509Certificate(c.cert).raw.includes(want) ? 'valid' : 'invalid'
      return res(200, {})
    }
    if (url === `${B}/finalize`) { seen.csr = payload.csr; st.order = 'valid'; return res(200, {}) }
    if (url === `${B}/order/1`) return res(200, { status: st.order, certificate: `${B}/cert` })
    if (url === `${B}/cert`) return res(200, x509.alpnChallengeCert(x509.newKey(), 'demo.t.heyiris.io', 'issued'))
    return res(404, { type: 'urn:ietf:params:acme:error:malformed' })
  }
  return { fetchImpl, seen, opts, dir: `${B}/dir` }
}

test('ACME flow: account → order → tls-alpn-01 → finalize → certificate, every request signed', async () => {
  const ca = fakeCA()
  const accountKey = x509.newKey()
  const certKey = x509.newKey()
  ca.opts.accountKey = accountKey
  const calls = []
  const r = await obtainCertificate({
    name: 'demo.t.heyiris.io', accountKey, certKey, directory: ca.dir, fetch: ca.fetchImpl, pollMs: 1,
    setChallenge: (n, c) => { calls.push([n, !!c]); ca.opts.current = c }
  })
  assert.match(r.cert, /BEGIN CERTIFICATE/)
  assert.ok(r.notAfter > new Date())
  assert.ok(ca.seen.kidUsed, 'requests after newAccount use kid, not the jwk')
  assert.deepStrictEqual(calls, [['demo.t.heyiris.io', true], ['demo.t.heyiris.io', false]], 'challenge set, then cleared')
  const csrPem = x509.toPem(Buffer.from(ca.seen.csr, 'base64url'), 'CERTIFICATE REQUEST')
  const csrText = openssl(['req', '-verify', '-noout', '-text'], csrPem)
  assert.match(csrText, /verify OK/)
  assert.match(csrText, /DNS:demo\.t\.heyiris\.io/)
  const csrKey = openssl(['req', '-noout', '-pubkey'], csrPem)
  assert.strictEqual(crypto.createPublicKey(csrKey).export({ type: 'spki', format: 'der' }).toString('hex'),
    crypto.createPublicKey(certKey).export({ type: 'spki', format: 'der' }).toString('hex'), 'the CSR carries the NODE key, not the account key')
})

test('ACME flow: a failed validation says why, and the challenge is still cleared', async () => {
  const ca = fakeCA({ validate: false })
  const accountKey = x509.newKey()
  ca.opts.accountKey = accountKey
  let last = 'unset'
  await assert.rejects(obtainCertificate({
    name: 'demo.t.heyiris.io', accountKey, certKey: x509.newKey(), directory: ca.dir, fetch: ca.fetchImpl, pollMs: 1,
    setChallenge: (n, c) => { last = c; ca.opts.current = c }
  }), /could not validate demo\.t\.heyiris\.io: Connection refused/)
  assert.strictEqual(last, null)
})

test('ACME flow: a 503 "Service busy" is retried, not fatal (measured on LE staging)', async () => {
  const ca = fakeCA()
  const accountKey = x509.newKey()
  ca.opts.accountKey = accountKey
  let busy = 2
  const flaky = async (url, init) => {
    if (url.endsWith('/order') && busy-- > 0) return new Response(JSON.stringify({ type: 'urn:ietf:params:acme:error:rateLimited', detail: 'Service busy; retry later.' }), { status: 503, headers: { 'replay-nonce': 'b' + busy } })
    return ca.fetchImpl(url, init)
  }
  const r = await obtainCertificate({ name: 'demo.t.heyiris.io', accountKey, certKey: x509.newKey(), directory: ca.dir, fetch: flaky, pollMs: 1, busyWaitMs: 1, setChallenge: (n, c) => { ca.opts.current = c } })
  assert.match(r.cert, /BEGIN CERTIFICATE/)
  assert.strictEqual(busy, -1, 'both busy answers were retried through')
})

test('ACME flow: a 4xx is NOT retried — it is a real refusal and says so', async () => {
  const ca = fakeCA()
  const accountKey = x509.newKey()
  ca.opts.accountKey = accountKey
  let calls = 0
  const refusing = async (url, init) => {
    if (url.endsWith('/order')) { calls++; return new Response(JSON.stringify({ type: 'urn:ietf:params:acme:error:rejectedIdentifier', detail: 'nope' }), { status: 400, headers: { 'replay-nonce': 'r' } }) }
    return ca.fetchImpl(url, init)
  }
  await assert.rejects(obtainCertificate({ name: 'demo.t.heyiris.io', accountKey, certKey: x509.newKey(), directory: ca.dir, fetch: refusing, pollMs: 1, busyWaitMs: 1, setChallenge: () => {} }), /rejectedIdentifier: nope/)
  assert.strictEqual(calls, 1)
})
