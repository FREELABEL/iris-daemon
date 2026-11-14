// #193519 — every heartbeat, goodbye and task claim carries this machine's fingerprint, so the hub
// can refuse another computer that holds a copy of this node's key.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { CloudClient } = require('../daemon/cloud-client')

const FP = 'a'.repeat(64)

function client (fp = FP) {
  const c = new CloudClient('https://hub.example', 'node_live_test')
  c._machineFingerprint = fp
  c.sent = []
  c.post = async (path, body) => { c.sent.push({ path, body }); return { ok: true } }
  return c
}

describe('node identity on the wire', () => {
  it('sends the fingerprint with every heartbeat', async () => {
    const c = client()
    await c.sendHeartbeat({ capacity: { max: 3 } })
    assert.equal(c.sent[0].path, '/api/v6/node-agent/heartbeat')
    assert.equal(c.sent[0].body.machine_fingerprint, FP)
    assert.deepEqual(c.sent[0].body.capacity, { max: 3 })
  })

  it('sends it with the goodbye, so an impostor cannot take the real node offline', async () => {
    const c = client()
    await c.markOffline()
    assert.equal(c.sent[0].body.going_offline, true)
    assert.equal(c.sent[0].body.machine_fingerprint, FP)
  })

  it('sends it when claiming a task, next to arrived_at', async () => {
    const c = client()
    await c.acceptTask('t1', { arrived_at: 'now' })
    assert.equal(c.sent[0].path, '/api/v6/node-agent/tasks/t1/accept')
    assert.equal(c.sent[0].body.machine_fingerprint, FP)
    assert.equal(c.sent[0].body.arrived_at, 'now')
  })

  it('omits the field (never sends null) where the hardware id cannot be read', async () => {
    const c = client(null)
    await c.sendHeartbeat({})
    assert.equal('machine_fingerprint' in c.sent[0].body, false)
  })

  it('computes the real fingerprint as 64 hex chars, or omits it', () => {
    const c = new CloudClient('https://hub.example', 'k')
    const id = c.identity()
    if (id.machine_fingerprint !== undefined) assert.match(id.machine_fingerprint, /^[a-f0-9]{64}$/)
  })
})
