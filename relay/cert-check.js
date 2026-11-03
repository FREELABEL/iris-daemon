#!/usr/bin/env node
'use strict'

/**
 * Is the certificate the relay SERVES still good for a while? (#191664)
 *
 * The renewal unit failed every day for three weeks and nothing said so. This connects to the
 * relay the way a client does (SNI = the control host), verifies the chain and the name, and
 * exits 1 when fewer than HIVE_RELAY_CERT_MIN_DAYS (21) days are left — so the unit that runs it
 * fails and its OnFailure= alert fires. Checking the served certificate, not the file, also
 * catches a renewal the relay never reloaded.
 *
 *   node relay/cert-check.js                 check 127.0.0.1:443 as relay.t.heyiris.io
 *   HIVE_RELAY_CHECK_ADDR=host:port HIVE_RELAY_HOST=name HIVE_RELAY_CERT_MIN_DAYS=n  to override
 */

const tls = require('tls')

function served ({ host, port, servername, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port, servername, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] }, () => {
      const c = s.getPeerCertificate()
      s.end()
      resolve({ notAfter: new Date(c.valid_to), subject: c.subject && c.subject.CN })
    })
    s.setTimeout(timeoutMs, () => { s.destroy(); reject(new Error(`timed out after ${timeoutMs} ms`)) })
    s.on('error', reject)
  })
}

/** Days left and a verdict — pure, so the threshold logic is testable without a socket. */
function verdict (notAfter, now = new Date(), minDays = 21) {
  const days = (notAfter.getTime() - now.getTime()) / 86400000
  return { days: Math.floor(days), ok: days >= minDays }
}

async function main () {
  const [h, p] = (process.env.HIVE_RELAY_CHECK_ADDR || '127.0.0.1:443').split(':')
  const servername = process.env.HIVE_RELAY_HOST || 'relay.t.heyiris.io'
  const minDays = Number(process.env.HIVE_RELAY_CERT_MIN_DAYS || 21)
  try {
    const c = await served({ host: h, port: Number(p || 443), servername })
    const v = verdict(c.notAfter, new Date(), minDays)
    const line = `relay certificate for ${servername}: notAfter ${c.notAfter.toISOString()}, ${v.days} day(s) left (alert under ${minDays})`
    if (!v.ok) { console.error(`FAIL ${line}`); process.exit(1) }
    console.log(`ok ${line}`)
  } catch (e) {
    console.error(`FAIL relay certificate for ${servername} could not be verified: ${e.message}`)
    process.exit(1)
  }
}

if (require.main === module) main()
module.exports = { served, verdict }
