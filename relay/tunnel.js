#!/usr/bin/env node
'use strict'

/**
 * One Hive tunnel, run on the node that owns it (#188585). This is what `iris hive tunnel <port>`
 * starts; it is also usable on its own.
 *
 *   node relay/tunnel.js --name demo --port 3000 [--staging]
 *
 * Token: on every (re)connect it asks the IRIS API for a fresh registration token for this name
 * (POST {IRIS_API_BASE}/api/v6/nodes/tunnels, bearer IRIS_API_KEY — env only, never argv, so it is
 * not visible in `ps`). The API refuses a name owned by another account. HIVE_TUNNEL_TOKEN skips
 * the API (for operators testing a relay by hand).
 *
 * Certificate: generated and kept HERE, in ~/.iris/tunnels/<name>/ (0600), issued by Let's Encrypt
 * through the relay with TLS-ALPN-01, renewed when 30 days remain. The relay never sees the key.
 *
 * Output: one JSON object per line on stdout — {event: ready|cert|down|error|closed, ...} — so the
 * CLI can render it and a script can parse it.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { connectTunnel } = require('./client')
const { obtainCertificate } = require('./acme')
const x509 = require('./x509')

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d }
const flag = (k) => process.argv.includes('--' + k)
const say = (event, extra = {}) => process.stdout.write(JSON.stringify({ event, ...extra, at: new Date().toISOString() }) + '\n')

const name = String(arg('name', '')).toLowerCase()
const port = Number(arg('port', 0))
const host = arg('host', '127.0.0.1')
const zone = process.env.HIVE_RELAY_ZONE || 't.heyiris.io'
const relayHost = process.env.HIVE_RELAY_HOST || `relay.${zone}`
const relayAddr = process.env.HIVE_RELAY_ADDR || relayHost
const staging = flag('staging')
const RENEW_DAYS = 30

if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) || !(port > 0 && port < 65536)) {
  console.error('usage: relay/tunnel.js --name <lowercase-name> --port <local port> [--host 127.0.0.1] [--staging]')
  process.exit(2)
}

const fqdn = `${name}.${zone}`
const dir = path.join(os.homedir(), '.iris', 'tunnels', name + (staging ? '.staging' : ''))
fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
const file = (f) => path.join(dir, f)

function keyFile (f) {
  if (!fs.existsSync(file(f))) fs.writeFileSync(file(f), x509.newKey().export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  return crypto.createPrivateKey(fs.readFileSync(file(f)))
}
const accountKey = keyFile('account.key')
const certKey = keyFile('node.key')

function savedCert () {
  try {
    const pem = fs.readFileSync(file('cert.pem'), 'utf8')
    const c = new crypto.X509Certificate(pem)
    if (!c.checkHost(fqdn)) return null
    return { pem, notAfter: new Date(c.validTo) }
  } catch { return null }
}

async function getToken () {
  if (process.env.HIVE_TUNNEL_TOKEN) return process.env.HIVE_TUNNEL_TOKEN
  const base = String(process.env.IRIS_API_BASE || 'https://heyiris.io').replace(/\/$/, '')
  const key = process.env.IRIS_API_KEY
  if (!key) throw new Error('not signed in to IRIS (IRIS_API_KEY is not set)')
  const res = await fetch(`${base}/api/v6/nodes/tunnels`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ name })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const e = new Error(body.error || body.message || `IRIS refused the tunnel name (HTTP ${res.status})`)
    e.final = res.status === 403 || res.status === 409 || res.status === 422
    throw e
  }
  return body.data.token
}

;(async () => {
  let tunnel
  try {
    // First token outside connectTunnel, so "this name belongs to someone else" is a clear,
    // final error instead of a reconnect loop.
    const first = await getToken()
    let used = false
    tunnel = await connectTunnel({
      relay: { host: relayAddr, port: Number(process.env.HIVE_RELAY_PORT || 443) },
      relayHost, name, target: { host, port }, reconnect: true,
      getToken: async () => { if (!used) { used = true; return first } return getToken() }
    })
  } catch (e) {
    say('error', { message: e.message, final: true })
    process.exit(1)
  }
  tunnel.on('down', () => say('down'))
  tunnel.on('ready', (h) => say('ready', { url: `https://${h}` }))
  tunnel.on('warn', (e) => say('error', { message: e.message }))

  const have = savedCert()
  if (have) tunnel.setCertificate(have.pem, certKey)
  say('ready', { url: `https://${fqdn}`, certificate: have ? 'saved' : 'requesting' })

  let renewing = false
  async function ensureCert () {
    const c = savedCert()
    if (renewing || (c && c.notAfter - Date.now() > RENEW_DAYS * 86400e3)) return
    renewing = true
    try {
      const r = await obtainCertificate({
        name: fqdn, accountKey, certKey, directory: staging ? 'staging' : 'production',
        setChallenge: (n, ch) => tunnel.setChallenge(n, ch)
      })
      fs.writeFileSync(file('cert.pem'), r.cert, { mode: 0o600 })
      tunnel.setCertificate(r.cert, certKey)
      say('cert', { notAfter: r.notAfter.toISOString(), issuer: staging ? 'staging' : 'letsencrypt' })
    } catch (e) {
      // Keep serving the old certificate if there is one; try again later.
      say('error', { message: `certificate: ${e.message}`, retry: true })
    } finally { renewing = false }
  }
  await ensureCert()
  setInterval(ensureCert, 12 * 3600e3).unref()

  const stop = () => { tunnel.close(); say('closed'); process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  const forMs = Number(arg('for-ms', 0))
  if (forMs > 0) setTimeout(stop, forMs)
})()
