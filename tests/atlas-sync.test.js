// #189972 stage 3: the daemon keeps opted-in local copies of Atlas datasets in step by running
// `iris atlas:datasets sync` — the CLI is the one implementation of pull/merge/push.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { findStores, runOnce } = require('../lib/atlas-sync')

function store (root, slug, state) {
  const d = path.join(root, slug, '.iris')
  fs.mkdirSync(d, { recursive: true })
  if (state) fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify(state))
  return path.join(root, slug)
}

// A stand-in `iris`: appends its argv to a log and prints what the real `sync --json` prints.
function fakeIris (dir, { exitCode = 0, body } = {}) {
  const bin = path.join(dir, 'iris')
  const log = path.join(dir, 'calls.log')
  const out = JSON.stringify(body || { pull: { written: 1, merged: 0, removed: 0, conflicts: {} }, push: { created: 0, updated: 2, deleted: 0, refused: [] } })
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@" >> '${log}'\necho '${out}'\nexit ${exitCode}\n`)
  fs.chmodSync(bin, 0o755)
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) }
}

test('only copies that opted in to background sync are found', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-'))
  store(root, 'cases', { slug: 'cases', background: true })
  store(root, 'leads', { slug: 'leads', background: false })
  store(root, 'notes', null)                       // pulled, never opted in
  assert.deepStrictEqual(findStores(root).map((s) => s.slug), ['cases'])
  assert.deepStrictEqual(findStores(path.join(root, 'missing')), [])
})

test('runs the CLI sync for each opted-in copy and reports what moved', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-'))
  const dir = store(root, 'cases', { slug: 'cases', background: true })
  const iris = fakeIris(root)
  const r = await runOnce({ root, irisBin: iris.bin })
  assert.deepStrictEqual(iris.calls(), [`atlas:datasets sync cases --dir ${dir} --json`])
  assert.strictEqual(r.datasets.length, 1)
  assert.deepStrictEqual(r.datasets[0], { slug: 'cases', ok: true, pulled: 1, pushed: 2, conflicts: 0, refused: 0 })
})

test('a sync with conflicts or refusals is reported, not treated as a crash', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-'))
  store(root, 'cases', { slug: 'cases', background: true })
  const iris = fakeIris(root, { exitCode: 2, body: { pull: { written: 0, merged: 1, removed: 0, conflicts: { 12: ['note'] } }, push: { created: 0, updated: 0, deleted: 0, refused: [{ id: 12 }] } } })
  const r = await runOnce({ root, irisBin: iris.bin })
  assert.deepStrictEqual(r.datasets[0], { slug: 'cases', ok: true, pulled: 1, pushed: 0, conflicts: 1, refused: 1 })
})

test('a failing sync is recorded with its reason and does not stop the others', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-'))
  store(root, 'a', { slug: 'a', background: true })
  store(root, 'b', { slug: 'b', background: true })
  const bin = path.join(root, 'iris')
  fs.writeFileSync(bin, '#!/bin/sh\nif [ "$3" = a ]; then echo "not signed in" >&2; exit 1; fi\necho \'{"pull":{"written":0,"merged":0,"removed":0,"conflicts":{}},"push":{"created":0,"updated":0,"deleted":0,"refused":[]}}\'\n')
  fs.chmodSync(bin, 0o755)
  const r = await runOnce({ root, irisBin: bin })
  assert.strictEqual(r.datasets.find((d) => d.slug === 'a').ok, false)
  assert.match(r.datasets.find((d) => d.slug === 'a').error, /not signed in/)
  assert.strictEqual(r.datasets.find((d) => d.slug === 'b').ok, true)
})

test('no CLI, no run — and it says so', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-'))
  store(root, 'cases', { slug: 'cases', background: true })
  const r = await runOnce({ root, irisBin: null })
  assert.strictEqual(r.skipped, 'IRIS CLI not found')
})
