#!/usr/bin/env node
'use strict'

/**
 * Run the Hive relay as a service (#188585).
 *
 *   node relay/run.js                       serve (config from env, secrets from files)
 *   node relay/run.js token <name> [hours]  print a registration token for one name (default 24 h) —
 *                                           for operators; people get theirs from the IRIS API
 *
 * Env (defaults are for the heyiris.io deployment on iris-hive-001):
 *   HIVE_RELAY_ZONE=t.heyiris.io  HIVE_RELAY_HOST=relay.t.heyiris.io  HIVE_RELAY_PORT=443
 *   HIVE_RELAY_CERT / HIVE_RELAY_KEY      the relay's OWN certificate (its control host only —
 *                                         it never holds a tunnel's certificate)
 *   HIVE_RELAY_SECRET_FILE                HMAC secret for per-name tokens; created 0600 if absent
 *
 * Binding :443 needs CAP_NET_BIND_SERVICE — the systemd unit grants exactly that, never root.
 * The certificate is re-read on SIGHUP, so a renewal does not need a restart.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { createRelay, tokenFor } = require('./server')

const HOME = os.homedir()
const zones = (process.env.HIVE_RELAY_ZONES || process.env.HIVE_RELAY_ZONE || 't.heyiris.io').split(',').map((z) => z.trim()).filter(Boolean)
const zone = zones[0]
const relayHost = process.env.HIVE_RELAY_HOST || `relay.${zone}`
const port = Number(process.env.HIVE_RELAY_PORT || 443)
const certFile = process.env.HIVE_RELAY_CERT || path.join(HOME, '.iris/relay/acme/certificates', `${relayHost}.crt`)
const keyFile = process.env.HIVE_RELAY_KEY || path.join(HOME, '.iris/relay/acme/certificates', `${relayHost}.key`)
const secretFile = process.env.HIVE_RELAY_SECRET_FILE || path.join(HOME, '.iris/secrets/hive-relay.secret')
// Takedown list: one tunnel name per line, # comments. Edits apply within 10 s, no restart.
const denyFile = process.env.HIVE_RELAY_DENY_FILE || path.join(HOME, '.iris/relay/deny.txt')
let denied = new Set()
let denyMtime = 0
function loadDeny () {
  try {
    const st = fs.statSync(denyFile)
    if (st.mtimeMs === denyMtime) return false
    denyMtime = st.mtimeMs
    denied = new Set(fs.readFileSync(denyFile, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim().toLowerCase()).filter(Boolean))
  } catch { if (denied.size === 0 && denyMtime === 0) return false; denied = new Set(); denyMtime = 0 }
  return true
}
loadDeny()

function secret () {
  if (!fs.existsSync(secretFile)) {
    fs.mkdirSync(path.dirname(secretFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 })
  }
  return fs.readFileSync(secretFile, 'utf8').trim()
}

if (process.argv[2] === 'token') {
  const name = String(process.argv[3] || '')
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) { console.error('usage: relay/run.js token <name>  (lowercase letters, digits, dashes)'); process.exit(2) }
  const hours = Math.min(Math.max(Number(process.argv[4] || 24), 1), 24 * 30)
  console.log(tokenFor(secret(), name, Math.floor(Date.now() / 1000) + Math.round(hours * 3600)))
  process.exit(0)
}

const log = (k, why) => console.log(`${new Date().toISOString()} ${k} ${why}`)
// One options object, kept: the relay reads opts.cert / opts.key for each NEW control connection,
// so swapping them on SIGHUP picks up a renewed certificate without dropping live tunnels.
const opts = { zone, zones, relayHost, cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile), secret: secret(), log, isDenied: (n) => denied.has(n) }
const relay = createRelay(opts)
process.on('SIGHUP', () => {
  try {
    opts.cert = fs.readFileSync(certFile); opts.key = fs.readFileSync(keyFile)
    log('cert', 'reloaded on SIGHUP')
  } catch (e) { log('cert', `reload FAILED, keeping the old one: ${e.message}`) }
})
setInterval(() => { if (loadDeny()) log('deny', `list now ${denied.size} name(s); cut ${relay.enforceDenyList()} live`) }, 10000).unref()
relay.server.listen(port, '0.0.0.0', () => console.log(`${new Date().toISOString()} hive relay on :${port} · zones ${zones.join(', ')} · control ${relayHost}`))
relay.server.on('error', (e) => { console.error(`relay listen failed: ${e.message}`); process.exit(1) })
setInterval(() => console.log(`${new Date().toISOString()} stats ${JSON.stringify(relay.stats())}`), 300000).unref()
process.on('SIGTERM', () => relay.close().then(() => process.exit(0)))
