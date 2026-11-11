const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  parseDriveSpec, acquireRw, releaseRw, readHolder, resolveDrive, planDriveMount
} = require('../daemon/drive-mount')
const { buildSandboxCommand, planScriptExecution } = require('../daemon/sandbox')

/**
 * #188567 — a Hive drive mounted into a sandbox at /workspace.
 *
 * Two rules matter more than the feature:
 *   1. CREDENTIALS. A drive is reached with its metadata URL (often with a password) and, on the
 *      node that formatted it, a bucket key. The container gets the FILES, through a bind mount.
 *      It never gets the URL, the password or a key — not in env, not in argv, not in a file.
 *   2. ONE WRITER. At most one sandbox mounts a drive read-write at a time; every other mount is
 *      read-only. The lock lives IN the drive (.iris/rw), so it holds across every node that
 *      mounts it — JuiceFS makes mkdir atomic across clients through its metadata engine.
 */

let tmp
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-')) })

describe('drive spec', () => {
  it('name alone is read-write; :ro is read-only; :rw is explicit read-write', () => {
    assert.deepEqual(parseDriveSpec('work'), { name: 'work', readOnly: false })
    assert.deepEqual(parseDriveSpec('work:ro'), { name: 'work', readOnly: true })
    assert.deepEqual(parseDriveSpec('work:rw'), { name: 'work', readOnly: false })
  })

  it('refuses names the CLI would refuse, and unknown modes — never a guess', () => {
    for (const bad of ['', 'a', 'Work', '../etc', 'work:rx', 'work:ro:rw', 'w/x', 'work ro']) {
      assert.throws(() => parseDriveSpec(bad), /drive/i, bad)
    }
  })
})

describe('ONE read-write mount at a time', () => {
  it('the first writer gets the drive; a second writer is refused and told who holds it', () => {
    assert.equal(acquireRw(tmp, 'task-a', 600).ok, true)
    const second = acquireRw(tmp, 'task-b', 600)
    assert.equal(second.ok, false)
    assert.match(second.reason, /task-a/)
  })

  it('the same holder may renew', () => {
    assert.equal(acquireRw(tmp, 'task-a', 600).ok, true)
    assert.equal(acquireRw(tmp, 'task-a', 600).ok, true)
  })

  it('release frees it for the next writer', () => {
    acquireRw(tmp, 'task-a', 600)
    assert.equal(releaseRw(tmp, 'task-a'), true)
    assert.equal(acquireRw(tmp, 'task-b', 600).ok, true)
  })

  it('only the holder can release — another run cannot free a lock it does not hold', () => {
    acquireRw(tmp, 'task-a', 600)
    assert.equal(releaseRw(tmp, 'task-b'), false)
    assert.equal(acquireRw(tmp, 'task-b', 600).ok, false)
  })

  it('an expired lock (a holder that crashed) is taken over, not left forever', () => {
    const now = Date.now()
    acquireRw(tmp, 'task-a', 60, now - 120_000)
    const r = acquireRw(tmp, 'task-b', 60, now)
    assert.equal(r.ok, true)
    assert.equal(readHolder(tmp).holder, 'task-b')
  })

  it('the lock is a directory in the drive, so every node that mounts the drive sees it', () => {
    acquireRw(tmp, 'task-a', 600)
    assert.ok(fs.statSync(path.join(tmp, '.iris', 'rw')).isDirectory())
  })
})

