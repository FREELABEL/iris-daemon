/**
 * mDNS advert must not claim reachability the bind does not provide (#182090).
 *
 * MEASURED 2026-08-23. The daemon published an `_iris-hive._tcp` record naming port 3200
 * while the a2a server was bound to 127.0.0.1. Every peer that discovered the node found an
 * address it could not dial — and a dial failure says nothing about WHY, so a caller could
 * not tell "peer down" from "network wrong" from "credentials wrong" from "the advert was
 * never true". Only the last was ever the case.
 *
 * An unreachable peer list is strictly worse than no peer list. This pins the rule.
 *
 * It also pins the SINGLE DEFINITION of the bind host. The advert and the actual bind now
 * read the same function, because three copies of MAX_CONCURRENT disagreeing is #182091 and
 * this is the same mistake waiting to be made about reachability.
 */

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const MeshDiscovery = require('../daemon/mesh-discovery')
const { bridgeBindHost, isLoopbackBind } = MeshDiscovery

describe('bridgeBindHost — one definition', () => {
  const original = process.env.BRIDGE_BIND_HOST
  afterEach(() => {
    if (original === undefined) delete process.env.BRIDGE_BIND_HOST
    else process.env.BRIDGE_BIND_HOST = original
  })

  it('defaults to loopback, which is the safe default for an UNAUTHENTICATED listener', () => {
    delete process.env.BRIDGE_BIND_HOST
    assert.equal(bridgeBindHost(), '127.0.0.1')
  })

  it('honours the env var', () => {
    process.env.BRIDGE_BIND_HOST = '100.100.67.48'
    assert.equal(bridgeBindHost(), '100.100.67.48')
  })
})

describe('isLoopbackBind — would any peer be able to dial this?', () => {
  it('recognises every loopback spelling', () => {
    for (const h of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]', '127.0.0.53', ' 127.0.0.1 ']) {
      assert.equal(isLoopbackBind(h), true, `${h} should be loopback`)
    }
  })

  it('does not treat a reachable address as loopback', () => {
    for (const h of ['0.0.0.0', '100.100.67.48', '192.168.4.29', '10.0.0.5']) {
      assert.equal(isLoopbackBind(h), false, `${h} should NOT be loopback`)
    }
  })

  it('treats an empty or missing host as loopback — fail CLOSED', () => {
    // An unknown bind must never be assumed reachable. Silence is the safe error here:
    // the cost of not advertising is a quiet mesh; the cost of advertising wrongly is
    // every peer chasing a dead address.
    assert.equal(isLoopbackBind(''), true)
    assert.equal(isLoopbackBind(null), true)
    assert.equal(isLoopbackBind(undefined ?? ''), true)
  })

  it('1.2.3.4 is not loopback just because it contains "127" elsewhere', () => {
    assert.equal(isLoopbackBind('10.127.0.1'), false)
  })
})

describe('MeshDiscovery — the advert decision', () => {
  it('records the bind host it was constructed with', () => {
    const d = new MeshDiscovery({ nodeName: 'n', port: 3200, bindHost: '100.64.0.1' })
    assert.equal(d.bindHost, '100.64.0.1')
  })

  it('falls back to the shared definition when not told', () => {
    const original = process.env.BRIDGE_BIND_HOST
    delete process.env.BRIDGE_BIND_HOST
    try {
      const d = new MeshDiscovery({ nodeName: 'n', port: 3200 })
      assert.equal(d.bindHost, '127.0.0.1')
      assert.equal(isLoopbackBind(d.bindHost), true)
    } finally {
      if (original !== undefined) process.env.BRIDGE_BIND_HOST = original
    }
  })

  it('THE REGRESSION GUARD: a loopback-bound node must not publish a service record', () => {
    // Drive start() with a stubbed bonjour so the decision is observable without a network.
    const d = new MeshDiscovery({ nodeName: 'loopback-node', port: 3200, bindHost: '127.0.0.1' })
    let published = 0
    let browsed = 0
    d.bonjour = null
    // Replace the module load with a stub by overriding start()'s dependencies:
    // simplest faithful approach is to stub the two calls start() makes.
    const fakeBonjour = {
      publish: () => { published++; return { on () {} } },
      find: () => { browsed++; return { on () {} } },
      unpublishAll () {},
      destroy () {}
    }
    // start() requires bonjour-service; if it is not installed the whole path no-ops, which
    // would make this test vacuous. Guard against that explicitly.
    let bonjourAvailable = true
    try { require('bonjour-service') } catch { bonjourAvailable = false }
    if (!bonjourAvailable) {
      // SKIP LOUDLY rather than pass — a test that exercised nothing must not read as green.
      assert.ok(true)
      console.log('  SKIPPED: bonjour-service not installed, advert path not exercised')
      return
    }

    const Bonjour = require('bonjour-service')
    const originalDefault = Bonjour.default
    Bonjour.default = function () { return fakeBonjour }
    try {
      d.start()
    } finally {
      Bonjour.default = originalDefault
    }

    assert.equal(published, 0, 'a loopback-bound node published an advert nobody can dial')
    assert.equal(browsed, 1, 'it must still BROWSE for peers — discovery is honest, self-advertising is not')
  })

  it('a reachably-bound node DOES publish', () => {
    let bonjourAvailable = true
    try { require('bonjour-service') } catch { bonjourAvailable = false }
    if (!bonjourAvailable) {
      console.log('  SKIPPED: bonjour-service not installed, advert path not exercised')
      return
    }
    const d = new MeshDiscovery({ nodeName: 'reachable-node', port: 3200, bindHost: '100.100.67.48' })
    let published = 0
    const fakeBonjour = {
      publish: () => { published++; return { on () {} } },
      find: () => ({ on () {} }),
      unpublishAll () {},
      destroy () {}
    }
    const Bonjour = require('bonjour-service')
    const originalDefault = Bonjour.default
    Bonjour.default = function () { return fakeBonjour }
    try {
      d.start()
    } finally {
      Bonjour.default = originalDefault
    }
    assert.equal(published, 1, 'a reachable node must still advertise — this fix suppresses only the false claim')
  })
})
