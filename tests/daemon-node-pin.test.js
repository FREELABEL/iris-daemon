const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// macOS grants Full Disk Access per executable FILE. The wrapper used to pick "the newest nvm
// node" on every start, so installing any newer Node moved the daemon onto a binary with no
// grant and Mail/Messages/Calendar went dark with nothing changed in IRIS (2026-10-03, a Mac
// with 17 nvm versions). These tests install a newer node and check the daemon does NOT move.

const WRAPPER = path.join(__dirname, '..', 'installers', 'macos', 'iris-daemon-wrapper.sh')

let home
function fakeNode(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, 'node')
  fs.writeFileSync(f, '#!/bin/sh\necho fake-node\n', { mode: 0o755 })
  return f
}
function nvmNode(version) {
  return fakeNode(path.join(home, '.nvm', 'versions', 'node', version, 'bin'))
}
function run(env = {}) {
  const r = spawnSync('/bin/bash', [WRAPPER], {
    env: { HOME: home, PATH: '/usr/bin:/bin', IRIS_WRAPPER_PRINT_NODE: '1', ...env },
    encoding: 'utf8',
  })
  return { code: r.status, out: r.stdout.trim(), err: r.stderr }
}
const pinFile = () => path.join(home, '.iris', 'daemon-node')
const real = (p) => fs.realpathSync(p)

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-pin-'))
  fs.mkdirSync(path.join(home, '.iris'), { recursive: true })
  fs.mkdirSync(path.join(home, '.nvm'), { recursive: true })
  fs.writeFileSync(path.join(home, '.nvm', 'nvm.sh'), 'true\n')
})

describe('daemon wrapper pins one node binary', () => {
  it('first start pins the node it resolves today, and records it', () => {
    const v22 = nvmNode('v22.0.0')
    nvmNode('v20.0.0')
    const r = run()
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, real(v22))
    assert.equal(fs.readFileSync(pinFile(), 'utf8').trim(), real(v22))
    assert.match(r.err, /pinned to .* Full Disk Access belongs on THIS file/)
  })

  it('installing a NEWER node does not move the daemon (the bug)', () => {
    const v22 = nvmNode('v22.0.0')
    run()
    nvmNode('v24.0.0')
    const r = run()
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, real(v22), 'daemon moved to the newer node — its Full Disk Access grant would be lost')
  })

  it('a deleted pinned node is replaced, and says the grant must be redone', () => {
    const v22 = nvmNode('v22.0.0')
    run()
    const v24 = nvmNode('v24.0.0')
    fs.rmSync(path.dirname(path.dirname(v22)), { recursive: true })
    const r = run()
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, real(v24))
    assert.match(r.err, /is gone/)
    assert.match(r.err, /must be granted again/)
    assert.equal(fs.readFileSync(pinFile(), 'utf8').trim(), real(v24))
  })

  it('pins the REAL file behind a symlink (what TCC tracks)', () => {
    // nvm's dir is searched first, so the symlink lives there (the system dirs come after).
    const target = fakeNode(path.join(home, 'cellar', 'node', '22.1.0', 'bin'))
    const linkDir = path.join(home, '.nvm', 'versions', 'node', 'v22.1.0', 'bin')
    fs.mkdirSync(linkDir, { recursive: true })
    fs.symlinkSync(target, path.join(linkDir, 'node'))
    const r = run()
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, real(target))
  })

  it('IRIS_DAEMON_NODE overrides without rewriting the pin', () => {
    const v22 = nvmNode('v22.0.0')
    run()
    const other = fakeNode(path.join(home, 'elsewhere'))
    const r = run({ IRIS_DAEMON_NODE: other })
    assert.equal(r.out, other)
    assert.equal(fs.readFileSync(pinFile(), 'utf8').trim(), real(v22))
  })
})

describe('the denial message names the file to approve', () => {
  it('keeps the doctor prefix and carries process.execPath + the restart', () => {
    const { tccDenialMessage } = require('../daemon/tcc-notice')
    const m = tccDenialMessage('Mail')
    assert.match(m, /^No permission to read Mail — /)
    assert.ok(m.includes(process.execPath), m)
    assert.match(m, /iris-daemon restart/)
  })
})
