'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { pickBackend, commandFor, parseOutput, searchDisk } = require('../daemon/disk-search')

const has = (...names) => (n) => (names.includes(n) ? `/bin/${n}` : null)

test('a Mac with fsearch uses it; without, Spotlight — both cover the whole disk (#188665)', () => {
  assert.deepStrictEqual(pickBackend({ platform: 'darwin', which: has('fsearch', 'mdfind') }), { name: 'fsearch', bin: '/bin/fsearch', coverage: 'whole disk', wholeDisk: true })
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
  const r = await searchDisk('invoice', { backend: { name: 'scan', bin: '/bin/find', wholeDisk: false }, run: () => '/home/u/invoice.pdf\n', exists: () => true })
  assert.strictEqual(r.rows[0].source, 'files')
  assert.match(r.rows[0].preview, /scan/)
  const s = await searchDisk('invoice', { backend: { name: 'spotlight', bin: '/usr/bin/mdfind', wholeDisk: true }, run: () => '/a\n/b\n/c\n', limit: 2, exists: () => true })
  assert.strictEqual(s.rows.length, 2)
  assert.match(s.rows[0].preview, /^spotlight · /)
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
  const r = await searchDisk('grep:proofRule', { backend: { name: 'fsearch', bin: '/x', wholeDisk: true }, run: async () => out, exists: () => true })
  assert.strictEqual(r.rows[0].preview, 'line 35: function proofRule (scriptPath) {')
})

const { listProviders, WINDOWS_SEARCH_PS, WINDOWS_SCAN_PS } = require('../daemon/disk-search')

test('each platform lists its own providers in order, and names the one it will use', () => {
  const mac = listProviders({ platform: 'darwin', which: has('mdfind', 'find'), exists: () => false })
  assert.deepStrictEqual(mac.providers.map((p) => p.name), ['fsearch', 'spotlight', 'scan'])
  assert.strictEqual(mac.chosen, 'spotlight')
  assert.match(mac.providers[0].reason, /iris locate setup/)
  const lin = listProviders({ platform: 'linux', which: has('find'), locateDbExists: () => false })
  assert.deepStrictEqual(lin.providers.map((p) => p.name), ['plocate', 'locate', 'scan'])
  assert.strictEqual(lin.chosen, 'scan')
  const win = listProviders({ platform: 'win32', which: has('powershell.exe') })
  assert.deepStrictEqual(win.providers.map((p) => p.name), ['windows-search', 'scan'])
  assert.strictEqual(win.chosen, 'windows-search')
  assert.match(win.providers[0].coverage, /indexed folders/)
})

test('Windows passes the query through the environment — the script text never contains it', () => {
  const evil = "x'; Remove-Item C:\\ -Recurse; '"
  for (const name of ['windows-search', 'scan']) {
    const [bin, args, env] = commandFor({ name, bin: 'powershell.exe' }, evil, 5, 'C:\\Users\\a', 'win32')
    assert.strictEqual(bin, 'powershell.exe')
    assert.ok(!args.join(' ').includes('Remove-Item'), name)
    assert.deepStrictEqual(env, { IRIS_Q: evil, IRIS_N: '5' })
  }
  assert.match(WINDOWS_SEARCH_PS, /-replace "'", "''"/, 'single quotes are doubled for the SQL string')
  assert.match(WINDOWS_SCAN_PS, /WildcardPattern\]::Escape\(\$env:IRIS_Q\)/)
})

test('asking for a provider this machine lacks says why, instead of quietly using another', async () => {
  const r = await searchDisk('x', { provider: 'fsearch', ctx: { platform: 'darwin', which: has('mdfind', 'find'), exists: () => false } })
  assert.deepStrictEqual(r.rows, [])
  assert.match(r.note, /provider fsearch is not available here — not installed/)
  const forced = await searchDisk('x', { provider: 'scan', ctx: { platform: 'darwin', which: has('fsearch', 'mdfind', 'find'), home: '/h' }, run: async () => '/h/x\n' })
  assert.strictEqual(forced.backend, 'scan')
})

// ── TDD, written before the implementation (#188665: fallback, stale results, index age) ──

