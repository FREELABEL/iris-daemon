'use strict'
// TDD, written before lib/file-search-guard.js existed (#188665 patient-data guard).
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')

const { guardFileResults, phiNode, isPrivatePath } = require('../lib/file-search-guard')

const HOME = '/Users/dana'
const row = (p) => ({ source: 'files', match: p, preview: 'fsearch · whole disk · 7 ms', date: null, provider: 'fsearch' })
const rows = [row('/Users/dana/Documents/Jane Doe - intake.pdf'), row('/Users/dana/Documents/invoice.pdf')]

test('a search task the server marked as patient data sends back a COUNT, never a file name', () => {
  const out = guardFileResults(rows, { task: { config: { phi: true } }, home: HOME, env: {}, nodeConfig: {} })
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].match, '(names withheld)')
  assert.strictEqual(out[0].count, 2)
  assert.strictEqual(out[0].phi, true)
  assert.ok(!JSON.stringify(out).includes('Jane Doe'))
  assert.match(out[0].preview, /2 matches.*kept on this machine/)
  assert.match(out[0].preview, /iris locate/, 'tells the person how to see them')
})

test('a machine marked as handling patient data withholds names for every search', () => {
  for (const marker of [{ nodeConfig: { phi_node: true }, env: {} }, { nodeConfig: {}, env: { IRIS_PHI_NODE: '1' } }]) {
    const out = guardFileResults(rows, { task: { config: {} }, home: HOME, ...marker })
    assert.strictEqual(out[0].match, '(names withheld)', JSON.stringify(marker))
    assert.ok(!JSON.stringify(out).includes('invoice.pdf'))
  }
  assert.strictEqual(phiNode({ nodeConfig: { phi_node: 'true' }, env: {} }), true)
  assert.strictEqual(phiNode({ nodeConfig: {}, env: {} }), false)
})

test('an ordinary machine and task: names pass through unchanged', () => {
  const out = guardFileResults(rows, { task: { config: {} }, home: HOME, env: {}, nodeConfig: {} })
  assert.deepStrictEqual(out, rows)
})

test("IRIS's own patient-data storage never appears in results, on ANY machine, not even as a name", () => {
  const vault = row(path.join(HOME, '.iris', 'vaults', 'phi-migrated', 'obj-1'))
  const task = row(path.join(HOME, '.iris', 'daemon-data', 'tasks', '01a1', 'phi-result.json'))
  const out = guardFileResults([vault, ...rows, task], { task: { config: {} }, home: HOME, env: {}, nodeConfig: {} })
  assert.deepStrictEqual(out.map((r) => r.match), rows.map((r) => r.match))
  assert.strictEqual(isPrivatePath(vault.match, { home: HOME, env: {} }), true)
  assert.strictEqual(isPrivatePath('/Users/dana/.iris/vaultsX/a', { home: HOME, env: {} }), false, 'a prefix, not a substring')
  assert.strictEqual(isPrivatePath('/srv/v/x', { home: HOME, env: { IRIS_VAULTS_DIR: '/srv/v' } }), true, 'honours a moved vault dir')
})

test('withheld with zero matches still says so — "no results" must not read as "not on this machine"', () => {
  const out = guardFileResults([], { task: { config: { phi: true } }, home: HOME, env: {}, nodeConfig: {} })
  assert.strictEqual(out[0].count, 0)
  assert.match(out[0].preview, /0 matches/)
})

test('a provider/diagnostic note row (no real path) is kept, but never carries a path on a PHI search', () => {
  const note = { source: 'files', match: '(no file results)', preview: 'no file index on this node', date: null }
  assert.deepStrictEqual(guardFileResults([note], { task: { config: {} }, home: HOME, env: {}, nodeConfig: {} }), [note])
})

const { guardSearchResults } = require('../lib/file-search-guard')

test('on a patient-data search, iMessage text and inbox previews are withheld too — one count per source', () => {
  const mixed = [
    { source: 'imessage', match: '+15551234567', preview: 'Jane, your results are in', date: null },
    { source: 'inbox', match: 'labs.pdf', preview: 'patient labs', date: null },
    row('/Users/dana/Documents/Jane Doe - intake.pdf'),
  ]
  const out = guardSearchResults(mixed, { task: { config: { phi: true } }, home: HOME, env: {}, nodeConfig: {} })
  assert.deepStrictEqual(out.map((r) => [r.source, r.count]), [['imessage', 1], ['inbox', 1], ['files', 1]])
  assert.ok(!/Jane|555|labs/.test(JSON.stringify(out)))
})

test('on an ordinary search every source passes through, and vault paths are still dropped', () => {
  const vault = row(path.join(HOME, '.iris', 'vaults', 'v', 'o'))
  const mixed = [{ source: 'imessage', match: 'x', preview: 'hi', date: null }, vault, ...rows]
  const out = guardSearchResults(mixed, { task: { config: {} }, home: HOME, env: {}, nodeConfig: {} })
  assert.deepStrictEqual(out.map((r) => r.match), ['x', ...rows.map((r) => r.match)])
})

test('the hive_search handler sends its answer through the guard before it leaves the node', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'daemon', 'task-executor.js'), 'utf-8')
  const start = src.indexOf("if (task.type === 'hive_search') {")
  const block = src.slice(start, src.indexOf('// ── Exchange task', start))
  assert.ok(start > 0 && block.length > 0)
  const guardAt = block.indexOf('guardSearchResults(')
  const submitAt = block.lastIndexOf('submitResult(')
  assert.ok(guardAt > 0, 'hive_search must call guardSearchResults')
  assert.ok(guardAt < submitAt, 'and call it before the result is submitted')
  assert.match(block.slice(submitAt, submitAt + 200), /JSON\.stringify\(guarded\)/, 'and submit the GUARDED rows')
})
