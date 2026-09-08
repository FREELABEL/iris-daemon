'use strict'

// Tests for the HIVE remote/cloud node dispatch gate (bug #157523).
// Covers the security gating (OFF by default, WAN hard-gate) and the two
// reused transports (LAN mesh peer, hub re-dispatch) without spawning tmux.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const { TaskExecutor } = require('../daemon/task-executor')

// ── Mocks ──────────────────────────────────────────────────────────────────

/** Records submitResult/submitTask calls; never touches the network. */
function mockCloud () {
  const calls = { results: [], submitted: [] }
  return {
    calls,
    async submitResult (taskId, result) { calls.results.push({ taskId, result }) },
    async submitTask (data) { calls.submitted.push(data); return { task: { id: 'cloud-task-1' } } },
    async reportProgress () {},
  }
}

/** Minimal workspace manager — the gate runs before any workspace is created. */
const mockWorkspaces = { dataDir: '/tmp', create () { return { dir: '/tmp', projectDir: '/tmp' } }, cleanup () {} }

/** Mesh dispatch double with a tiny in-memory registry. */
function mockMesh (peers = []) {
  const map = new Map(peers.map(p => [p.name, p]))
  const dispatched = []
  return {
    dispatched,
    registry: {
      getPeer: (name) => map.get(name) || null,
      getAllPeers: () => [...map.values()],
    },
    async dispatchToPeer (name, task) { dispatched.push({ name, task }); return { taskId: 'mesh-task-1' } },
  }
}

function makeExecutor () {
  const cloud = mockCloud()
  const ex = new TaskExecutor(cloud, mockWorkspaces)
  ex.nodeName = 'self-node'
  ex.nodeId = 'self-id'
  return { ex, cloud }
}

const noopCleanup = () => {}

describe('remote-dispatch gate (#157523)', () => {
  const savedEnv = { ...process.env }
  beforeEach(() => {
    delete process.env.HIVE_REMOTE_DISPATCH
    delete process.env.HIVE_REMOTE_DISPATCH_WAN
  })
  afterEach(() => { process.env = { ...savedEnv } })

  it('runs locally when no target_node is set', async () => {
    const { ex } = makeExecutor()
    const routed = await ex._maybeRouteRemote({ id: 't1', type: 'message', config: {} }, noopCleanup)
    assert.equal(routed, false)
  })

  it('runs locally when task targets self', async () => {
    const { ex } = makeExecutor()
    const routed = await ex._maybeRouteRemote({ id: 't1', type: 'message', config: { target_node: 'self-node' } }, noopCleanup)
    assert.equal(routed, false)
  })

  it('rejects (handled) when target set but HIVE_REMOTE_DISPATCH is OFF', async () => {
    const { ex, cloud } = makeExecutor()
    const routed = await ex._maybeRouteRemote({ id: 't1', type: 'message', config: { target_node: 'box-a' } }, noopCleanup)
    assert.equal(routed, true)
    assert.equal(cloud.calls.results.length, 1)
    assert.equal(cloud.calls.results[0].result.status, 'failed')
    assert.match(cloud.calls.results[0].result.error, /disabled/)
  })

  it('routes to an online paired LAN mesh peer when enabled', async () => {
    const { ex, cloud } = makeExecutor()
    process.env.HIVE_REMOTE_DISPATCH = '1'
    ex.meshDispatch = mockMesh([{ name: 'box-a', node_id: 'na', status: 'online' }])
    const routed = await ex._maybeRouteRemote({ id: 't1', type: 'code_generation', prompt: 'hi', config: { target_node: 'box-a' } }, noopCleanup)
    assert.equal(routed, true)
    assert.equal(ex.meshDispatch.dispatched.length, 1)
    assert.equal(ex.meshDispatch.dispatched[0].name, 'box-a')
    assert.equal(cloud.calls.results[0].result.status, 'completed')
    assert.equal(cloud.calls.results[0].result.delegated, true)
  })

  it('resolves a mesh peer by node_id as well as name', async () => {
    const { ex } = makeExecutor()
    process.env.HIVE_REMOTE_DISPATCH = '1'
    ex.meshDispatch = mockMesh([{ name: 'box-a', node_id: 'node-xyz', status: 'online' }])
    const routed = await ex._maybeRouteRemote({ id: 't1', type: 'code_generation', config: { target_node: 'node-xyz' } }, noopCleanup)
    assert.equal(routed, true)
    assert.equal(ex.meshDispatch.dispatched[0].name, 'box-a')
  })

  it('BLOCKS cloud/WAN hub dispatch unless HIVE_REMOTE_DISPATCH_WAN is set', async () => {
    const { ex, cloud } = makeExecutor()
    process.env.HIVE_REMOTE_DISPATCH = '1' // master on, WAN off
    ex.meshDispatch = mockMesh([]) // target is NOT a known LAN peer
    const routed = await ex._maybeRouteRemote({ id: 't1', type: 'code_generation', config: { target_node: 'droplet-42' } }, noopCleanup)
    assert.equal(routed, true)
    assert.equal(cloud.calls.submitted.length, 0, 'must NOT re-dispatch to hub')
    assert.equal(cloud.calls.results[0].result.status, 'failed')
    assert.match(cloud.calls.results[0].result.error, /157524|157525|BLOCKED/)
  })

  it('re-dispatches to a cloud node via hub when WAN flag is set', async () => {
    const { ex, cloud } = makeExecutor()
    process.env.HIVE_REMOTE_DISPATCH = '1'
    process.env.HIVE_REMOTE_DISPATCH_WAN = '1'
    ex.meshDispatch = mockMesh([])
    const routed = await ex._maybeRouteRemote({ id: 't1', type: 'code_generation', prompt: 'go', config: { target_node: 'droplet-42', foo: 'bar' } }, noopCleanup)
    assert.equal(routed, true)
    assert.equal(cloud.calls.submitted.length, 1)
    assert.equal(cloud.calls.submitted[0].node_id, 'droplet-42')
    // routing keys stripped so the cloud node does not bounce it again
    assert.equal(cloud.calls.submitted[0].config.target_node, undefined)
    assert.equal(cloud.calls.submitted[0].config.foo, 'bar')
    assert.equal(cloud.calls.results[0].result.status, 'completed')
  })
})
