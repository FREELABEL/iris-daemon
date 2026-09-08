#!/usr/bin/env node
/**
 * R1 Setup — pair a handheld and print everything it needs to connect.
 *
 *   node scripts/r1-setup.js pair    <device-id> [--label "Alex's R1"] [--agent 642]
 *   node scripts/r1-setup.js start   --agent 642 [--bloq 639] [--mode chat|channel]
 *   node scripts/r1-setup.js status
 *   node scripts/r1-setup.js devices
 *   node scripts/r1-setup.js revoke  <device-id>
 *   node scripts/r1-setup.js stop
 *
 * Everything here talks to the running bridge over HTTP with the operator's
 * X-Bridge-Key, so it works identically against a local bridge or one reached
 * over Tailscale.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { detectTailscaleIp } = require('../daemon/tailscale-address')

const BRIDGE_HOST = process.env.BRIDGE_HOST || '127.0.0.1'
const BRIDGE_PORT = process.env.BRIDGE_PORT || 3200
const TOKEN_PATH = process.env.BRIDGE_TOKEN_PATH || path.join(os.homedir(), '.iris', 'bridge-token')

function bridgeToken () {
  try {
    return fs.readFileSync(TOKEN_PATH, 'utf-8').trim()
  } catch {
    console.error(`✗ No bridge token at ${TOKEN_PATH} — is the bridge running?`)
    process.exit(1)
  }
}

function call (method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null
    const req = http.request({
      hostname: BRIDGE_HOST,
      port: BRIDGE_PORT,
      path: urlPath,
      method,
      headers: {
        'X-Bridge-Key': bridgeToken(),
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
      },
      timeout: 15000
    }, (res) => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        let parsed
        try { parsed = JSON.parse(data) } catch { parsed = { raw: data } }
        if (res.statusCode >= 400) return reject(new Error(parsed.error || `HTTP ${res.statusCode}: ${data.slice(0, 200)}`))
        resolve(parsed)
      })
    })
    req.on('error', (e) => reject(new Error(`${e.message} — is the bridge running on ${BRIDGE_HOST}:${BRIDGE_PORT}?`)))
    req.on('timeout', () => { req.destroy(); reject(new Error('bridge timed out')) })
    if (payload) req.write(payload)
    req.end()
  })
}

function flag (name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

/**
 * Which addresses can a device ACTUALLY reach this gateway on?
 *
 * The bridge binds 127.0.0.1 unless BRIDGE_BIND_HOST says otherwise, so simply
 * printing the Tailscale address next to localhost hands out a URL that cannot
 * connect — and the device's failure ("no signal") looks nothing like the cause
 * ("bound to loopback"). So each candidate is PROBED with a real TCP connect
 * rather than assumed. An address that does not answer is reported as such.
 */
function probe (host, port, timeout = 1200) {
  return new Promise((resolve) => {
    const net = require('net')
    const socket = new net.Socket()
    const done = (ok) => { socket.destroy(); resolve(ok) }
    socket.setTimeout(timeout)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(port, host)
  })
}

async function reachableUrls (wsPath) {
  const candidates = [{ host: '127.0.0.1', why: 'loopback (this Mac, or adb reverse)' }]

  const ts = await detectTailscaleIp().catch(() => null)
  if (ts) candidates.push({ host: ts, why: 'tailscale' })

  const os = require('os')
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && a.address !== ts) {
        candidates.push({ host: a.address, why: `LAN (${name})` })
      }
    }
  }

  const checked = []
  for (const c of candidates) {
    checked.push({ ...c, url: `ws://${c.host}:${BRIDGE_PORT}${wsPath}`, reachable: await probe(c.host, BRIDGE_PORT) })
  }

  return {
    checked,
    urls: checked.filter(c => c.reachable).map(c => c.url),
    tailscale: ts,
    tailscaleReachable: checked.find(c => c.host === ts)?.reachable || false
  }
}

