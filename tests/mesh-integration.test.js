'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const http = require('http')
const crypto = require('crypto')
const EventEmitter = require('events')

// ─── Test helpers ────────────────────────────────────────────────────────────

/** Create a temp directory for test isolation */
function tmpDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-test-'))
}

/** Clean up temp directory */
function cleanDir (dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

/** Minimal mock ResourceMonitor (extends EventEmitter like the real one) */
class MockResourceMonitor extends EventEmitter {
  emitCapacityChange (level, previous, capacity = {}) {
    this.emit('capacity-changed', { level, previous, capacity })
  }
}

/** Simple HTTP GET that returns parsed JSON */
function httpGet (host, port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: urlPath, timeout: 3000 }, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }) } catch { resolve({ status: res.statusCode, body: data }) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
  })
}

/** Simple HTTP POST that returns parsed JSON */
function httpPost (host, port, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request({
      host, port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
      timeout: 5000
    }, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }) } catch { resolve({ status: res.statusCode, body: data }) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
    req.end(payload)
  })
}

/** Start a minimal Express-like HTTP server with the mesh routes wired up */
function startMeshServer (port, modules) {
  const express = require('express')
  const app = express()
  app.use(express.json({ limit: '1mb' }))

  const { registry, auth, dispatch, chat, energy, nodeName } = modules
  const protect = auth.middleware()

  // Register all mesh routes under both '' and '/daemon' prefix so the
  // port-based prefix logic in the modules works regardless of test port
  for (const pfx of ['', '/daemon']) {
    // Registry
    app.get(`${pfx}/mesh/peers`, (req, res) => res.json({ peers: registry.getAllPeers(), node: nodeName }))
    app.post(`${pfx}/mesh/peers`, (req, res) => {
      const { host, port: p, psk } = req.body || {}
      if (!host) return res.status(400).json({ error: 'host required' })
      const peer = registry.addPeer(host, host, p || 3200, 'manual')
      if (psk) registry.setPeerKey(host, psk)
      res.json({ peer })
    })
    app.delete(`${pfx}/mesh/peers/:name`, (req, res) => { registry.removePeer(req.params.name); res.json({ ok: true }) })

    // Auth
    app.post(`${pfx}/mesh/invite`, (req, res) => res.json(auth.generateInvite()))
    app.post(`${pfx}/mesh/pair`, (req, res) => {
      const { code, node_name } = req.body || {}
      if (!code) return res.status(400).json({ error: 'code required' })
      try {
        const result = auth.acceptInvite(code, node_name)
        if (node_name) registry.setPeerKey(node_name, result.psk)
        res.json({ psk: result.psk, peer_name: nodeName })
      } catch (err) {
        res.status(400).json({ error: err.message })
      }
    })

  // Health (for registry polling) — register with and without /daemon prefix
  // so both port-3200 (no prefix) and non-3200 (/daemon prefix) work
  app.get('/health', (req, res) => res.json({ status: 'ok', node_id: nodeName, node_name: nodeName }))
  app.get('/daemon/health', (req, res) => res.json({ status: 'ok', node_id: nodeName, node_name: nodeName }))
  app.get('/capacity', (req, res) => res.json({ level: 'idle', cpu_pct: 10, memory_pct: 40, battery_pct: 95 }))
  app.get('/daemon/capacity', (req, res) => res.json({ level: 'idle', cpu_pct: 10, memory_pct: 40, battery_pct: 95 }))

    // Task dispatch
    app.post(`${pfx}/mesh/task`, protect, async (req, res) => {
      const task = req.body
      if (!task || !task.type) return res.status(400).json({ error: 'task with type required' })
      const taskId = task.id || crypto.randomUUID()
      dispatch.trackTask(taskId, 'accepted')
      res.json({ task_id: taskId, status: 'accepted' })
      // Simulate async completion
      setTimeout(() => dispatch.trackTask(taskId, 'completed', { output: `executed: ${task.prompt}` }), 100)
    })
    app.get(`${pfx}/mesh/task/:id/status`, (req, res) => {
      const status = dispatch.getTaskStatus(req.params.id)
      if (!status) return res.status(404).json({ error: 'Task not found' })
      res.json(status)
    })

    // Chat
    app.post(`${pfx}/mesh/chat`, protect, (req, res) => {
      const msg = req.body
      if (!msg || !msg.text) return res.status(400).json({ error: 'message with text required' })
      chat.receiveMessage(msg)
      res.json({ ok: true })
    })
    app.get(`${pfx}/mesh/chat`, (req, res) => {
      const { since, peer } = req.query
      res.json({ messages: chat.getMessages({ since, peer }), node: nodeName })
    })
    app.get(`${pfx}/mesh/chat/poll`, async (req, res) => {
      const msg = await chat.waitForMessage(2000) // short timeout for tests
      if (msg) { res.json({ message: msg }) } else { res.json({ message: null }) }
    })

    // Energy
    app.post(`${pfx}/mesh/energy`, protect, (req, res) => { energy.receiveAlert(req.body || {}); res.json({ ok: true }) })
    app.get(`${pfx}/mesh/energy`, (req, res) => res.json({ alerts: energy.getAlerts() }))
  } // end prefix loop

  return new Promise((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => resolve(server))
  })
}

