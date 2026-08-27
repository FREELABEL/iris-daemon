'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

/**
 * Vault discovery must not block the daemon's event loop (#182371).
 *
 * ROOT CAUSE, captured on the real node by the fs probe:
 *
 *   [BLOCKED 1000ms across 2646 sync fs calls WITHOUT yielding]
 *      899ms  1334x  fs.readdirSync
 *      100ms  1310x  fs.statSync
 *     at walk (drivers/obsidian.js:55)      <- recursive
 *     at discoverVaults (obsidian.js:71)
 *     at Object.available (bridge-registry.js:104)
 *     at heartbeat.getStateCallback (daemon/index.js:328)   <- EVERY 30 SECONDS
 *
 * The walk was already depth-capped at 3, and the cap was not the problem. Running it on
 * every heartbeat was. `defaultSearchRoots()` includes the entire home directory plus
 * Dropbox and Google Drive; on a machine with real cloud-sync trees, depth 3 is thousands
 * of directories, and it ran twice a minute forever.
 *
 * While it ran the daemon answered nothing: no heartbeat, no loopback health, deaf to
 * SIGTERM — and the fleet showed it ONLINE, because the last beat before the block was
 * genuine.
 */
const { discoverVaults, _resetVaultCache } = require('../drivers/obsidian')

function makeTree (root, breadth, depth) {
  if (depth === 0) return
  for (let i = 0; i < breadth; i++) {
    const d = path.join(root, `d${i}`)
    fs.mkdirSync(d, { recursive: true })
    makeTree(d, breadth, depth - 1)
  }
}

test('a repeat call is served from cache, not re-walked', () => {
  // This is the fix that matters. The walk itself is fine occasionally; twice a minute
  // forever is what wedged the daemon.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-cache-'))
  makeTree(dir, 4, 3)
  _resetVaultCache()

  const t0 = process.hrtime.bigint()
  discoverVaults([dir])
  const coldMs = Number(process.hrtime.bigint() - t0) / 1e6

  const t1 = process.hrtime.bigint()
  discoverVaults([dir])
  const warmMs = Number(process.hrtime.bigint() - t1) / 1e6

  assert.ok(warmMs < coldMs / 5 || warmMs < 1,
    `second call must be cached: cold ${coldMs.toFixed(1)}ms vs warm ${warmMs.toFixed(1)}ms`)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the cache is keyed on the roots — different roots are not confused', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-a-'))
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-b-'))
  fs.mkdirSync(path.join(a, 'VaultA', '.obsidian'), { recursive: true })
  fs.mkdirSync(path.join(b, 'VaultB', '.obsidian'), { recursive: true })
  _resetVaultCache()

  const ra = discoverVaults([a])
  const rb = discoverVaults([b])
  assert.ok(ra.some((p) => p.includes('VaultA')), 'root A must find VaultA')
  assert.ok(rb.some((p) => p.includes('VaultB')), 'root B must NOT return the cached A result')
  assert.ok(!rb.some((p) => p.includes('VaultA')))

  fs.rmSync(a, { recursive: true, force: true })
  fs.rmSync(b, { recursive: true, force: true })
})

test('a cold walk stops at its DEADLINE rather than running unbounded', () => {
  // Caching removes the repeat cost; the deadline bounds the worst single walk. Without it,
  // the first heartbeat after every restart still blocks — which is exactly what the daemon
  // did on each of its ~100s restart cycles.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-deadline-'))
  makeTree(dir, 8, 4)
  _resetVaultCache()

  const t0 = process.hrtime.bigint()
  discoverVaults([dir], 3, { deadlineMs: 30 })
  const ms = Number(process.hrtime.bigint() - t0) / 1e6

  assert.ok(ms < 400, `walk must honour its deadline, took ${ms.toFixed(0)}ms`)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('it still finds a real vault', () => {
  // A bounded search that finds nothing would be a different bug.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-find-'))
  fs.mkdirSync(path.join(dir, 'Notes', '.obsidian'), { recursive: true })
  _resetVaultCache()
  const found = discoverVaults([dir])
  assert.ok(found.some((p) => p.endsWith('Notes')), `expected to find the vault, got ${JSON.stringify(found)}`)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('an unreadable root is survived, not thrown', () => {
  _resetVaultCache()
  assert.doesNotThrow(() => discoverVaults(['/definitely/not/a/path/here']))
})
