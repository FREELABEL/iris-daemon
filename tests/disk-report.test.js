// #188700: the heartbeat carries live free space on ~/.iris and the last failed state write.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const dr = require('../lib/disk-report')
const { writeFileAtomic } = require('../lib/atomic-write')

test('measures the real directory', () => {
  dr._resetForTests()
  const r = dr.diskReport({ dir: os.tmpdir() })
  assert.ok(r.free_gb >= 0 && r.total_gb > 0, JSON.stringify(r))
})

test('samples at most once a minute', () => {
  dr._resetForTests()
  let calls = 0
  const statfs = () => { calls++; return { path: '/x', free_gb: 5, total_gb: 10 } }
  dr.diskReport({ now: 0, statfs }); dr.diskReport({ now: 30_000, statfs }); dr.diskReport({ now: 61_000, statfs })
  assert.strictEqual(calls, 2)
})

test('a failed atomic write is reported on the next beat, and forces a re-measure', () => {
  dr._resetForTests()
  let calls = 0
  const statfs = () => { calls++; return { path: '/x', free_gb: 0, total_gb: 10 } }
  dr.diskReport({ now: 0, statfs })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-'))
  const real = fs.writeSync
  fs.writeSync = () => { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e }
  try { assert.throws(() => writeFileAtomic(path.join(dir, 'config.json'), '{}')) } finally { fs.writeSync = real }
  const r = dr.diskReport({ now: 1000, statfs })
  assert.strictEqual(calls, 2)
  assert.strictEqual(r.last_write_error.code, 'ENOSPC')
  assert.strictEqual(r.last_write_error.file, 'config.json')
})

test('a platform that cannot measure reports nothing rather than a zero', () => {
  dr._resetForTests()
  assert.strictEqual(dr.diskReport({ statfs: () => { throw new Error('ENOSYS') } }), null)
})