/** Create a full mesh module set for a node */
function createMeshModules (nodeName) {
  const MeshRegistry = require('../daemon/mesh-registry')
  const MeshAuth = require('../daemon/mesh-auth')
  const MeshDispatch = require('../daemon/mesh-dispatch')
  const MeshChat = require('../daemon/mesh-chat')
  const MeshEnergy = require('../daemon/mesh-energy')

  const resourceMonitor = new MockResourceMonitor()
  const registry = new MeshRegistry({ ownNodeName: nodeName })
  const auth = new MeshAuth()
  const dispatch = new MeshDispatch({ registry, auth, ownNodeName: nodeName })
  const chat = new MeshChat({ registry, auth, ownNodeName: nodeName })
  const energy = new MeshEnergy({ registry, auth, resourceMonitor, ownNodeName: nodeName })

  return { registry, auth, dispatch, chat, energy, resourceMonitor, nodeName }
}

// ─── Piece 1: mesh-discovery.js ─────────────────────────────────────────────

describe('Piece 1: MeshDiscovery', () => {
  const MeshDiscovery = require('../daemon/mesh-discovery')

  it('constructs with defaults', () => {
    const d = new MeshDiscovery({ nodeName: 'test-node' })
    assert.equal(d.nodeName, 'test-node')
    assert.equal(d.port, 3200)
    assert.equal(d._running, false)
    assert.equal(d.getPeers().size, 0)
  })

  it('getPeers returns a copy (not the internal Map)', () => {
    const d = new MeshDiscovery({ nodeName: 'test-node' })
    const copy = d.getPeers()
    copy.set('fake', {})
    assert.equal(d.getPeers().size, 0) // original unaffected
  })

  it('start and stop are idempotent', () => {
    const d = new MeshDiscovery({ nodeName: 'test-node' })
    // start() will fail gracefully if bonjour-service isn't installed
    d.start()
    d.start() // second call is no-op
    d.stop()
    d.stop() // second call is no-op
    assert.equal(d._running, false)
  })

  it('extracts IPv4 from service addresses', () => {
    const d = new MeshDiscovery({ nodeName: 'test-node' })
    const ip = d._extractIp({ addresses: ['fe80::1', '192.168.1.42', '10.0.0.1'] })
    assert.equal(ip, '192.168.1.42')
  })

  it('falls back to host when no addresses', () => {
    const d = new MeshDiscovery({ nodeName: 'test-node' })
    const ip = d._extractIp({ host: 'my-mac.local' })
    assert.equal(ip, 'my-mac.local')
  })
})

// ─── Piece 2: mesh-registry.js ──────────────────────────────────────────────

