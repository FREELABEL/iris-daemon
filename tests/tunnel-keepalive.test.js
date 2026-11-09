'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { TunnelKeepAlive, decideTunnelRestart, backoffMs, pickNode, BASE_DELAY_MS, MAX_DELAY_MS, STABLE_MS } = require('../daemon/tunnel-keepalive')

// #192752 — the model tunnel on iris-hive-001 died twice and nothing brought it back.
const ON = { enabled: true, port: 3290, node: '/n20/bin/node', tunnel: { name: 'box-ai', runner: '/r/tunnel.js' } }
const fresh = { failures: 0, lastRestartAt: 0 }

test('enabled + no process → restart', () => {
  const d = decideTunnelRestart({ settings: ON, alive: false, now: 1000, state: fresh })
  assert.strictEqual(d.action, 'restart')
  assert.deepStrictEqual(d.state, { failures: 1, lastRestartAt: 1000 })
})

test('disabled → never restart, and backoff is forgotten', () => {
  const d = decideTunnelRestart({ settings: { ...ON, enabled: false }, alive: false, now: 1000, state: { failures: 5, lastRestartAt: 1 } })
  assert.strictEqual(d.action, 'none')
  assert.deepStrictEqual(d.state, fresh)
})

test('enabled but serve on never recorded a tunnel → not ours to start', () => {
  assert.strictEqual(decideTunnelRestart({ settings: { enabled: true }, alive: false, now: 1, state: fresh }).action, 'none')
})

test('running → nothing to do', () => {
  assert.strictEqual(decideTunnelRestart({ settings: ON, alive: true, now: 1, state: fresh }).action, 'none')
})

test('backoff: 0, 15 s, 30 s, 60 s … capped at 10 min', () => {
  assert.strictEqual(backoffMs(0), 0)
  assert.strictEqual(backoffMs(1), BASE_DELAY_MS)
  assert.strictEqual(backoffMs(2), 2 * BASE_DELAY_MS)
  assert.strictEqual(backoffMs(3), 4 * BASE_DELAY_MS)
  assert.strictEqual(backoffMs(30), MAX_DELAY_MS)
})

test('a runner that keeps dying is restarted no faster than the backoff allows', () => {
  let state = fresh
  let now = 0
  const restarts = []
  for (; now <= 5 * 60_000; now += 15_000) {
    const d = decideTunnelRestart({ settings: ON, alive: false, now, state })
    state = d.state
    if (d.action === 'restart') restarts.push(now / 1000)
    else assert.strictEqual(d.action, 'wait')
  }
  // 0, +15, +30, +60, +120 seconds apart
  assert.deepStrictEqual(restarts, [0, 15, 45, 105, 225])
})

test('backoff resets once a restarted runner stays up', () => {
  const s = { failures: 4, lastRestartAt: 0 }
  assert.deepStrictEqual(decideTunnelRestart({ settings: ON, alive: true, now: STABLE_MS - 1, state: s }).state, s)
  assert.deepStrictEqual(decideTunnelRestart({ settings: ON, alive: true, now: STABLE_MS + 1, state: { failures: 4, lastRestartAt: 1 } }).state, fresh)
})

test('pickNode: the recorded node if ≥20, else the daemon\'s own if ≥20, never Node 18', () => {
  const v = { '/n20': 20, '/n18': 18, '/self22': 22, '/self18': 18 }
  const probe = (b) => v[b] ?? null
  assert.strictEqual(pickNode('/n20', { probe, self: '/self22' }), '/n20')
  assert.strictEqual(pickNode('/n18', { probe, self: '/self22' }), '/self22')
  assert.strictEqual(pickNode(null, { probe, self: '/self22' }), '/self22')
  assert.strictEqual(pickNode('/n18', { probe, self: '/self18' }), null)
})

test('tick restarts a dead tunnel with the recorded node, the node key, and logs one line', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-ka-'))
  fs.mkdirSync(path.join(home, '.iris', 'tunnels', 'box-ai'), { recursive: true })
  const runner = path.join(home, 'tunnel.js')
  fs.writeFileSync(runner, '')
  fs.writeFileSync(path.join(home, '.iris', 'inference.json'), JSON.stringify({ ...ON, tunnel: { name: 'box-ai', runner, zones: ['t.heyiris.io', 't.x.io'] } }))
  // a pid that is certainly not running
  fs.writeFileSync(path.join(home, '.iris', 'tunnels', 'box-ai', 'tunnel.pid'), '2147483646')
  const calls = []
  const logs = []
  const ka = new TunnelKeepAlive({
    home,
    getApiBase: () => 'https://api.example',
    getKey: () => 'node_live_abc',
    log: (m) => logs.push(m),
    probe: (b) => (b === '/n20/bin/node' ? 20 : 18),
    now: () => 1000,
    spawnFn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return Object.assign(new EventEmitter(), { pid: process.pid, unref () {} }) }
  })
  assert.strictEqual(ka.tick().action, 'restart')
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].cmd, '/n20/bin/node')
  assert.deepStrictEqual(calls[0].args, [runner, '--name', 'box-ai', '--port', '3290'])
  assert.strictEqual(calls[0].opts.env.IRIS_API_KEY, 'node_live_abc')
  assert.strictEqual(calls[0].opts.env.IRIS_API_BASE, 'https://api.example')
  if (!process.env.HIVE_RELAY_ZONES) assert.strictEqual(calls[0].opts.env.HIVE_RELAY_ZONES, 't.heyiris.io,t.x.io')
  assert.strictEqual(logs.length, 1)
  assert.match(logs[0], /tunnel box-ai was not running — restarted/)
  assert.strictEqual(fs.readFileSync(path.join(home, '.iris', 'tunnels', 'box-ai', 'tunnel.pid'), 'utf8'), String(process.pid))
  // the recorded pid (this test process) is alive now → no second start
  assert.strictEqual(ka.tick().action, 'none')
  assert.strictEqual(calls.length, 1)
})