describe('mount plan: rw takes the lock, ro never does', () => {
  const home = () => {
    const h = path.join(tmp, 'home')
    const mp = path.join(tmp, 'mnt', 'work')
    fs.mkdirSync(path.join(h, '.iris', 'drives'), { recursive: true })
    fs.mkdirSync(mp, { recursive: true })
    fs.writeFileSync(path.join(h, '.iris', 'drives', 'work.json'), JSON.stringify({
      name: 'work', meta: 'redis://:s3cretpw@100.64.0.9:6379/1', mountpoint: mp, identity: '501:20'
    }))
    return { h, mp, table: `JuiceFS:work ${mp} fuse.juicefs rw 0 0\n` }
  }

  it('rw: the workspace is bound read-write and the drive is locked', () => {
    const { h, mp, table } = home()
    const p = planDriveMount('work', { home: h, mountsTable: table, holder: 'task-1', ttlSeconds: 600 })
    assert.equal(p.ok, true)
    assert.equal(p.readOnly, false)
    assert.equal(p.hostPath, path.join(mp, 'workspace'))
    assert.equal(readHolder(mp).holder, 'task-1')
  })

  it('ro while someone holds rw: still mounts, read-only, and takes no lock', () => {
    const { h, mp, table } = home()
    acquireRw(mp, 'someone-else', 600)
    const p = planDriveMount('work:ro', { home: h, mountsTable: table, holder: 'task-2', ttlSeconds: 600 })
    assert.equal(p.ok, true)
    assert.equal(p.readOnly, true)
    assert.equal(readHolder(mp).holder, 'someone-else')
  })

  it('rw while someone holds rw: REFUSED, not quietly downgraded to ro', () => {
    const { h, mp, table } = home()
    acquireRw(mp, 'someone-else', 600)
    const p = planDriveMount('work', { home: h, mountsTable: table, holder: 'task-2', ttlSeconds: 600 })
    assert.equal(p.ok, false)
    assert.match(p.reason, /read-write by someone-else/)
    assert.match(p.reason, /:ro/)
  })

  it('a drive that is set up but NOT mounted is refused — never the empty folder underneath', () => {
    const { h } = home()
    const p = planDriveMount('work', { home: h, mountsTable: '', holder: 't', ttlSeconds: 60 })
    assert.equal(p.ok, false)
    assert.match(p.reason, /not mounted/)
  })

  it('an unknown drive is refused', () => {
    const { h, table } = home()
    const p = planDriveMount('other', { home: h, mountsTable: table, holder: 't', ttlSeconds: 60 })
    assert.equal(p.ok, false)
    assert.match(p.reason, /no drive called other/)
  })

  it('resolveDrive never returns the metadata URL', () => {
    const { h, table } = home()
    const d = resolveDrive('work', { home: h, mountsTable: table })
    assert.equal(JSON.stringify(d).includes('s3cretpw'), false)
    assert.equal(JSON.stringify(d).includes('redis://'), false)
  })
})

describe('CREDENTIALS: the container gets the files, never the keys', () => {
  const base = { runtime: 'bash', scriptPath: '/tmp/x/user-script.sh', outputDir: '/tmp/x/.output' }

  it('a drive adds one bind mount at /workspace and NO environment', () => {
    const { args } = buildSandboxCommand({ ...base, drive: { hostPath: '/mnt/work/workspace', readOnly: false } })
    assert.ok(args.includes('/mnt/work/workspace:/workspace:rw'))
    assert.equal(args.filter((a) => a === '-e').length, 0)
    assert.equal(args[args.indexOf('--workdir') + 1], '/workspace')
  })

  it('ro is enforced by the kernel (:ro bind), not by asking the script nicely', () => {
    const { args } = buildSandboxCommand({ ...base, drive: { hostPath: '/mnt/work/workspace', readOnly: true } })
    assert.ok(args.includes('/mnt/work/workspace:/workspace:ro'))
  })

  it('the daemon env holding drive secrets does not leak into the container args', () => {
    const saved = { ...process.env }
    process.env.META_PASSWORD = 'meta-pw-123'
    process.env.ACCESS_KEY = 'AKIAEXAMPLE'
    process.env.SECRET_KEY = 'secret-key-xyz'
    try {
      const { args } = buildSandboxCommand({ ...base, drive: { hostPath: '/mnt/work/workspace', readOnly: false } })
      const flat = args.join(' ')
      for (const s of ['meta-pw-123', 'AKIAEXAMPLE', 'secret-key-xyz', 'META_PASSWORD', 'ACCESS_KEY', 'SECRET_KEY', 'redis://']) {
        assert.equal(flat.includes(s), false, s)
      }
    } finally {
      process.env = saved
    }
  })

  it('a drive path must be absolute and may not smuggle extra mount options', () => {
    assert.throws(() => buildSandboxCommand({ ...base, drive: { hostPath: 'rel/ws', readOnly: false } }), /absolute/)
    assert.throws(() => buildSandboxCommand({ ...base, drive: { hostPath: '/a:/etc', readOnly: false } }), /drive path/)
  })

  it('a drive never runs on the host: no sandbox, no drive (refused, not unmounted-and-run)', () => {
    const plan = planScriptExecution({
      ...base, policy: {}, isolation: { available: false, reason: 'no docker' },
      drive: { hostPath: '/mnt/work/workspace', readOnly: false }
    })
    assert.equal(plan.mode, 'refused')
    assert.match(plan.reason, /drive/)
  })
})