test('when the chosen engine fails, the next one answers — and the result says it fell back', async () => {
  const ctx = { platform: 'win32', which: has('powershell.exe') }
  const calls = []
  const run = async (bin, args) => {
    const script = args[args.length - 1]
    calls.push(script.includes('SYSTEMINDEX') ? 'windows-search' : 'scan')
    if (script.includes('SYSTEMINDEX')) throw new Error('The Windows Search service is not running')
    return 'C:\\Users\\a\\invoice.pdf\r\n'
  }
  const r = await searchDisk('invoice', { ctx, run, exists: () => true })
  assert.deepStrictEqual(calls, ['windows-search', 'scan'])
  assert.strictEqual(r.backend, 'scan')
  assert.strictEqual(r.rows[0].match, 'C:\\Users\\a\\invoice.pdf')
  assert.match(r.fellBackFrom, /windows-search: The Windows Search service is not running/)
})

test('a provider asked for BY NAME does not fall back — the person asked for that one', async () => {
  const ctx = { platform: 'darwin', which: has('fsearch', 'mdfind', 'find') }
  const r = await searchDisk('x', { provider: 'fsearch', ctx, run: async () => { throw new Error('indexing') } })
  assert.deepStrictEqual(r.rows, [])
  assert.match(r.note, /indexing/)
})

test('fsearch still indexing is a failure to fall back from, not "0 results"', async () => {
  const ctx = { platform: 'darwin', which: has('fsearch', 'mdfind') }
  const run = async (bin) => (bin.endsWith('fsearch') ? '{"ok":false,"error":"indexing (first run scans the whole disk, ~20s)"}' : '/Users/a/x.pdf\n')
  const r = await searchDisk('x', { ctx, run, exists: () => true })
  assert.strictEqual(r.backend, 'spotlight')
  assert.match(r.fellBackFrom, /fsearch: indexing/)
})

test('files an index remembers but the disk no longer has are dropped', async () => {
  const backend = { name: 'plocate', bin: '/bin/plocate', wholeDisk: true, coverage: 'whole disk' }
  const run = async () => '/home/a/kept.txt\n/home/a/deleted.txt\n'
  const r = await searchDisk('a', { backend, run, exists: (p) => p !== '/home/a/deleted.txt' })
  assert.deepStrictEqual(r.rows.map((x) => x.match), ['/home/a/kept.txt'])
  assert.strictEqual(r.dropped_stale, 1)
})

test('Linux providers say how old their index is', () => {
  const now = Date.parse('2026-10-09T12:00:00Z')
  const lin = listProviders({ platform: 'linux', which: has('plocate', 'find'), locateDbExists: () => true, dbMtime: () => now - 3 * 3600e3, now })
  const p = lin.providers.find((x) => x.name === 'plocate')
  assert.match(p.coverage, /indexed 3 h ago/)
})

test('Windows Search finding NOTHING is not the last word — it covers indexed folders only, and lags new files', async () => {
  // Measured on a real Windows runner: a file made seconds earlier → windows-search 0 rows, no error.
  const ctx = { platform: 'win32', which: has('powershell.exe') }
  const run = async (bin, args) => (args[args.length - 1].includes('SYSTEMINDEX') ? '' : 'C:\\Users\\a\\new.txt\r\n')
  const r = await searchDisk('new', { ctx, run, exists: () => true })
  assert.strictEqual(r.backend, 'scan')
  assert.deepStrictEqual(r.rows.map((x) => x.match), ['C:\\Users\\a\\new.txt'])
  assert.match(r.fellBackFrom, /windows-search: no matches in indexed folders/)
})

test('a whole-disk engine finding nothing IS the answer — no pointless 8 s scan after it', async () => {
  const ctx = { platform: 'linux', which: has('plocate', 'find'), locateDbExists: () => true }
  const calls = []
  const run = async (bin) => { calls.push(bin); return '' }
  const r = await searchDisk('nothing', { ctx, run, exists: () => true })
  assert.deepStrictEqual(calls, ['/bin/plocate'])
  assert.strictEqual(r.backend, 'plocate')
})