describe('Piece 2: MeshRegistry', () => {
  const MeshRegistry = require('../daemon/mesh-registry')

  /** Create a fresh registry that doesn't load from ~/.iris/mesh-peers.json */
  function freshRegistry (name = 'self') {
    const r = new MeshRegistry({ ownNodeName: name })
    // Clear any peers loaded from disk to isolate tests
    r.peers.clear()
    return r
  }

  it('adds and retrieves peers', () => {
    const r = freshRegistry()
    r.addPeer('node-b', '192.168.1.42', 3200, 'manual')

    const peer = r.getPeer('node-b')
    assert.ok(peer)
    assert.equal(peer.name, 'node-b')
    assert.equal(peer.host, '192.168.1.42')
    assert.equal(peer.port, 3200)
    assert.equal(peer.status, 'unknown')
    assert.equal(peer.added_via, 'manual')
  })

  it('ignores self', () => {
    const r = freshRegistry()
    r.addPeer('self', '127.0.0.1', 3200)
    assert.equal(r.getAllPeers().length, 0)
  })

  it('upserts and preserves PSK', () => {
    const r = freshRegistry()
    r.addPeer('node-b', '192.168.1.42', 3200)
    r.setPeerKey('node-b', 'secret123')
    r.addPeer('node-b', '192.168.1.43', 3200) // re-add with new IP
    assert.equal(r.getPeer('node-b').host, '192.168.1.43')
    assert.equal(r.getPeer('node-b').psk, 'secret123') // PSK preserved
  })

  it('removes peers', () => {
    const r = freshRegistry()
    r.addPeer('node-b', '192.168.1.42', 3200)
    assert.equal(r.removePeer('node-b'), true)
    assert.equal(r.removePeer('nonexistent'), false)
    assert.equal(r.getAllPeers().length, 0)
  })

  it('filters online peers', () => {
    const r = freshRegistry()
    r.addPeer('online-node', '192.168.1.42', 3200)
    r.addPeer('offline-node', '192.168.1.43', 3200)
    r.updatePeerStatus('online-node', 'online')
    r.updatePeerStatus('offline-node', 'offline')

    const online = r.getOnlinePeers()
    assert.equal(online.length, 1)
    assert.equal(online[0].name, 'online-node')
  })

  it('updates peer status and last_seen', () => {
    const r = freshRegistry()
    r.addPeer('node-b', '192.168.1.42', 3200)
    r.updatePeerStatus('node-b', 'online')
    assert.equal(r.getPeer('node-b').status, 'online')
    assert.ok(r.getPeer('node-b').last_seen)
  })
})

// ─── Piece 3: mesh-auth.js ──────────────────────────────────────────────────

