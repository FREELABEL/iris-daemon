'use strict'
// #188665 / epic #188696 O3: the node decides whether its disk is searchable, and the direct
// (mesh) route is gated, honours that decision, and applies the patient-data guard.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { fileSearchPolicy, disabledRow, capability, handleFilesSearch } = require('../daemon/file-search-policy')

const TOKEN = 'a'.repeat(64)
const ok = { 'x-bridge-key': TOKEN }
const fakeSearch = (rows) => async () => ({ backend: 'plocate', coverage: 'whole disk', took_ms: 7, rows })
const row = (p) => ({ source: 'files', match: p, preview: 'plocate', date: null })

test('file search is ON by default — existing nodes keep working', () => {
  for (const cfg of [{}, { hive_search: {} }, { hive_search: { files: true } }, { other: 1 }, null]) {
    assert.strictEqual(fileSearchPolicy({ nodeConfig: cfg }).enabled, true, JSON.stringify(cfg))
  }
})

test('hive_search.files = false turns it off, with a reason that names the setting', () => {
  for (const cfg of [{ hive_search: { files: false } }, { hive_search: { files: 'false' } }, { hive_search: { files: 0 } }, { hive_search: false }]) {
    const p = fileSearchPolicy({ nodeConfig: cfg })
    assert.strictEqual(p.enabled, false, JSON.stringify(cfg))
    assert.match(p.reason, /hive_search\.files = false/)
  }
})

test('a refusal is an explicit row, never an empty result', () => {
  const r = disabledRow(fileSearchPolicy({ nodeConfig: { hive_search: { files: false } } }))
  assert.strictEqual(r.source, 'files')
  assert.strictEqual(r.disabled, true)
  assert.match(r.match, /disabled/)
  assert.match(r.preview, /turned off on this machine/)
})

test('the heartbeat capability says off, and why, so callers can skip the node up front', () => {
  const off = capability({ nodeConfig: { hive_search: { files: false } }, listProviders: () => ({ chosen: null, providers: [] }) })
  assert.strictEqual(off.available, false)
  assert.match(off.reason, /turned off/)
  const on = capability({ nodeConfig: {}, listProviders: () => ({ chosen: 'plocate', providers: [{ name: 'plocate', coverage: 'whole disk' }] }) })
  assert.strictEqual(on.available, true)
  assert.strictEqual(on.route, true)
  assert.strictEqual(on.detail, 'plocate · whole disk')
})

test('route: no operator key on this machine → refused (fail closed), and search never runs', async () => {
  let ran = false
  const search = async () => { ran = true; return { rows: [] } }
  for (const token of [null, '']) {
    const r = await handleFilesSearch({ q: 'invoice' }, ok, { token, nodeConfig: {}, search })
    assert.strictEqual(r.status, 403)
  }
  assert.strictEqual(ran, false)
})

test('route: missing or wrong X-Bridge-Key → 403, search never runs', async () => {
  let ran = false
  const search = async () => { ran = true; return { rows: [] } }
  for (const headers of [{}, { 'x-bridge-key': '' }, { 'x-bridge-key': 'b'.repeat(64) }, { 'x-bridge-key': TOKEN.slice(1) }, { authorization: `Bearer ${TOKEN}` }]) {
    const r = await handleFilesSearch({ q: 'invoice' }, headers, { token: TOKEN, nodeConfig: {}, search })
    assert.strictEqual(r.status, 403, JSON.stringify(headers))
  }
  assert.strictEqual(ran, false)
})

test('route: the operator key on a node that turned file search off is STILL refused — the node decides', async () => {
  let ran = false
  const search = async () => { ran = true; return { rows: [row('/x/invoice.pdf')] } }
  const r = await handleFilesSearch({ q: 'invoice' }, ok, { token: TOKEN, nodeConfig: { hive_search: { files: false } }, search })
  assert.strictEqual(r.status, 403)
  assert.strictEqual(r.body.disabled, true)
  assert.strictEqual(r.body.rows[0].disabled, true)
  assert.strictEqual(ran, false)
})

