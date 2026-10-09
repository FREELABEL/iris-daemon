'use strict'

/**
 * A node gets its OWN certificate through a relay that never sees it (#188585).
 *
 * ACME (RFC 8555) with the TLS-ALPN-01 challenge (RFC 8737). The validator connects to
 * `<name>.t.<zone>:443` offering ALPN `acme-tls/1`; the relay routes that connection to the node
 * by hostname like any other (relay/sni.js reads the ALPN too), and the node answers with the
 * challenge certificate. So:
 *   - the certificate's private key is generated on the node and never leaves it,
 *   - no node needs a DNS API token, and the relay needs none for tunnels,
 *   - the only thing a node needs is a live tunnel — which it has to have anyway.
 *
 *   const c = await obtainCertificate({ name: 'demo.t.heyiris.io', accountKey, certKey,
 *                                       setChallenge: (name, pem|null) => …, directory })
 *   → { cert: '<PEM chain>', notAfter: Date }
 *
 * Let's Encrypt limits NEW names to 50 per week per registered domain (heyiris.io), shared by
 * every tunnel. Renewals of the same name are exempt — so a node keeps its name and its key, and
 * renews; it does not ask for a fresh name per run.
 */

const crypto = require('crypto')
const x509 = require('./x509')

const DIRECTORIES = {
  production: 'https://acme-v02.api.letsencrypt.org/directory',
  staging: 'https://acme-staging-v02.api.letsencrypt.org/directory'
}

const b64u = (b) => Buffer.from(b).toString('base64url')

function jwkOf (key) {
  const { kty, crv, x, y } = crypto.createPublicKey(key).export({ format: 'jwk' })
  return { crv, kty, x, y } // members in lexical order — RFC 7638 thumbprint input
}
function thumbprint (key) {
  return b64u(crypto.createHash('sha256').update(JSON.stringify(jwkOf(key))).digest())
}

async function obtainCertificate (o) {
  const directoryUrl = DIRECTORIES[o.directory] || o.directory || DIRECTORIES.production
  const fetchImpl = o.fetch || fetch
  const log = o.log || (() => {})
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const pollMs = o.pollMs ?? 2000
  const deadline = Date.now() + (o.timeoutMs ?? 180000)

  const dir = await (await fetchImpl(directoryUrl)).json()
  let nonce = null
  let kid = null
  const freshNonce = async () => (await fetchImpl(dir.newNonce, { method: 'HEAD' })).headers.get('replay-nonce')

  async function post (url, payload, { retried = false } = {}) {
    if (!nonce) nonce = await freshNonce()
    const protectedHeader = { alg: 'ES256', nonce, url, ...(kid ? { kid } : { jwk: jwkOf(o.accountKey) }) }
    const p64 = b64u(JSON.stringify(protectedHeader))
    const pl64 = payload === '' ? '' : b64u(JSON.stringify(payload)) // '' = POST-as-GET
    const sig = crypto.sign('sha256', Buffer.from(`${p64}.${pl64}`), { key: o.accountKey, dsaEncoding: 'ieee-p1363' })
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/jose+json' },
      body: JSON.stringify({ protected: p64, payload: pl64, signature: b64u(sig) })
    })
    nonce = res.headers.get('replay-nonce')
    if (res.status >= 400) {
      const err = await res.json().catch(() => ({}))
      if (err.type === 'urn:ietf:params:acme:error:badNonce' && !retried) return post(url, payload, { retried: true })
      const e = new Error(`ACME ${res.status} ${err.type || ''}: ${err.detail || 'request failed'}`.trim())
      e.acme = err
      throw e
    }
    return res
  }

  const acct = await post(dir.newAccount, { termsOfServiceAgreed: true, ...(o.email ? { contact: [`mailto:${o.email}`] } : {}) })
  kid = acct.headers.get('location')

  const orderRes = await post(dir.newOrder, { identifiers: [{ type: 'dns', value: o.name }] })
  const orderUrl = orderRes.headers.get('location')
  let order = await orderRes.json()

  try {
    for (const authzUrl of order.authorizations) {
      let authz = await (await post(authzUrl, '')).json()
      if (authz.status === 'valid') continue
      const ch = (authz.challenges || []).find((c) => c.type === 'tls-alpn-01')
      if (!ch) throw new Error('the CA offered no tls-alpn-01 challenge for ' + o.name)
      const keyAuth = `${ch.token}.${thumbprint(o.accountKey)}`
      o.setChallenge(o.name, { cert: x509.alpnChallengeCert(o.certKey, o.name, keyAuth), key: o.certKey })
      log('acme', `challenge ready for ${o.name}`)
      await post(ch.url, {})
      while (authz.status === 'pending' || authz.status === 'processing') {
        if (Date.now() > deadline) throw new Error('timed out waiting for the CA to validate ' + o.name)
        await sleep(pollMs)
        authz = await (await post(authzUrl, '')).json()
      }
      if (authz.status !== 'valid') {
        const why = (authz.challenges || []).map((c) => c.error && c.error.detail).filter(Boolean).join('; ')
        throw new Error(`the CA could not validate ${o.name}: ${why || authz.status}`)
      }
    }
  } finally {
    o.setChallenge(o.name, null)
  }

  await post(order.finalize, { csr: b64u(x509.csr(o.certKey, o.name)) })
  order = await (await post(orderUrl, '')).json()
  while (order.status === 'processing' || order.status === 'ready') {
    if (Date.now() > deadline) throw new Error('timed out waiting for the certificate')
    await sleep(pollMs)
    order = await (await post(orderUrl, '')).json()
  }
  if (order.status !== 'valid') throw new Error(`order for ${o.name} ended ${order.status}`)
  const cert = await (await post(order.certificate, '')).text()
  const notAfter = new Date(new crypto.X509Certificate(cert).validTo)
  log('acme', `certificate for ${o.name} valid until ${notAfter.toISOString()}`)
  return { cert, notAfter }
}

module.exports = { obtainCertificate, thumbprint, jwkOf, DIRECTORIES }
