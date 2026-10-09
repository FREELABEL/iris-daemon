'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { pickBackend, commandFor, parseOutput, searchDisk } = require('../daemon/disk-search')

const has = (...names) => (n) => (names.includes(n) ? `/bin/${n}` : null)

test('a Mac with fsearch uses it; without, Spotlight — both cover the whole disk (#188665)', () => {
  assert.deepStrictEqual(pickBackend({ platform: 'darwin', which: has('fsearch', 'mdfind') }), { name: 'fsearch', bin: '/bin/fsearch', wholeDisk: true })
  assert.strictEqual(pickBackend({ platform: 'darwin', which: has('mdfind') }).name, 'spotlight')
})

test('Linux uses locate only when its database exists, otherwise a scan labelled as NOT whole-disk', () => {
  assert.strictEqual(pickBackend({ platform: 'linux', which: has('plocate', 'find'), locateDbExists: () => true }).name, 'plocate')
  const scan = pickBackend({ platform: 'linux', which: has('plocate', 'find'), locateDbExists: () => false })
  assert.strictEqual(scan.name, 'scan')
  assert.strictEqual(scan.wholeDisk, false)
  assert.strictEqual(pickBackend({ platform: 'linux', which: has('fsearch', 'find'), locateDbExists: () => false }).name, 'scan', 'fsearch is macOS-only')
})

test('the query is one argv element — shell text in it stays text', () => {
  const evil = 'x"; rm -rf ~; echo "'
  for (const name of ['fsearch', 'spotlight', 'plocate', 'scan']) {
    const [, args] = commandFor({ name, bin: '/bin/x' }, evil, 5, '/home/u')
    assert.ok(args.some((a) => a.includes(evil.replace(/[\\*?[\]]/g, (c) => '\\' + c))), name)
  }
  const [, scanArgs] = commandFor({ name: 'scan', bin: '/bin/find' }, 'a*b', 5, '/home/u')
  assert.ok(scanArgs.includes('*a\\*b*'), "the user's * is literal, not a wildcard")
})

test('fsearch JSON hits are read; an fsearch error surfaces instead of reading as "nothing found"', () => {
  const out = '{"ok":true,"took_us":812,"hits":[{"path":"/Users/a/Invoice March.pdf","score":9},{"path":"/Users/a/x"}]}\n'
  assert.deepStrictEqual(parseOutput({ name: 'fsearch' }, out, 1), [{ path: '/Users/a/Invoice March.pdf', score: 9 }])
  assert.throws(() => parseOutput({ name: 'fsearch' }, '{"ok":false,"error":"no index yet"}', 5), /no index yet/)
})

test('rows say which index answered, so a home-folder scan is never mistaken for the whole disk', async () => {
  const r = await searchDisk('invoice', { backend: { name: 'scan', bin: '/bin/find', wholeDisk: false }, run: () => '/home/u/invoice.pdf\n' })
  assert.strictEqual(r.rows[0].source, 'files')
  assert.match(r.rows[0].preview, /home-folder scan/)
  const s = await searchDisk('invoice', { backend: { name: 'spotlight', bin: '/usr/bin/mdfind', wholeDisk: true }, run: () => '/a\n/b\n/c\n', limit: 2 })
  assert.strictEqual(s.rows.length, 2)
  assert.match(s.rows[0].preview, /found by spotlight/)
})

test('a failing backend reports why, and no backend at all says so', async () => {
  const f = await searchDisk('x', { backend: { name: 'spotlight', bin: '/x', wholeDisk: true }, run: () => { throw new Error('mds is off') } })
  assert.match(f.note, /mds is off/)
  assert.strictEqual((await searchDisk('x', { backend: null })).note, 'no file index on this node')
})

test('a line-based backend is stopped as soon as it has enough paths, not at the time box', async () => {
  const { runBackend } = require('../daemon/disk-search')
  const t0 = Date.now()
  const out = await runBackend('/usr/bin/yes', ['/x/hit'], { limit: 2, timeoutMs: 5000 })
  assert.ok(out.split('\n').filter(Boolean).length >= 2)
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`)
})

test('a backend that exits non-zero with no output means "no matches", not a failure', async () => {
  const r = await searchDisk('zzz', { backend: { name: 'scan', bin: '/bin/false', wholeDisk: false } })
  assert.deepStrictEqual(r.rows, [])
  assert.strictEqual(r.note, undefined)
})

test('a search inside files (grep:) returns each file with its first matching line', async () => {
  const out = '{"ok":true,"files":[{"path":"/Users/a/pr-proof.js","matches":[{"line":35,"text":"function proofRule (scriptPath) {"}]}]}'
  assert.deepStrictEqual(parseOutput({ name: 'fsearch' }, out, 5), [{ path: '/Users/a/pr-proof.js', line: 35, text: 'function proofRule (scriptPath) {' }])
  const r = await searchDisk('grep:proofRule', { backend: { name: 'fsearch', bin: '/x', wholeDisk: true }, run: async () => out })
  assert.strictEqual(r.rows[0].preview, 'line 35: function proofRule (scriptPath) {')
})