describe('Piece 3: MeshAuth', () => {
  const MeshAuth = require('../daemon/mesh-auth')

  it('generates 8-char invite codes in XXXX-XXXX format', () => {
    const a = new MeshAuth()
    const invite = a.generateInvite()
    assert.ok(invite.code)
    assert.match(invite.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    assert.ok(invite.expiresAt)
  })

  it('generates unique codes', () => {
    const a = new MeshAuth()
    const codes = new Set()
    for (let i = 0; i < 20; i++) {
      codes.add(a.generateInvite().code)
    }
    assert.equal(codes.size, 20)
  })

  it('accepts valid invite and returns PSK', () => {
    const a = new MeshAuth()
    const invite = a.generateInvite()
    const result = a.acceptInvite(invite.code, 'peer-node')

    assert.ok(result.psk)
    assert.equal(result.psk.length, 64) // 32 bytes hex
    assert.ok(a.isAuthorized(result.psk))
  })

  it('rejects invalid code', () => {
    const a = new MeshAuth()
    assert.throws(() => a.acceptInvite('XXXX-XXXX'), /Invalid or expired/)
  })

  it('rejects reused code (single-use)', () => {
    const a = new MeshAuth()
    const invite = a.generateInvite()
    a.acceptInvite(invite.code, 'peer')
    assert.throws(() => a.acceptInvite(invite.code, 'peer2'), /Invalid or expired/)
  })

  it('stores peer key after accept', () => {
    const a = new MeshAuth()
    const invite = a.generateInvite()
    const result = a.acceptInvite(invite.code, 'peer-node')
    assert.equal(a.getPeerKey('peer-node'), result.psk)
  })

  it('middleware rejects missing X-Mesh-Key', () => {
    const a = new MeshAuth()
    const mw = a.middleware()
    let statusCode = null
    let body = null
    const req = { headers: {} }
    const res = { status: (s) => { statusCode = s; return { json: (b) => { body = b } } } }
    const next = () => { statusCode = 200 }

    mw(req, res, next)
    assert.equal(statusCode, 403)
    assert.ok(body.error.includes('Unauthorized'))
  })

  it('middleware passes valid X-Mesh-Key', () => {
    const a = new MeshAuth()
    const invite = a.generateInvite()
    const { psk } = a.acceptInvite(invite.code, 'peer')

    const mw = a.middleware()
    let passed = false
    const req = { headers: { 'x-mesh-key': psk } }
    const res = { status: () => ({ json: () => {} }) }
    const next = () => { passed = true }

    mw(req, res, next)
    assert.ok(passed)
  })
})

// ─── Piece 4: mesh-dispatch.js ──────────────────────────────────────────────

describe('Piece 4: MeshDispatch', () => {
  const MeshRegistry = require('../daemon/mesh-registry')
  const MeshAuth = require('../daemon/mesh-auth')
  const MeshDispatch = require('../daemon/mesh-dispatch')

  it('rejects dispatch to unknown peer', async () => {
    const r = new MeshRegistry({ ownNodeName: 'self' })
    const a = new MeshAuth()
    const d = new MeshDispatch({ registry: r, auth: a, ownNodeName: 'self' })

    await assert.rejects(() => d.dispatchToPeer('unknown', { type: 'test', prompt: 'hi' }), /Unknown peer/)
  })

  it('rejects dispatch to offline peer', async () => {
    const r = new MeshRegistry({ ownNodeName: 'self' })
    const a = new MeshAuth()
    r.addPeer('node-b', '127.0.0.1', 9999)
    r.updatePeerStatus('node-b', 'offline')
    const d = new MeshDispatch({ registry: r, auth: a, ownNodeName: 'self' })

    await assert.rejects(() => d.dispatchToPeer('node-b', { type: 'test', prompt: 'hi' }), /offline/)
  })

  it('rejects dispatch to unpaired peer', async () => {
    const r = new MeshRegistry({ ownNodeName: 'self' })
    r.peers.clear()
    const a = new MeshAuth()
    // Clear any persisted keys from disk
    a._authorizedKeys.clear()
    a._peerKeys.clear()
    r.addPeer('node-b', '127.0.0.1', 9999)
    r.updatePeerStatus('node-b', 'online')
    // No PSK set — peer is discovered but not paired
    const d = new MeshDispatch({ registry: r, auth: a, ownNodeName: 'self' })

    await assert.rejects(() => d.dispatchToPeer('node-b', { type: 'test', prompt: 'hi' }), /pair first/)
  })

  it('tracks task status', () => {
    const r = new MeshRegistry({ ownNodeName: 'self' })
    const a = new MeshAuth()
    const d = new MeshDispatch({ registry: r, auth: a, ownNodeName: 'self' })

    d.trackTask('task-1', 'accepted')
    assert.equal(d.getTaskStatus('task-1').status, 'accepted')

    d.trackTask('task-1', 'completed', { output: 'done' })
    assert.equal(d.getTaskStatus('task-1').status, 'completed')
    assert.equal(d.getTaskStatus('task-1').result.output, 'done')
  })

  it('dispatchToBest rejects when no online peers', async () => {
    const r = new MeshRegistry({ ownNodeName: 'self' })
    const a = new MeshAuth()
    const d = new MeshDispatch({ registry: r, auth: a, ownNodeName: 'self' })

    await assert.rejects(() => d.dispatchToBest({ type: 'test', prompt: 'hi' }), /No online peers/)
  })
})

// ─── Piece 5: mesh-chat.js ──────────────────────────────────────────────────

describe('Piece 5: MeshChat', () => {
  const MeshRegistry = require('../daemon/mesh-registry')
  const MeshAuth = require('../daemon/mesh-auth')
  const MeshChat = require('../daemon/mesh-chat')

  it('stores received messages', () => {
    const r = new MeshRegistry({ ownNodeName: 'self' })
    const a = new MeshAuth()
    const c = new MeshChat({ registry: r, auth: a, ownNodeName: 'self' })

    c.receiveMessage({ id: '1', from: 'peer', to: 'self', text: 'hello', timestamp: new Date().toISOString() })
    c.receiveMessage({ id: '2', from: 'peer', to: 'self', text: 'world', timestamp: new Date().toISOString() })

    assert.equal(c.getMessages().length, 2)
  })

  it('filters by peer', () => {
    const r = new MeshRegistry({ ownNodeName: 'self' })
    const a = new MeshAuth()
    const c = new MeshChat({ registry: r, auth: a, ownNodeName: 'self' })

    c.receiveMessage({ id: '1', from: 'alice', to: 'self', text: 'hi', timestamp: new Date().toISOString() })
    c.receiveMessage({ id: '2', from: 'bob', to: 'self', text: 'hey', timestamp: new Date().toISOString() })

    assert.equal(c.getConversation('alice').length, 1)
    assert.equal(c.getConversation('bob').length, 1)
  })

  it('filters by timestamp', () => {
    const r = new MeshRegistry({ ownNodeName: 'self' })
    const a = new MeshAuth()
    const c = new MeshChat({ registry: r, auth: a, ownNodeName: 'self' })

    const old = new Date(Date.now() - 60000).toISOString()
    const recent = new Date().toISOString()

    c.receiveMessage({ id: '1', from: 'peer', to: 'self', text: 'old', timestamp: old })
    c.receiveMessage({ id: '2', from: 'peer', to: 'self', text: 'new', timestamp: recent })

    const since = new Date(Date.now() - 30000).toISOString()
    const msgs = c.getMessages({ since })
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].text, 'new')
  })

  it('ring buffer caps at 500 messages', () => {
    const r = new MeshRegistry({ ownNodeName: 'self' })
    const a = new MeshAuth()
    const c = new MeshChat({ registry: r, auth: a, ownNodeName: 'self' })

    for (let i = 0; i < 550; i++) {
      c.receiveMessage({ id: `${i}`, from: 'peer', to: 'self', text: `msg ${i}`, timestamp: new Date().toISOString() })
    }
    assert.equal(c.getMessages().length, 500)
  })

  it('long-poll resolves on new message', async () => {
    const r = new MeshRegistry({ ownNodeName: 'self' })
    const a = new MeshAuth()
    const c = new MeshChat({ registry: r, auth: a, ownNodeName: 'self' })

    // Start waiting
    const promise = c.waitForMessage(2000)

    // Deliver a message after 50ms
    setTimeout(() => {
      c.receiveMessage({ id: '1', from: 'peer', to: 'self', text: 'hello', timestamp: new Date().toISOString() })
    }, 50)

    const msg = await promise
    assert.ok(msg)
    assert.equal(msg.text, 'hello')
  })

  it('long-poll returns null on timeout', async () => {
    const r = new MeshRegistry({ ownNodeName: 'self' })
    const a = new MeshAuth()
    const c = new MeshChat({ registry: r, auth: a, ownNodeName: 'self' })

    const msg = await c.waitForMessage(100) // 100ms timeout
    assert.equal(msg, null)
  })
})

