// A full disk must not destroy the node's state files (Hermes audit, EVAL #188663).
// fs.writeFileSync truncates and then writes; ENOSPC between the two left config.json empty,
// and the next boot lost the node key. These simulate ENOSPC on the write itself.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { writeFileAtomic } = require('../lib/atomic-write')

function tmpdir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-'))
}

function withEnospc (fn) {
  const real = fs.writeSync
  fs.writeSync = () => { const e = new Error('ENOSPC: no space left on device, write'); e.code = 'ENOSPC'; throw e }
  try { return fn() } finally { fs.writeSync = real }
}

test('a full disk leaves the previous config intact, and says ENOSPC', () => {
  const dir = tmpdir()
  const file = path.join(dir, 'config.json')
  const original = JSON.stringify({ node_api_key: 'node_live_key', node_id: 'abc' })
  fs.writeFileSync(file, original)

  assert.throws(() => withEnospc(() => writeFileAtomic(file, JSON.stringify({ paused: true }))), { code: 'ENOSPC' })
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), original, 'the node key survives')
  assert.deepStrictEqual(fs.readdirSync(dir), ['config.json'], 'no temp file left behind')
})

test('a normal write replaces the file and applies the mode', () => {
  const dir = tmpdir()
  const file = path.join(dir, 'schedules.json')
  fs.writeFileSync(file, '[]', { mode: 0o644 })
  writeFileAtomic(file, '[{"id":"a"}]', { mode: 0o600 })
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), '[{"id":"a"}]')
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600)
})

test('the schedule registry writes through it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'schedule-registry.js'), 'utf-8')
  assert.match(src, /writeFileAtomic\(filePath, contents, \{ mode: 0o600 \}\)/)
  assert.doesNotMatch(src, /fs\.writeFileSync\(filePath/)
})