test('route: the right key → results, passed through the patient-data guard', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fsp-'))
  const vault = path.join(home, '.iris', 'vaults', 'v1', 'obj')
  const r = await handleFilesSearch({ q: 'invoice', limit: '5' }, ok, {
    token: TOKEN,
    nodeConfig: {},
    search: fakeSearch([row('/srv/invoice.pdf'), row(vault)]),
    guard: (rows) => require('../lib/file-search-guard').guardSearchResults(rows, { task: null, home, env: {}, nodeConfig: {} })
  })
  assert.strictEqual(r.status, 200)
  assert.strictEqual(r.body.backend, 'plocate')
  assert.deepStrictEqual(r.body.rows.map((x) => x.match), ['/srv/invoice.pdf'], 'the vault path never leaves')
})

test('route: on a machine marked as handling patient data, names are withheld on the direct path too', async () => {
  const r = await handleFilesSearch({ q: 'invoice' }, ok, {
    token: TOKEN,
    nodeConfig: {},
    search: fakeSearch([row('/Users/d/Jane Doe intake.pdf')]),
    guard: (rows) => require('../lib/file-search-guard').guardSearchResults(rows, { task: null, home: '/Users/d', env: {}, nodeConfig: { phi_node: true } })
  })
  assert.strictEqual(r.status, 200)
  assert.ok(!JSON.stringify(r.body).includes('Jane Doe'))
})

test('route: the default guard is the real one (vault paths dropped without injecting a guard)', async () => {
  const vault = path.join(os.homedir(), '.iris', 'vaults', 'v1', 'obj')
  const r = await handleFilesSearch({ q: 'x' }, ok, { token: TOKEN, nodeConfig: {}, search: fakeSearch([row(vault), row('/tmp/x')]) })
  assert.ok(!r.body.rows.some((x) => x.match === vault))
})

test('route: empty or oversized query → 400; limit is clamped', async () => {
  let seen = null
  const search = async (q, o) => { seen = o; return { rows: [] } }
  assert.strictEqual((await handleFilesSearch({}, ok, { token: TOKEN, nodeConfig: {}, search })).status, 400)
  assert.strictEqual((await handleFilesSearch({ q: 'x'.repeat(501) }, ok, { token: TOKEN, nodeConfig: {}, search })).status, 400)
  await handleFilesSearch({ q: 'x', limit: '99999' }, ok, { token: TOKEN, nodeConfig: {}, search })
  assert.strictEqual(seen.limit, 200)
})

test('hive_search task: a node that turned file search off returns the refusal row and never touches the disk', async () => {
  const { fileRowsForSearch } = require('../daemon/file-search-policy')
  let ran = false
  const rows = await fileRowsForSearch('invoice', { nodeConfig: { hive_search: { files: false } }, search: async () => { ran = true; return { rows: [row('/x')] } } })
  assert.strictEqual(ran, false)
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].disabled, true)
})

test('hive_search task: an ordinary node searches, and the engine note is kept', async () => {
  const { fileRowsForSearch } = require('../daemon/file-search-policy')
  const rows = await fileRowsForSearch('invoice', { nodeConfig: {}, search: async () => ({ backend: 'scan', rows: [row('/x/invoice')], note: 'home only' }) })
  assert.deepStrictEqual(rows.map((r) => r.match), ['/x/invoice', '(no file results)'])
})

test('the executor gets its file rows from fileRowsForSearch (the refusal cannot be bypassed by the task path)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'task-executor.js'), 'utf-8')
  assert.match(src, /require\('\.\/file-search-policy'\)\.fileRowsForSearch\(/)
  assert.doesNotMatch(src, /require\('\.\/disk-search'\)\.searchDisk\(/, 'no second, unguarded call to the disk engine')
})