// ─── Piece 6: mesh-energy.js ────────────────────────────────────────────────

describe('Piece 6: MeshEnergy', () => {
  const MeshRegistry = require('../daemon/mesh-registry')
  const MeshAuth = require('../daemon/mesh-auth')
  const MeshEnergy = require('../daemon/mesh-energy')

  it('stores received alerts', () => {
    const r = new MeshRegistry({ ownNodeName: 'self' })
    const a = new MeshAuth()
    const rm = new MockResourceMonitor()
    const e = new MeshEnergy({ registry: r, auth: a, resourceMonitor: rm, ownNodeName: 'self' })

    e.receiveAlert({ node: 'peer', level: 'hibernating', battery_pct: 5 })
    assert.equal(e.getAlerts().length, 1)
    assert.equal(e.getAlerts()[0].node, 'peer')
    assert.ok(e.getAlerts()[0].received_at)
  })

  it('caps alerts at 50', () => {
    const r = new MeshRegistry({ ownNodeName: 'self' })
    const a = new MeshAuth()
    const rm = new MockResourceMonitor()
    const e = new MeshEnergy({ registry: r, auth: a, resourceMonitor: rm, ownNodeName: 'self' })

    for (let i = 0; i < 60; i++) {
      e.receiveAlert({ node: 'peer', level: 'overloaded', battery_pct: 10 })
    }
    assert.equal(e.getAlerts().length, 50)
  })

  it('start and stop are idempotent', () => {
    const r = new MeshRegistry({ ownNodeName: 'self' })
    const a = new MeshAuth()
    const rm = new MockResourceMonitor()
    const e = new MeshEnergy({ registry: r, auth: a, resourceMonitor: rm, ownNodeName: 'self' })

    e.start()
    e.start() // no-op
    assert.equal(rm.listenerCount('capacity-changed'), 1)

    e.stop()
    e.stop() // no-op
    assert.equal(rm.listenerCount('capacity-changed'), 0)
  })
})

