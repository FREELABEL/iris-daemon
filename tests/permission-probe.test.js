const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { probePermissions, probeFullDiskAccess, probeBrowser, probeRuntime, SQLITE_MAGIC } = require('../daemon/permission-probe')

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
    for (const key of ['full-disk-access', 'browser', 'network', 'isolation', 'python3', 'node', 'bash']) {
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

/**
 * #184757 — the fleet could not EXPRESS "this node has Python", so `requires=python3` matched
 * nothing and a .py script routed anywhere. `scripts doctor` ticked a Windows box with no
 * interpreter. The routing gate was never broken; it had nothing to check against.
 */
describe('interpreters', () => {
  // Only the binaries named in the map exist; everything else is ENOENT, as on a real machine.
  const withBins = (map) => io({
    exec: (bin) => {
      if (!(bin in map)) { const e = new Error('nope'); e.code = 'ENOENT'; throw e }
      return map[bin]
    }
  })

  it('python3 is available when the interpreter reports Python 3', () => {
    const r = probeRuntime('python3')(withBins({ python3: 'Python 3.12.2' }))
    assert.equal(r.available, true)
    assert.match(r.detail, /Python 3\./)
  })

  it('PYTHON 2 DOES NOT SATISFY python3', () => {
    // A .py script pushed with --runtime python is invoked as python3. A box with only
    // Python 2 must read as cannot-run, not as "python is present".
    const r = probeRuntime('python3')(withBins({ python: 'Python 2.7.18' }))
    assert.equal(r.available, false)
    assert.match(r.reason, /2\.7/)
  })

  it('A SHIM THAT RUNS AND PRINTS NOTHING IS NOT AN INTERPRETER', () => {
    // The Windows Store python shim: on PATH, exits, silent. Every existence check passes it.
    const r = probeRuntime('python3')(withBins({ python3: '' }))
    assert.equal(r.available, false)
    assert.match(r.reason, /printed no version/)
  })

  it('falls through python and py -3 before giving up', () => {
    assert.equal(probeRuntime('python3')(withBins({ py: 'Python 3.11.9' })).available, true)
  })

  it('node and bash report their own versions', () => {
    assert.equal(probeRuntime('node')(withBins({ node: 'v22.11.0' })).available, true)
    assert.equal(probeRuntime('bash')(withBins({ bash: 'GNU bash, version 5.2.15(1)-release' })).available, true)
  })

  it('a missing interpreter says so plainly, and bash names the Windows case', () => {
    const r = probeRuntime('bash')(withBins({}))
    assert.equal(r.available, false)
    assert.match(r.reason, /no bash on PATH/)
    assert.match(r.reason, /Windows/)
  })
})

/**
 * #184794 — a probe that TIMED OUT measured nothing. Recording that as false makes the node
 * refuse work it can do (the gate treats not-true as unsatisfied) and hands the operator a
 * diagnosis nobody established. Measured live: Chrome answers in 0.28s and docker info in
 * 0.67s, yet both timed out once under launchd and advertised ABSENT.
 */
describe('a timeout is not a measurement', () => {
  const { probeIsolation } = require('../daemon/permission-probe')
  const timesOut = () => { const e = new Error('timed out'); e.code = 'ETIMEDOUT'; throw e }
  const killed = () => { const e = new Error('killed'); e.killed = true; e.signal = 'SIGTERM'; throw e }

  it('BROWSER: a timeout is unknown, never absent', () => {
    const r = probeBrowser(io({ exec: timesOut }))
    assert.equal(r.available, null)
    assert.match(r.reason, /2500ms/)
  })

  it('ISOLATION: A TIMEOUT MUST NOT CLAIM THE RUNTIME IS STOPPED', () => {
    // The exact false statement from the field: Docker was running the whole time.
    const r = probeIsolation(io({ exec: timesOut }))
    assert.equal(r.available, null)
    assert.doesNotMatch(r.reason, /not running/)
    assert.match(r.reason, /not measured/)
  })

  it('ISOLATION: a real non-zero exit still reads as stopped', () => {
    // The distinction the fix turns on — here docker ANSWERED, and the answer was no.
    const r = probeIsolation(io({ exec: () => { const e = new Error('cannot connect'); e.code = 1; throw e } }))
    assert.equal(r.available, false)
    assert.match(r.reason, /not running/)
  })

  it('INTERPRETER: a slow python3 is not a missing python3', () => {
    const r = probeRuntime('python3')(io({ exec: timesOut }))
    assert.equal(r.available, null)
    assert.doesNotMatch(r.reason, /no python3 on PATH/)
  })

  it('a SIGTERM kill counts as unmeasured too', () => {
    assert.equal(probeRuntime('node')(io({ exec: killed })).available, null)
  })

  it('nothing measured is never rendered as granted', async () => {
    const out = await probePermissions(io({ exec: timesOut }))
    for (const k of ['browser', 'isolation', 'python3', 'node', 'bash']) {
      assert.notEqual(out[k].available, true, `${k} must not be true when nothing was measured`)
    }
  })
})