const commands = {
  async pair () {
    const deviceId = process.argv[3]
    if (!deviceId || deviceId.startsWith('--')) {
      console.error('Usage: r1-setup.js pair <device-id> [--label "..."] [--agent <id>]')
      process.exit(1)
    }

    const result = await call('POST', '/api/r1/devices', {
      device_id: deviceId,
      label: flag('label', deviceId),
      agent_id: flag('agent')
    })

    const status = await call('GET', '/api/providers/r1').catch(() => ({}))
    const wsPath = status.path || '/r1'
    const { checked, urls, tailscale, tailscaleReachable } = await reachableUrls(wsPath)

    // Prefer an address the DEVICE can use over one only this Mac can.
    const offDevice = checked.find(c => c.reachable && c.host !== '127.0.0.1')
    const gateway = (offDevice || checked[0]).url

    console.log(`\n✓ Paired "${result.label}" (${result.device_id})\n`)
    console.log('  Put this on the device:\n')
    console.log(JSON.stringify({
      gateway,
      device_id: result.device_id,
      token: result.token
    }, null, 2))

    console.log(`\n  Addresses, probed just now:`)
    for (const c of checked) {
      console.log(`    ${c.reachable ? '✓' : '✗'} ${c.url}   ${c.why}`)
    }

    if (!offDevice) {
      console.log(`\n  ⚠ NOTHING OFF THIS MACHINE CAN REACH THE GATEWAY.`)
      console.log(`    The bridge binds 127.0.0.1 by default, so the device cannot`)
      console.log(`    connect to it over Wi-Fi, LTE or Tailscale. Two ways out:`)
      console.log(``)
      console.log(`      USB-tethered (best while testing — no network exposure):`)
      console.log(`        adb reverse tcp:${BRIDGE_PORT} tcp:${BRIDGE_PORT}`)
      console.log(`        then set the device's gateway to ws://127.0.0.1:${BRIDGE_PORT}${wsPath}`)
      console.log(``)
      console.log(`      Untethered: rebind the bridge, ideally to the tailnet only —`)
      console.log(`        BRIDGE_BIND_HOST=${tailscale || '<tailscale-ip>'} , then restart the daemon.`)
      console.log(`        Do NOT use 0.0.0.0 unless you mean to expose it to the whole LAN.`)
    } else if (tailscale && !tailscaleReachable) {
      console.log(`\n  ⚠ Tailscale address ${tailscale} did NOT answer — the bridge is not`)
      console.log(`    bound to it. Fine over USB/LAN; it will not work off-network.`)
    }

    console.log(`\n  ⚠ The token above is shown ONCE. Only its hash is stored.`)
    console.log(`    Lost it → re-run pair (which replaces the old token).\n`)
  },

  async start () {
    const agent = flag('agent')
    const mode = flag('mode', 'chat')
    if (mode === 'chat' && !agent) {
      console.error('✗ chat mode needs --agent <id>. List them with: iris agents list')
      process.exit(1)
    }
    const result = await call('POST', '/api/providers/r1', {
      mode,
      dialect: flag('dialect', 'openclaw'),
      capture: process.argv.includes('--capture'),
      agent_id: agent,
      bloq_id: flag('bloq'),
      user_id: flag('user'),
      language: flag('language'),
      glossary: flag('glossary'),
      iris_api_url: flag('api-url')
    })
    const { checked } = await reachableUrls(result.path || '/r1')
    console.log(`\n✓ R1 gateway running (mode: ${result.mode || mode}, dialect: ${result.dialect})`)
    console.log(`  ${result.devices_paired} device(s) paired`)
    for (const c of checked) console.log(`  ${c.reachable ? '✓' : '✗'} ${c.url}   ${c.why}`)
    console.log()
    if (result.devices_paired === 0) {
      console.log('  Next: node scripts/r1-setup.js pair my-r1 --label "My R1"\n')
    }
  },

  async status () {
    const s = await call('GET', '/api/providers/r1')
    if (!s.running) {
      console.log(`\n  R1 gateway: stopped`)
      console.log(`  Devices paired: ${s.devices_paired}`)
      console.log(`  ${s.hint || ''}\n`)
      return
    }
    console.log(`\n  R1 gateway: running`)
    console.log(`  Mode:        ${s.mode}${s.agent_id ? ` (agent ${s.agent_id})` : ''}`)
    console.log(`  Dialect:     ${s.dialect}`)
    console.log(`  Path:        ${s.path}`)
    console.log(`  Connected:   ${s.devices_connected} of ${s.devices_paired} paired`)
    console.log(`  Turns:       ${s.messages_processed}  ·  transcribed: ${s.transcriptions}`)
    console.log(`  Errors:      ${s.errors}${s.last_error ? `  (last: ${s.last_error})` : ''}`)
    console.log(`  Rejected:    ${s.rejected_connections} unauthorized connection attempt(s)`)
    for (const sess of s.sessions || []) {
      console.log(`    · ${sess.label} (${sess.device_id}) since ${sess.connected_at}`)
    }
    console.log()
  },

  async devices () {
    const { devices, registry } = await call('GET', '/api/r1/devices')
    if (!devices.length) {
      console.log(`\n  No paired devices.\n  Pair one: node scripts/r1-setup.js pair my-r1\n`)
      return
    }
    console.log(`\n  ${devices.length} paired device(s)   ${registry}\n`)
    for (const d of devices) {
      console.log(`  ${d.connected ? '●' : '○'} ${d.label}  (${d.device_id})`)
      console.log(`      paired ${d.paired_at}   last seen ${d.last_seen || 'never'}`)
    }
    console.log()
  },

  async revoke () {
    const deviceId = process.argv[3]
    if (!deviceId) { console.error('Usage: r1-setup.js revoke <device-id>'); process.exit(1) }
    await call('DELETE', `/api/r1/devices/${encodeURIComponent(deviceId)}`)
    console.log(`\n✓ Revoked ${deviceId} — it can no longer connect.\n`)
  },

  async stop () {
    const r = await call('DELETE', '/api/providers/r1')
    console.log(`\n✓ Gateway stopped. ${r.devices_paired} pairing(s) kept.\n`)
  }
}

const cmd = process.argv[2]
if (!cmd || !commands[cmd]) {
  console.log(`
  R1 Setup — connect a Rabbit R1 to IRIS

    pair <device-id> [--label L] [--agent N]   mint a device token
    start --agent <id> [--bloq N] [--mode M]   start the gateway
          [--dialect openclaw|native] [--capture]
    status                                     is it up, who is connected
    devices                                    list paired handhelds
    revoke <device-id>                         kill one device's access
    stop                                       stop the gateway (keeps pairings)
`)
  process.exit(cmd ? 1 : 0)
}

commands[cmd]().catch(err => {
  console.error(`\n✗ ${err.message}\n`)
  process.exit(1)
})
