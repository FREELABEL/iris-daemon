'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

/**
 * The probe must name the CALL SITE, which is the one thing a native profile could not.
 * sample(1) gave the syscall and the fact that a timer reached it; every JS frame rendered
 * as "??? (in <unknown binary>)".
 */
const ROOT = path.join(__dirname, '..')

test('MANY FAST calls without yielding are caught — the shape a per-call threshold misses', () => {
  // The real failure: thousands of individually fast readdirSync calls in a tight synchronous
  // walk. The first probe used a PER-CALL threshold, caught nothing, and the daemon was
  // demonstrably still blocking. Aggregate-between-yields is the only view that sees it.
  const log = path.join(os.tmpdir(), `slowfs-agg-${process.pid}.log`)
  try { fs.unlinkSync(log) } catch {}
  const script = `
    process.env.IRIS_FS_PROBE_MS = '40'
    process.env.IRIS_FS_PROBE_LOG = ${JSON.stringify(log)}
    require('./daemon/slow-fs-probe').install()
    const fs = require('fs')
    function theTightWalkWeWantNamed () {
      // no single call is slow; the LOOP is what blocks
      for (let i = 0; i < 30000; i++) fs.readdirSync('./daemon')
    }
    theTightWalkWeWantNamed()
  `
  execFileSync(process.execPath, ['-e', script], { cwd: ROOT, stdio: 'pipe' })
  const out = fs.readFileSync(log, 'utf-8')
  assert.match(out, /BLOCKED \d+ms across \d+ sync fs calls/, 'must report the aggregate')
  assert.match(out, /fs\.readdirSync/, 'must attribute the time to the fs function')
  assert.match(out, /theTightWalkWeWantNamed/, 'the dump stack must name the caller doing the walking')
  fs.unlinkSync(log)
})

test('a slow readdirSync is logged with its path AND its JS stack', () => {
  const log = path.join(os.tmpdir(), `slowfs-${process.pid}.log`)
  try { fs.unlinkSync(log) } catch {}

  const script = `
    process.env.IRIS_FS_PROBE_MS = '0.0001'
    process.env.IRIS_FS_PROBE_LOG = ${JSON.stringify(log)}
    require('./daemon/slow-fs-probe').install()
    const fs = require('fs')
    function theCallSiteWeWantNamed () { return fs.readdirSync(process.cwd()) }
    theCallSiteWeWantNamed()
  `
  execFileSync(process.execPath, ['-e', script], { cwd: ROOT, stdio: 'pipe' })

  const out = fs.readFileSync(log, 'utf-8')
  assert.match(out, /BLOCKED \d+ms/, 'must record the blocking window')
  assert.match(out, /theCallSiteWeWantNamed/, 'must name the JS caller — the whole point')
  fs.unlinkSync(log)
})

test('it is OFF unless explicitly armed', () => {
  // This wraps hot fs calls. Left on by accident it becomes its own performance problem.
  const { install } = require('../daemon/slow-fs-probe')
  const saved = process.env.IRIS_FS_PROBE_MS
  delete process.env.IRIS_FS_PROBE_MS
  assert.strictEqual(install(), false)
  if (saved) process.env.IRIS_FS_PROBE_MS = saved
})

test('fast calls are not logged', () => {
  const log = path.join(os.tmpdir(), `slowfs-fast-${process.pid}.log`)
  try { fs.unlinkSync(log) } catch {}
  const script = `
    process.env.IRIS_FS_PROBE_MS = '5000'
    process.env.IRIS_FS_PROBE_LOG = ${JSON.stringify(log)}
    require('./daemon/slow-fs-probe').install()
    require('fs').readdirSync(process.cwd())
  `
  execFileSync(process.execPath, ['-e', script], { cwd: ROOT, stdio: 'pipe' })
  const out = fs.readFileSync(log, 'utf-8')
  assert.ok(!/BLOCKED/.test(out), 'a fast call must not be reported')
  fs.unlinkSync(log)
})

test('the wrapped function still returns the real result', () => {
  // A probe that changes behaviour would be diagnosing itself.
  const script = `
    process.env.IRIS_FS_PROBE_MS = '1'
    process.env.IRIS_FS_PROBE_LOG = ${JSON.stringify(path.join(os.tmpdir(), 'slowfs-ret.log'))}
    require('./daemon/slow-fs-probe').install()
    const fs = require('fs')
    const names = fs.readdirSync('./daemon')
    if (!names.includes('slow-fs-probe.js')) { console.error('WRONG RESULT'); process.exit(1) }
    console.log('OK')
  `
  const out = execFileSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf-8' })
  assert.match(out, /OK/)
})
