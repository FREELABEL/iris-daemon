const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// #191475: since #185896 the daemon writes config.json itself when it enrolls the machine. The
// wrapper still exited when config.json was missing, so on a brand-new machine launchd relaunched
// it forever and the daemon never got to enroll. Found 2026-10-27 joining a new iMac.

const WRAPPER = path.join(__dirname, '..', 'installers', 'macos', 'iris-daemon-wrapper.sh')
let home

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-fresh-'))
  // A private runtime node, as the installer lays it down. It records what it was asked to run.
  // (The repo's DAEMON_DIR is ~/.iris/daemon; the installer sed-rewrites it to ~/.iris/bridge.)
  const bin = path.join(home, '.iris', 'runtime', 'node-v22.0.0-darwin-x64', 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(
    path.join(bin, 'node'),
    `#!/bin/sh\nif [ "$1" = "daemon.js" ]; then echo "LAUNCHED daemon.js key=\${NODE_API_KEY:-none}"; fi\nexit 0\n`,
    { mode: 0o755 },
  )
  fs.mkdirSync(path.join(home, '.iris', 'daemon'), { recursive: true })
  fs.writeFileSync(path.join(home, '.iris', 'daemon', 'daemon.js'), '')
})

function run() {
  const r = spawnSync('/bin/bash', [WRAPPER], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

describe('daemon wrapper on a machine that has never joined', () => {
  it('starts the daemon when config.json does not exist yet, so it can enroll', () => {
    const r = run()
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /LAUNCHED daemon\.js/, 'the daemon was never started — a fresh machine can never enroll')
    assert.match(r.err, /starting the daemon so it can enroll/)
    assert.doesNotMatch(r.err, /installers\/install\.sh/, 'points people at an installer that does not exist')
  })

  it('still starts normally once config.json exists', () => {
    fs.writeFileSync(path.join(home, '.iris', 'config.json'), JSON.stringify({ node_api_key: 'node_live_x' }))
    const r = run()
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /LAUNCHED daemon\.js/)
  })
})
