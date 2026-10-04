const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')

const { permissionsReport, freshFullDiskAccess, readPinned } = require('../daemon/fda-status')
const { nextStep } = require('../scripts/grant-access')

// A blind spot is only useful if it comes with its fix. `iris pulse check` listed Apple Mail as
// "not searched" with a raw 503 and no next step (2026-10-03). These pin the report the CLI reads
// and the guided command that acts on it.

const tmpHome = (pin) => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-fda-'))
  fs.mkdirSync(path.join(h, '.iris'))
  if (pin) fs.writeFileSync(path.join(h, '.iris', 'daemon-node'), pin + '\n')
  return h
}
const yes = { available: true, reason: null }
const no = { available: false, reason: 'denied' }

describe('permissionsReport', () => {
  it('denied everywhere: no restart will help, names the file and the fix', async () => {
    const r = await permissionsReport({ platform: 'darwin', execPath: '/x/node', ppid: 1, home: tmpHome('/pinned/node'),
      probeProcess: () => no, probeFresh: async () => no })
    assert.equal(r.process.available, false)
    assert.equal(r.restart_needed, false)
    assert.equal(r.binary, '/x/node')
    assert.equal(r.pinned, '/pinned/node')
    assert.equal(r.fix.command, 'iris-daemon grant-access')
    assert.equal(r.measured_as, 'daemon')
  })

  it('granted after start: fresh yes + process no means a restart is all that is left', async () => {
    const r = await permissionsReport({ platform: 'darwin', ppid: 1, home: tmpHome(),
      probeProcess: () => no, probeFresh: async () => yes })
    assert.equal(r.restart_needed, true)
  })

  it('an UNKNOWN fresh check never claims a restart will fix it', async () => {
    const r = await permissionsReport({ platform: 'darwin', ppid: 1, home: tmpHome(),
      probeProcess: () => no, probeFresh: async () => ({ available: null, reason: 'x' }) })
    assert.equal(r.restart_needed, false)
  })

  it('says when it measured a terminal-started process, whose access is not the daemon\'s', async () => {
    const r = await permissionsReport({ platform: 'darwin', ppid: 4242, home: tmpHome(),
      probeProcess: () => yes, probeFresh: async () => yes })
    assert.equal(r.launchd, false)
    assert.match(r.measured_as, /terminal/)
  })

  it('not macOS: not applicable, never "denied"', async () => {
    const r = await permissionsReport({ platform: 'linux', home: tmpHome() })
    assert.equal(r.process.available, null)
    assert.equal(r.restart_needed, false)
  })

  it('readPinned is null when there is no pin, never throws', () => {
    assert.equal(readPinned(tmpHome()), null)
  })
})

describe('freshFullDiskAccess', () => {
  const fake = (err, stdout) => (bin, args, opts, cb) => cb(err, stdout)
  it('reads the child\'s verdict', async () => {
    assert.equal((await freshFullDiskAccess({ run: fake(null, '{"available":true,"reason":null}') })).available, true)
    assert.equal((await freshFullDiskAccess({ run: fake(null, '{"available":false,"reason":"denied"}') })).available, false)
  })
  it('a child that could not run is UNKNOWN, not denied', async () => {
    assert.equal((await freshFullDiskAccess({ run: fake(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), '') })).available, null)
    assert.equal((await freshFullDiskAccess({ run: fake(null, 'garbage') })).available, null)
  })
  it('really spawns the same binary and gets a tristate back', async () => {
    const r = await freshFullDiskAccess()
    assert.ok([true, false, null].includes(r.available), JSON.stringify(r))
  })
})

describe('grant-access decides the next step', () => {
  it('maps every state', () => {
    assert.equal(nextStep(null).step, 'daemon_down')
    assert.equal(nextStep({ platform: 'linux' }).step, 'not_applicable')
    assert.equal(nextStep({ platform: 'darwin', process: yes, binary: 'b' }).step, 'granted')
    assert.equal(nextStep({ platform: 'darwin', process: no, restart_needed: true }).step, 'restart')
    assert.equal(nextStep({ platform: 'darwin', process: no, restart_needed: false }).step, 'grant')
  })
})

describe('grant-access against a stub daemon', () => {
  const runScript = (url, args, env = {}) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'grant-access.js'), ...args],
      { env: { ...process.env, IRIS_BRIDGE_URL: url, IRIS_GRANT_SETTLE_SECONDS: '2', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { out += d })
    p.on('close', (code) => resolve({ code, out }))
  })
  const serve = (body, status = 200, healthStatus = 200) => new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const code = req.url === '/daemon/permissions' ? status : req.url === '/daemon/health' ? healthStatus : 404
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }).listen(0, '127.0.0.1', () => resolve(s))
  })

  it('already granted: says so and exits 0 without opening anything', async () => {
    const s = await serve({ platform: 'darwin', binary: '/x/node', process: yes, fresh: yes, restart_needed: false, fix: {} })
    const r = await runScript(`http://127.0.0.1:${s.address().port}`, [])
    s.close()
    assert.equal(r.code, 0)
    assert.match(r.out, /Full Disk Access is on for \/x\/node/)
  })

  it('--json exits 1 when not granted', async () => {
    const s = await serve({ platform: 'darwin', binary: '/x/node', process: no, fresh: no, restart_needed: false, fix: {} })
    const r = await runScript(`http://127.0.0.1:${s.address().port}`, ['--json'])
    s.close()
    assert.equal(r.code, 1)
    assert.match(r.out, /"available": false/)
  })

  it('an old daemon (health answers, permissions 404) gets told to update', async () => {
    const s = await serve({}, 404, 200)
    const r = await runScript(`http://127.0.0.1:${s.address().port}`, [])
    s.close()
    assert.equal(r.code, 1)
    assert.match(r.out, /too old/)
  })

  it('a daemon still STARTING (everything 404) is waited for, never called "too old"', async () => {
    const s = await serve({}, 404, 404)
    const r = await runScript(`http://127.0.0.1:${s.address().port}`, [], { IRIS_GRANT_SETTLE_SECONDS: '4' })
    s.close()
    assert.equal(r.code, 1)
    assert.doesNotMatch(r.out, /too old/)
    assert.match(r.out, /not answering/)
  })

  it('daemon down: one clear line, exit 1', async () => {
    const r = await runScript('http://127.0.0.1:9', [])
    assert.equal(r.code, 1)
    assert.match(r.out, /not answering/)
  })
})
