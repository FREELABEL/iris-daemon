// A peer that answers /health is UP. It is not "offline" because a second,
// different endpoint failed.
//
// The poll loop assigned `peer.status = 'online'` in the middle of a try block,
// BEFORE a second request that can throw. So when /capacity failed the catch
// saw the status this same iteration had just written, treated it as a
// transition, and logged "went offline" — on every poll, forever, while
// marking a reachable peer offline.
//
// Measured on this machine before the fix: 61,860 "went offline" lines in
// daemon.stdout.log, 44,002 of them for ONE peer. At the 15s poll interval that
// is not flapping, it is every single poll for a week.
//
// Two assertions, because there are two defects: the peer must be ONLINE
// (routing reads this), and the transition log must fire ONCE (observability).

const test = require('node:test')
const assert = require('node:assert')
const http = require('http')
const MeshRegistry = require('../daemon/mesh-registry.js')

// A peer that is healthy but does not serve /capacity — the exact live shape.
function healthyButNoCapacity () {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.endsWith('/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', node_id: 'peer-under-test' }))
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('not found')
      }
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

// A peer that is genuinely down — nothing listening at all.
function deadPeerPort () {
  return new Promise((resolve) => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
  })
}

function registryWith (peer) {
  const reg = new MeshRegistry({ ownNodeName: 'test-node' })
  reg.peers = new Map()
  reg.save = () => {}                 // never touch the real ~/.iris/mesh-peers.json
  reg.peers.set(peer.name, peer)
  return reg
}

async function pollCountingOfflineLogs (reg, times) {
  let offlineLogs = 0
  const realLog = console.log
  console.log = (...a) => { if (String(a[0]).includes('went offline')) offlineLogs++ }
  try {
    for (let i = 0; i < times; i++) await reg._pollAll()
  } finally {
    console.log = realLog
  }
  return offlineLogs
}

test('a peer serving /health but not /capacity stays ONLINE', async () => {
  const server = await healthyButNoCapacity()
  try {
    const reg = registryWith({
      name: 'peer-under-test', host: '127.0.0.1', port: server.address().port,
      prefix: '', status: 'unknown', capacity: {}, node_id: null
    })

    await pollCountingOfflineLogs(reg, 4)
    const peer = reg.peers.get('peer-under-test')

    assert.strictEqual(peer.status, 'online',
      'a peer that answered /health with 200 must not be recorded offline because /capacity 404d')
    assert.strictEqual(peer.node_id, 'peer-under-test',
      '/health was reached and parsed, so its node_id must be kept')
  } finally {
    server.close()
  }
})

test('a healthy peer whose /capacity fails logs no offline transition at all', async () => {
  const server = await healthyButNoCapacity()
  try {
    const reg = registryWith({
      name: 'peer-under-test', host: '127.0.0.1', port: server.address().port,
      prefix: '', status: 'unknown', capacity: {}, node_id: null
    })

    const offlineLogs = await pollCountingOfflineLogs(reg, 4)

    assert.strictEqual(offlineLogs, 0,
      `expected 0 "went offline" logs for a reachable peer, got ${offlineLogs} across 4 polls`)
  } finally {
    server.close()
  }
})

test('a genuinely unreachable peer goes offline and logs the transition ONCE', async () => {
  const port = await deadPeerPort()
  const reg = registryWith({
    name: 'dead-peer', host: '127.0.0.1', port,
    prefix: '', status: 'online', capacity: {}, node_id: 'dead'
  })

  const offlineLogs = await pollCountingOfflineLogs(reg, 5)
  const peer = reg.peers.get('dead-peer')

  // The other direction — without this, "log nothing ever" would pass the test above.
  assert.strictEqual(peer.status, 'offline', 'a peer with nothing listening must be marked offline')
  assert.strictEqual(offlineLogs, 1,
    `a single down-transition must log once, not once per poll; got ${offlineLogs} across 5 polls`)
})

test('a peer that recovers logs the down-transition again on the NEXT failure', async () => {
  // Guards against fixing the spam by latching a "logged once" flag forever,
  // which would silence a real second outage.
  const server = await healthyButNoCapacity()
  const port = server.address().port
  const reg = registryWith({
    name: 'flapper', host: '127.0.0.1', port,
    prefix: '', status: 'online', capacity: {}, node_id: null
  })

  await pollCountingOfflineLogs(reg, 1)                      // up
  assert.strictEqual(reg.peers.get('flapper').status, 'online')

  server.close()
  await new Promise((r) => setTimeout(r, 50))
  const down1 = await pollCountingOfflineLogs(reg, 2)        // down
  assert.strictEqual(down1, 1, 'first outage logs once')
  assert.strictEqual(reg.peers.get('flapper').status, 'offline')

  const server2 = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', node_id: 'flapper' }))
    })
    s.listen(port, '127.0.0.1', () => resolve(s))
  })
  await pollCountingOfflineLogs(reg, 1)                      // up again
  assert.strictEqual(reg.peers.get('flapper').status, 'online', 'peer must be able to come back')

  server2.close()
  await new Promise((r) => setTimeout(r, 50))
  const down2 = await pollCountingOfflineLogs(reg, 1)        // down again
  assert.strictEqual(down2, 1, 'a SECOND real outage must still be logged')
})
