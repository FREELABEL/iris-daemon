'use strict'
// #191614 — the daemon reports WHICH COMMIT it runs, and whether its files still match.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('../lib/version-manifest')

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

function tree (commit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-'))
  fs.mkdirSync(path.join(dir, 'lib'))
  fs.writeFileSync(path.join(dir, 'daemon.js'), 'console.log(1)\n')
  fs.writeFileSync(path.join(dir, 'lib', 'x.js'), 'module.exports = 1\n')
  fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'i.js'), '')
  if (commit) {
    fs.writeFileSync(path.join(dir, vm.MANIFEST_NAME), JSON.stringify({ schema: 1, commit, installed_at: '2026-10-28T00:00:00Z', files: vm.hashTree(dir) }))
  }
  return dir
}

test('no manifest reports unknown, honestly', () => {
  const r = vm.createReporter(tree(null)).report()
  assert.equal(r.daemon_commit, 'unknown')
  assert.equal(r.daemon_drift, 'unknown')
  assert.equal(vm.versionString('2.0.0', r), '2.0.0')
})

test('an unparseable or commit-less manifest is no manifest', () => {
  const dir = tree(null)
  fs.writeFileSync(path.join(dir, vm.MANIFEST_NAME), '{not json')
  assert.equal(vm.createReporter(dir).report().daemon_commit, 'unknown')
  fs.writeFileSync(path.join(dir, vm.MANIFEST_NAME), JSON.stringify({ commit: 'main', files: {} }))
  assert.equal(vm.createReporter(dir).report().daemon_commit, 'unknown')
})

test('a clean install reports its commit and no drift', () => {
  const dir = tree(SHA_A)
  const r = vm.createReporter(dir).report()
  assert.equal(r.daemon_commit, SHA_A)
  assert.equal(r.daemon_drift, false)
  assert.equal(vm.versionString('2.0.0', r), `2.0.0+${SHA_A}`)
})

test('hashTree skips node_modules, .git and the manifest itself', () => {
  const dir = tree(SHA_A)
  assert.deepEqual(Object.keys(vm.hashTree(dir)).sort(), ['daemon.js', 'lib/x.js'])
})

test('an edited or deleted shipped file is drift; a runtime file is not', () => {
  const dir = tree(SHA_A)
  fs.writeFileSync(path.join(dir, 'daemon.log'), 'runtime file, not drift')
  const m = vm.readManifest(dir)
  assert.equal(vm.checkDrift(dir, m).drift, false)
  fs.writeFileSync(path.join(dir, 'lib', 'x.js'), 'module.exports = 2\n')
  fs.unlinkSync(path.join(dir, 'daemon.js'))
  const d = vm.checkDrift(dir, m)
  assert.deepEqual(d, { drift: true, changed: ['lib/x.js'], missing: ['daemon.js'] })
  const r = vm.createReporter(dir).report()
  assert.equal(r.daemon_drift, true)
  assert.equal(vm.versionString('2.0.0', r), `2.0.0+${SHA_A}.drift`)
})

test('the commit is frozen at load: swapping the tree under a running process does not change what it reports', () => {
  // The updater renames bridge -> bridge.prev and bridge.next -> bridge while the old process
  // runs. If the old process re-read the manifest, it would report the NEW commit and the
  // updater's "is the new code running" check could never fail.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-swap-'))
  const live = path.join(parent, 'bridge')
  fs.renameSync(tree(SHA_A), live)
  let t = 0
  const rep = vm.createReporter(live, { now: () => t })
  assert.equal(rep.report().daemon_commit, SHA_A)
  fs.renameSync(live, path.join(parent, 'bridge.prev'))
  fs.renameSync(tree(SHA_B), live)
  fs.writeFileSync(path.join(live, 'daemon.js'), 'the new commit\'s code\n')
  t += 10 * 60 * 1000 // past the drift cache
  const r = rep.report()
  assert.equal(r.daemon_commit, SHA_A, 'still the commit this process loaded')
  assert.equal(r.daemon_drift, true, 'and the files on disk are no longer it')
})

test('drift is cached, then re-checked', () => {
  const dir = tree(SHA_A)
  let t = 0
  const rep = vm.createReporter(dir, { now: () => t })
  assert.equal(rep.report().daemon_drift, false)
  fs.writeFileSync(path.join(dir, 'daemon.js'), 'edited\n')
  assert.equal(rep.report().daemon_drift, false, 'cached within the TTL')
  t += 5 * 60 * 1000 + 1
  assert.equal(rep.report().daemon_drift, true)
})

test('the heartbeat and /health carry the version fields, and the commit is frozen at startup', () => {
  const root = path.join(__dirname, '..')
  const daemonIndex = fs.readFileSync(path.join(root, 'daemon', 'index.js'), 'utf8')
  assert.match(daemonIndex, /\.\.\.versionFields\(\)/)
  assert.match(daemonIndex, /daemon_commit: r\.daemon_commit, daemon_drift: r\.daemon_drift/)
  const bridge = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
  const health = bridge.slice(bridge.indexOf("app.get('/health'"), bridge.indexOf("app.get('/health'") + 1500)
  assert.match(health, /\.\.\.versionReport/)
  for (const f of ['daemon.js', 'index.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8')
    assert.match(src, /require\('\.\/lib\/version-manifest'\)\.running\(\) \} catch/, `${f} freezes the reporter at load`)
  }
})
