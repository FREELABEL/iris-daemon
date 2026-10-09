#!/usr/bin/env node
'use strict'

/**
 * Keep `*.t.heyiris.io` pointed at the relay's home internet address (#188585).
 *
 * The relay runs on iris-hive-001 behind a residential line whose address can change. When it
 * does, every tunnel URL goes dark with no error anywhere — DNS still answers, with the old IP.
 * This runs on a timer (systemd hive-relay-ddns.timer) and fixes the record when it drifts.
 *
 *   node relay/ddns.js            update if needed
 *   node relay/ddns.js --check    say what it would do, change nothing
 *
 * Rules, each from a way this goes wrong:
 *   - TWO independent sources must agree on the public IP. One flaky lookup must not repoint
 *     every tunnel at a wrong address.
 *   - A private, loopback or CGNAT address is never published (a lookup that answered from inside
 *     the network, or a carrier that moved us behind NAT — then port-forwarding cannot work anyway).
 *   - Only the named records are touched, and only their content.
 *
 * Env: HIVE_DDNS_ZONES="heyiris.io,hivemesh.net,irishive.net"  HIVE_DDNS_RECORDS="*.t.heyiris.io,*.hivemesh.net,*.irishive.net"
 *      CLOUDFLARE_DNS_TOKEN_FILE=~/.iris/secrets/cloudflare-dns.token (0600, DNS edit on the zone)
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const net = require('net')

const SOURCES = [
  { name: 'ipify', url: 'https://api.ipify.org', parse: (t) => t.trim() },
  { name: 'cloudflare', url: 'https://1.1.1.1/cdn-cgi/trace', parse: (t) => ((/^ip=(.+)$/m.exec(t) || [])[1] || '').trim() }
]

function isPublicV4 (ip) {
  if (net.isIPv4(ip) !== true) return false
  const [a, b] = ip.split('.').map(Number)
  if (a === 10 || a === 127 || a === 0 || a >= 224) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 169 && b === 254) return false
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT (also Tailscale)
  return true
}

async function publicIp (fetchImpl = fetch) {
  const got = await Promise.all(SOURCES.map(async (s) => {
    try {
      const r = await fetchImpl(s.url, { signal: AbortSignal.timeout(8000) })
      return r.ok ? s.parse(await r.text()) : null
    } catch { return null }
  }))
  const [a, b] = got
  if (!a || !b) return { ip: null, why: `a lookup failed (${SOURCES.map((s, i) => `${s.name}=${got[i] || 'none'}`).join(', ')})` }
  if (a !== b) return { ip: null, why: `the lookups disagree (${a} vs ${b}) — not guessing` }
  if (!isPublicV4(a)) return { ip: null, why: `${a} is not a public IPv4 address — refusing to publish it` }
  return { ip: a }
}

async function reconcile ({ token, zone, records, check = false, fetchImpl = fetch, log = console.log }) {
  const { ip, why } = await publicIp(fetchImpl)
  if (!ip) { log(`ddns: no change — ${why}`); return { changed: 0, error: why } }
  const cf = async (method, p, body) => {
    const r = await fetchImpl(`https://api.cloudflare.com/client/v4${p}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok || j.success === false) throw new Error(`cloudflare ${method} ${p.split('?')[0]}: ${(j.errors || []).map((e) => e.message).join('; ') || r.status}`)
    return j.result
  }
  // Records may live in different zones (*.t.heyiris.io, *.hivemesh.net, *.irishive.net): each
  // record's zone is the longest given zone it ends with.
  const zoneIds = {}
  const zoneOf = async (name) => {
    const bare = name.replace(/^\*\./, '')
    const z = [].concat(zone).filter((zz) => bare === zz || bare.endsWith('.' + zz)).sort((a, b) => b.length - a.length)[0]
    if (!z) throw new Error(`${name} is in none of the zones ${[].concat(zone).join(', ')}`)
    if (!zoneIds[z]) {
      const found = (await cf('GET', `/zones?name=${encodeURIComponent(z)}`))[0]
      if (!found) throw new Error(`zone ${z} not visible to this token`)
      zoneIds[z] = found.id
    }
    return zoneIds[z]
  }
  let changed = 0
  for (const name of records) {
    const zid = await zoneOf(name)
    const recs = await cf('GET', `/zones/${zid}/dns_records?type=A&name=${encodeURIComponent(name)}`)
    if (!recs.length) { log(`ddns: ${name} has no A record — create it once by hand; this only keeps it current`); continue }
    for (const rec of recs) {
      if (rec.content === ip) { log(`ddns: ${name} → ${ip} (current)`); continue }
      if (check) { log(`ddns: ${name} is ${rec.content}, would set ${ip} (--check: no change)`); continue }
      await cf('PATCH', `/zones/${zid}/dns_records/${rec.id}`, { content: ip })
      log(`ddns: ${name} ${rec.content} → ${ip} UPDATED`)
      changed++
    }
  }
  return { changed, ip }
}

module.exports = { reconcile, publicIp, isPublicV4 }

if (require.main === module) {
  const tokenFile = process.env.CLOUDFLARE_DNS_TOKEN_FILE || path.join(os.homedir(), '.iris/secrets/cloudflare-dns.token')
  const token = fs.readFileSync(tokenFile, 'utf8').trim()
  reconcile({
    token,
    zone: (process.env.HIVE_DDNS_ZONES || process.env.HIVE_DDNS_ZONE || 'heyiris.io,hivemesh.net,irishive.net').split(',').map((z) => z.trim()).filter(Boolean),
    records: (process.env.HIVE_DDNS_RECORDS || '*.t.heyiris.io,*.hivemesh.net,*.irishive.net').split(',').map((s) => s.trim()).filter(Boolean),
    check: process.argv.includes('--check')
  }).then((r) => process.exit(r.error ? 1 : 0), (e) => { console.error(`ddns: ${e.message}`); process.exit(1) })
}
