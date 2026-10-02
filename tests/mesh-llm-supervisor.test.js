const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')
const {
  MESH_BASE_URL, resolveMeshConfig, buildMeshArgs, meshEnv, parseInviteToken, MeshLlmSupervisor
} = require('../daemon/mesh-llm-supervisor')

const quiet = { log () {}, error () {} }
const dirs = []
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }) })
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-sup-')); dirs.push(d); return d }

// Real line from mesh-llm 0.77 (token shortened).
const INVITE_LINE = '{"event":"invite_token","level":"info","message":"invite token ready for mesh 49b4893a0dcf3327efe381a6d0c40be3: eyJpZCI6IjgzZDI2OWU2YzQ=","timestamp":"2026-10-02T17:30:28Z"}'

describe('settings', () => {
  it('off unless HIVE_MESH_LLM is set — the default changes nothing', () => {
    assert.equal(resolveMeshConfig({}), null)
    assert.equal(resolveMeshConfig({ HIVE_MESH_LLM: 'off' }), null)
  })
  it('serve needs a model file, client needs a mesh to join', () => {
    assert.throws(() => resolveMeshConfig({ HIVE_MESH_LLM: 'serve' }), /HIVE_MESH_LLM_GGUF/)
    assert.throws(() => resolveMeshConfig({ HIVE_MESH_LLM: 'client' }), /HIVE_MESH_LLM_JOIN_FILE/)
    assert.throws(() => resolveMeshConfig({ HIVE_MESH_LLM: 'host' }), /serve or client/)
  })
  it('defaults the context to what fits on a 16 GB Mac', () => {
    const c = resolveMeshConfig({ HIVE_MESH_LLM: 'serve', HIVE_MESH_LLM_GGUF: '/m.gguf' })
    assert.equal(c.ctx, 4096)
    assert.equal(c.parallel, 1)
    assert.equal(c.split, false)
  })
})

describe('the mesh-llm command', () => {
  it('serve: model, sizes, split, and the invite as a FILE, never on argv', () => {
    const args = buildMeshArgs(resolveMeshConfig({
      HIVE_MESH_LLM: 'serve', HIVE_MESH_LLM_GGUF: '/m.gguf', HIVE_MESH_LLM_SPLIT: '1', HIVE_MESH_LLM_JOIN_FILE: '/t'
    }))
    assert.deepEqual(args, ['--log-format', 'json', 'serve', '--gguf', '/m.gguf', '--ctx-size', '4096', '--parallel', '1', '--split', '--join-file', '/t'])
  })
  it('client: joins, loads nothing', () => {
    assert.deepEqual(buildMeshArgs(resolveMeshConfig({ HIVE_MESH_LLM: 'client', HIVE_MESH_LLM_JOIN_FILE: '/t' })),
      ['--log-format', 'json', 'client', '--join-file', '/t'])
  })
  it('carries the macOS 14 GPU fix on the child env, and only on macOS', () => {
    assert.match(meshEnv({}, 'darwin').DYLD_INSERT_LIBRARIES, /CoreGraphics/)
    assert.equal(meshEnv({}, 'linux').DYLD_INSERT_LIBRARIES, undefined)
    assert.equal(meshEnv({ DYLD_INSERT_LIBRARIES: '/x' }, 'darwin').DYLD_INSERT_LIBRARIES, '/x')
  })
  it('finds the invite in mesh-llm’s log', () => {
    assert.equal(parseInviteToken(INVITE_LINE), 'eyJpZCI6IjgzZDI2OWU2YzQ=')
    assert.equal(parseInviteToken('{"message":"model listing"}'), null)
  })
})

/** A stand-in for spawn(): records calls, hands back a child we can drive. */
function fakeSpawn () {
  const calls = []
  const fn = (bin, args, opts) => {
    const child = new EventEmitter()
    child.pid = 1000 + calls.length
    child.stdout = new PassThrough()
    child.killed = false
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', null, 'SIGTERM')) }
    calls.push({ bin, args, opts, child })
    return child
  }
  return { fn, calls }
}

describe('the supervisor', () => {
  function make (envExtra = {}, opts = {}) {
    const d = tmp()
    const env = { PATH: '', HIVE_MESH_LLM: 'serve', HIVE_MESH_LLM_GGUF: '/m.gguf', ...envExtra }
    const sp = fakeSpawn()
    const sup = new MeshLlmSupervisor({
      env, spawnFn: sp.fn, binary: '/usr/bin/true', log: quiet,
      inviteFile: path.join(d, 'invite'), logFile: path.join(d, 'logs', 'mesh.log'), ...opts
    })
    return { sup, env, sp, d }
  }

  it('does nothing when off', () => {
    const { sup, sp } = make({ HIVE_MESH_LLM: '' })
    assert.equal(sup.start(), false)
    assert.equal(sp.calls.length, 0)
  })

  it('starts mesh-llm and points this node’s local_llm at the mesh', () => {
    const { sup, env, sp } = make()
    assert.equal(sup.start(), true)
    assert.equal(sp.calls.length, 1)
    assert.equal(env.LOCAL_LLM_BASE_URL, MESH_BASE_URL)
    assert.equal(sp.calls[0].args[2], 'serve')
    sup.stop()
  })

  it('leaves an operator’s explicit LOCAL_LLM_BASE_URL alone', () => {
    const { sup, env } = make({ LOCAL_LLM_BASE_URL: 'http://gpu-box:8000/v1' })
    sup.start()
    assert.equal(env.LOCAL_LLM_BASE_URL, 'http://gpu-box:8000/v1')
    sup.stop()
  })

  it('saves the invite owner-only, and never into the daemon log', async () => {
    const lines = []
    const { sup, sp, d } = make({}, { log: { log: (m) => lines.push(m), error: (m) => lines.push(m) } })
    sup.start()
    sp.calls[0].child.stdout.write(INVITE_LINE + '\n')
    await new Promise((r) => setImmediate(r))
    const file = path.join(d, 'invite')
    assert.equal(fs.readFileSync(file, 'utf8').trim(), 'eyJpZCI6IjgzZDI2OWU2YzQ=')
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.ok(!lines.join('\n').includes('eyJpZCI6'), 'token must not reach the daemon log')
    sup.stop()
  })

  it('restarts mesh-llm when it dies, and not after stop()', async () => {
    const { sup, sp } = make({}, { maxBackoffMs: 10 })
    sup.start()
    sp.calls[0].child.emit('exit', 1, null)
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(sp.calls.length, 2, 'restarted')
    sup.stop()
    assert.equal(sp.calls[1].child.killed, true, 'stop() kills the running one')
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(sp.calls.length, 2, 'no restart after stop')
  })
})