// ─── End-to-End: Two nodes on localhost ─────────────────────────────────────

describe('End-to-End: Two mesh nodes', () => {
  let serverA, serverB, modsA, modsB
  // Use random high ports to avoid collisions between test runs
  let PORT_A, PORT_B

  beforeEach(async () => {
    PORT_A = 13200 + Math.floor(Math.random() * 1000)
    PORT_B = PORT_A + 1
    modsA = createMeshModules('node-a')
    modsB = createMeshModules('node-b')
    // Clear any persisted peers from disk to isolate tests
    modsA.registry.peers.clear()
    modsB.registry.peers.clear()
    serverA = await startMeshServer(PORT_A, modsA)
    serverB = await startMeshServer(PORT_B, modsB)
  })

  afterEach(async () => {
    if (serverA) await new Promise(r => serverA.close(r))
    if (serverB) await new Promise(r => serverB.close(r))
    serverA = null
    serverB = null
  })

  // ── Discovery & Registry ────────────────────────────────────────

  it('nodes can see each other via manual peer add', async () => {
    // Node A adds Node B manually
    const res = await httpPost('127.0.0.1', PORT_A, '/mesh/peers', { host: '127.0.0.1', port: PORT_B })
    assert.equal(res.status, 200)

    // Node A lists peers
    const list = await httpGet('127.0.0.1', PORT_A, '/mesh/peers')
    assert.equal(list.body.peers.length, 1)
    assert.equal(list.body.peers[0].host, '127.0.0.1')
  })

  it('registry health check detects online peer', async () => {
    // Node A adds Node B
    modsA.registry.addPeer('node-b', '127.0.0.1', PORT_B, 'manual')

    // Run one health poll cycle
    await modsA.registry._pollAll()

    const peer = modsA.registry.getPeer('node-b')
    assert.equal(peer.status, 'online')
    assert.ok(peer.capacity.level)
    assert.equal(peer.capacity.level, 'idle')
  })

  it('registry detects offline peer', async () => {
    modsA.registry.addPeer('ghost', '127.0.0.1', 19999, 'manual')
    await modsA.registry._pollAll()
    assert.equal(modsA.registry.getPeer('ghost').status, 'offline')
  })

  // ── Pairing ─────────────────────────────────────────────────────

  it('full pairing flow between two nodes', async () => {
    // Node A generates invite
    const inviteRes = await httpPost('127.0.0.1', PORT_A, '/mesh/invite', {})
    assert.equal(inviteRes.status, 200)
    assert.match(inviteRes.body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/)

    const code = inviteRes.body.code

    // Node B accepts the invite on Node A's server
    const pairRes = await httpPost('127.0.0.1', PORT_A, '/mesh/pair', { code, node_name: 'node-b' })
    assert.equal(pairRes.status, 200)
    assert.ok(pairRes.body.psk)
    assert.equal(pairRes.body.peer_name, 'node-a')

    const psk = pairRes.body.psk

    // Node A's auth module has the PSK authorized
    assert.ok(modsA.auth.isAuthorized(psk))

    // Node A's registry knows node-b with the PSK (set by /mesh/pair handler)
    // Note: node-b must first be added to registry for the PSK to be stored
    // The /mesh/pair handler calls registry.setPeerKey which only works if peer exists
    // So in practice, mDNS discovery or manual add happens first
    modsA.registry.addPeer('node-b', '127.0.0.1', PORT_B, 'manual')
    modsA.registry.setPeerKey('node-b', psk)

    // Node B stores the PSK for Node A
    modsB.auth.addAuthorizedKey(psk, 'node-a')
    modsB.registry.addPeer('node-a', '127.0.0.1', PORT_A, 'manual')
    modsB.registry.setPeerKey('node-a', psk)

    // Verify both sides can now authenticate
    assert.ok(modsA.auth.isAuthorized(psk))
    assert.ok(modsB.auth.isAuthorized(psk))
    assert.equal(modsA.registry.getPeer('node-b').psk, psk)
    assert.equal(modsB.registry.getPeer('node-a').psk, psk)
  })

  // ── Task Dispatch ───────────────────────────────────────────────

  it('dispatches task from node A to node B via HTTP', async () => {
    // Setup: pair the nodes
    const invite = modsA.auth.generateInvite()
    const { psk } = modsA.auth.acceptInvite(invite.code, 'node-b')

    // Register peers
    modsA.registry.addPeer('node-b', '127.0.0.1', PORT_B, 'manual')
    modsA.registry.setPeerKey('node-b', psk)
    modsA.registry.updatePeerStatus('node-b', 'online')

    modsB.auth.addAuthorizedKey(psk, 'node-a')

    // Dispatch task
    const result = await modsA.dispatch.dispatchToPeer('node-b', {
      type: 'code_generation',
      prompt: 'hello world'
    })

    assert.ok(result.task_id)
    assert.equal(result.status, 'accepted')

    // Wait for async completion
    await new Promise(r => setTimeout(r, 200))

    // Check status on Node B
    const statusRes = await httpGet('127.0.0.1', PORT_B, `/mesh/task/${result.task_id}/status`)
    assert.equal(statusRes.status, 200)
    assert.equal(statusRes.body.status, 'completed')
    assert.equal(statusRes.body.result.output, 'executed: hello world')
  })

  it('rejects task dispatch without valid PSK', async () => {
    const res = await httpPost('127.0.0.1', PORT_B, '/mesh/task',
      { type: 'test', prompt: 'hack' },
      { 'X-Mesh-Key': 'invalid-key' }
    )
    assert.equal(res.status, 403)
  })

  // ── Chat ────────────────────────────────────────────────────────

  it('sends chat message from node A to node B', async () => {
    // Pair
    const invite = modsA.auth.generateInvite()
    const { psk } = modsA.auth.acceptInvite(invite.code, 'node-b')
    modsA.registry.addPeer('node-b', '127.0.0.1', PORT_B, 'manual')
    modsA.registry.setPeerKey('node-b', psk)
    modsA.registry.updatePeerStatus('node-b', 'online')
    modsB.auth.addAuthorizedKey(psk, 'node-a')

    // Send message
    const msg = await modsA.chat.sendMessage('node-b', 'Hey from the campsite!')
    assert.ok(msg.id)
    assert.equal(msg.text, 'Hey from the campsite!')

    // Verify Node B received it
    const chatRes = await httpGet('127.0.0.1', PORT_B, '/mesh/chat')
    assert.equal(chatRes.body.messages.length, 1)
    assert.equal(chatRes.body.messages[0].text, 'Hey from the campsite!')
    assert.equal(chatRes.body.messages[0].from, 'node-a')
  })

  it('chat message stored locally on sender too', async () => {
    const invite = modsA.auth.generateInvite()
    const { psk } = modsA.auth.acceptInvite(invite.code, 'node-b')
    modsA.registry.addPeer('node-b', '127.0.0.1', PORT_B, 'manual')
    modsA.registry.setPeerKey('node-b', psk)
    modsA.registry.updatePeerStatus('node-b', 'online')
    modsB.auth.addAuthorizedKey(psk, 'node-a')

    await modsA.chat.sendMessage('node-b', 'test')

    // Sender also has the message locally
    const local = modsA.chat.getMessages()
    assert.equal(local.length, 1)
    assert.equal(local[0].from, 'node-a')
    assert.equal(local[0].to, 'node-b')
  })

  it('rejects chat without valid PSK', async () => {
    const res = await httpPost('127.0.0.1', PORT_B, '/mesh/chat',
      { text: 'sneaky', from: 'hacker', timestamp: new Date().toISOString() },
      { 'X-Mesh-Key': 'bad-key' }
    )
    assert.equal(res.status, 403)
  })

  // ── Energy Alerts ───────────────────────────────────────────────

  it('energy alert sent via HTTP to paired peer', async () => {
    // Pair
    const invite = modsA.auth.generateInvite()
    const { psk } = modsA.auth.acceptInvite(invite.code, 'node-b')
    modsA.registry.addPeer('node-b', '127.0.0.1', PORT_B, 'manual')
    modsA.registry.setPeerKey('node-b', psk)
    modsA.registry.updatePeerStatus('node-b', 'online')
    modsB.auth.addAuthorizedKey(psk, 'node-a')

    // Start energy monitoring on Node A
    modsA.energy.start()

    // Simulate capacity transition to hibernating
    modsA.resourceMonitor.emitCapacityChange('hibernating', 'idle', { battery_pct: 5, cpu_pct: 10 })

    // Wait for broadcast
    await new Promise(r => setTimeout(r, 200))

    // Node B should have received the alert
    const alerts = modsB.energy.getAlerts()
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0].node, 'node-a')
    assert.equal(alerts[0].level, 'hibernating')
    assert.equal(alerts[0].battery_pct, 5)

    modsA.energy.stop()
  })

  it('energy alert NOT sent for non-critical transitions', async () => {
    const invite = modsA.auth.generateInvite()
    const { psk } = modsA.auth.acceptInvite(invite.code, 'node-b')
    modsA.registry.addPeer('node-b', '127.0.0.1', PORT_B, 'manual')
    modsA.registry.setPeerKey('node-b', psk)
    modsA.registry.updatePeerStatus('node-b', 'online')
    modsB.auth.addAuthorizedKey(psk, 'node-a')

    modsA.energy.start()

    // idle → light (not critical)
    modsA.resourceMonitor.emitCapacityChange('light', 'idle', { battery_pct: 80 })

    await new Promise(r => setTimeout(r, 200))

    // No alert should have been sent
    assert.equal(modsB.energy.getAlerts().length, 0)

    modsA.energy.stop()
  })

  // ── Full Flow ───────────────────────────────────────────────────

  it('complete offline collaboration flow: pair → chat → dispatch → energy', async () => {
    // 1. Pair
    const invite = modsA.auth.generateInvite()
    const { psk } = modsA.auth.acceptInvite(invite.code, 'node-b')

    modsA.registry.addPeer('node-b', '127.0.0.1', PORT_B, 'manual')
    modsA.registry.setPeerKey('node-b', psk)
    modsA.registry.updatePeerStatus('node-b', 'online')

    modsB.auth.addAuthorizedKey(psk, 'node-a')
    modsB.registry.addPeer('node-a', '127.0.0.1', PORT_A, 'manual')
    modsB.registry.setPeerKey('node-a', psk)
    modsB.registry.updatePeerStatus('node-a', 'online')

    // 2. Chat both directions
    await modsA.chat.sendMessage('node-b', 'Hey, can you run this?')
    await modsB.chat.sendMessage('node-a', 'Sure, sending it now')

    assert.equal(modsA.chat.getMessages().length, 2) // sent + received
    assert.equal(modsB.chat.getMessages().length, 2)

    // 3. Dispatch task A → B
    const taskResult = await modsA.dispatch.dispatchToPeer('node-b', {
      type: 'code_generation',
      prompt: 'build a campfire tracker'
    })
    assert.ok(taskResult.task_id)

    // 4. Wait for completion + verify
    await new Promise(r => setTimeout(r, 200))
    const status = await httpGet('127.0.0.1', PORT_B, `/mesh/task/${taskResult.task_id}/status`)
    assert.equal(status.body.status, 'completed')

    // 5. Energy alert
    modsA.energy.start()
    modsA.resourceMonitor.emitCapacityChange('hibernating', 'idle', { battery_pct: 3 })
    await new Promise(r => setTimeout(r, 200))
    assert.equal(modsB.energy.getAlerts().length, 1)
    modsA.energy.stop()

    // 6. Dispatch B → A (bidirectional)
    const taskResult2 = await modsB.dispatch.dispatchToPeer('node-a', {
      type: 'code_generation',
      prompt: 'check the weather'
    })
    assert.ok(taskResult2.task_id)
    await new Promise(r => setTimeout(r, 200))
    const status2 = await httpGet('127.0.0.1', PORT_A, `/mesh/task/${taskResult2.task_id}/status`)
    assert.equal(status2.body.status, 'completed')
  })
})
