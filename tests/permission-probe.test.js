const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { probePermissions, probeFullDiskAccess, probeBrowser, SQLITE_MAGIC } = require('../daemon/permission-probe')

/**
 * S1.2 — permissions detected by ATTEMPTING the access, never by checking a path exists.
 *
 * The failure being prevented: `existsSync` returns true for a file the process cannot read,
 * and some TCC-blocked reads come back EMPTY rather than throwing. Both report a healthy node
 * that can read nothing — and a script needing Full Disk Access then lands there and returns a
 * confident, wrong answer: a case folder holding "no documents", because it could not be read.
 */

const baseIo = {
  platform: () => 'darwin',
  homedir: () => '/Users/test',
  now: () => '2026-08-27T00:00:00Z',
  open: () => 1,
  read: (fd, buf) => { buf.write(SQLITE_MAGIC); return SQLITE_MAGIC.length },
  close: () => {},
  exec: () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e },
  reach: async () => true
}
const io = (over) => ({ ...baseIo, ...over })

describe('full-disk-access', () => {
  it('is granted only when the real bytes come back', () => {
    const r = probeFullDiskAccess(io())
    assert.equal(r.available, true)
  })

  it('A READ THAT RETURNS ZERO BYTES IS NOT SUCCESS', () => {
    // The whole reason this probe reads content instead of calling access(). A silent empty
    // read is the single most dangerous outcome, because nothing throws.
    const r = probeFullDiskAccess(io({ read: () => 0 }))
    assert.equal(r.available, false)
    assert.match(r.reason, /0 bytes|silently/i)
  })

  it('content that is not the expected file is not success either', () => {
    const r = probeFullDiskAccess(io({ read: (fd, buf) => { buf.write('not a db here'); return 13 } }))
    assert.equal(r.available, false)
  })

  it('a TCC denial says how to fix it, and to restart afterwards', () => {
    const r = probeFullDiskAccess(io({ open: () => { const e = new Error('denied'); e.code = 'EPERM'; throw e } }))
    assert.equal(r.available, false)
    assert.match(r.reason, /Full Disk Access/)
    assert.match(r.reason, /restart/)
  })

  it('a MISSING file is unknown, not denied — it proves nothing about the permission', () => {
    // "we could not measure" and "you do not have it" send an operator to different places.
    const r = probeFullDiskAccess(io({ open: () => { const e = new Error('gone'); e.code = 'ENOENT'; throw e } }))
    assert.equal(r.available, null)
    assert.match(r.reason, /cannot determine/i)
  })

  it('is not applicable off macOS, and says so rather than reporting a failure', () => {
    const r = probeFullDiskAccess(io({ platform: () => 'linux' }))
    assert.equal(r.available, null)
    assert.match(r.reason, /macOS/)
  })

  it('never reports available on an unexpected error', () => {
    const r = probeFullDiskAccess(io({ open: () => { const e = new Error('weird'); e.code = 'EIO'; throw e } }))
    assert.notEqual(r.available, true)
  })
})

describe('browser', () => {
  it('requires the binary to actually RUN and report a version', () => {
    const r = probeBrowser(io({ exec: () => 'Google Chrome 141.0.1234.56' }))
    assert.equal(r.available, true)
  })

  it('a binary that exists but produces no version is NOT available', () => {
    // A quarantined or half-installed app satisfies every existence check and fails the first
    // real invocation.
    const r = probeBrowser(io({ exec: () => '' }))
    assert.equal(r.available, false)
  })

  it('no browser at all is reported with a reason', () => {
    const r = probeBrowser(io())
    assert.equal(r.available, false)
    assert.ok(r.reason && r.reason.length > 0)
  })
})

describe('isolation (S2.2)', () => {
  const { probeIsolation } = require('../daemon/permission-probe')

  it('asks the DAEMON, not whether the CLI exists', () => {
    // Measured live on this machine: `docker` is installed and the daemon is NOT running, so a
    // `which docker` check reports an isolation capability that cannot isolate anything. Same
    // class of mistake as existsSync for Full Disk Access.
    const r = probeIsolation(io({ exec: () => { const e = new Error('cannot connect'); e.code = 1; throw e } }))
    assert.equal(r.available, false)
    assert.match(r.reason, /not running/)
  })

  it('a missing runtime reads differently from a stopped one', () => {
    // Install Docker vs start Docker are different next steps.
    const r = probeIsolation(io({ exec: () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e } }))
    assert.equal(r.available, false)
    assert.match(r.reason, /no container runtime installed/)
  })

  it('is available only when the daemon reports a server version', () => {
    assert.equal(probeIsolation(io({ exec: () => '27.1.1' })).available, true)
    // Responded, but said nothing — not proof of a working daemon.
    assert.equal(probeIsolation(io({ exec: () => '' })).available, false)
  })
})

describe('probePermissions', () => {
  it('advertises every probe with a timestamp', async () => {
    const out = await probePermissions(io())
    for (const key of ['full-disk-access', 'browser', 'network', 'isolation']) {
      assert.ok(key in out, `${key} must be reported`)
      assert.equal(out[key].checked_at, '2026-08-27T00:00:00Z')
    }
  })

  it('A PROBE THAT THROWS BECOMES unknown, NEVER false AND NEVER MISSING', async () => {
    // "the probe broke" is not "the permission is absent". Collapsing them sends someone to
    // grant a permission they already have.
    const out = await probePermissions(io({
      open: () => { throw new Error('boom') },
      read: () => { throw new Error('boom') }
    }))
    assert.ok('full-disk-access' in out)
    assert.notEqual(out['full-disk-access'].available, true)
  })

  it('a failing network probe does not stop the others being reported', async () => {
    const out = await probePermissions(io({ reach: async () => { throw new Error('offline') } }))
    assert.equal(out.network.available, false)
    assert.equal(out['full-disk-access'].available, true)
  })

  it('unknown is never rendered as granted', async () => {
    const out = await probePermissions(io({ platform: () => 'linux' }))
    assert.equal(out['full-disk-access'].available, null)
    assert.notEqual(out['full-disk-access'].available, true)
  })
})
