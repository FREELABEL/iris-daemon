// #191635 (auth files copied between accounts) and #191633 (our own accounts made into leads).
// Temp dirs and synthetic sessions only — no real instagram-auth file is read, no network.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ig = require('../som/helpers/ig-accounts')
const kdm = require('../som/helpers/keyword-dm')
const { ensureSomSessions } = require('../daemon/task-executor')

function tmp () { return fs.mkdtempSync(path.join(os.tmpdir(), 'som-ig-')) }
function session (userId, extra = {}) {
  return {
    cookies: [
      { name: 'sessionid', value: `${userId}%3Afake`, domain: '.instagram.com', path: '/' },
      { name: 'ds_user_id', value: String(userId), domain: '.instagram.com', path: '/' },
    ],
    origins: [],
    ...extra,
  }
}
function put (dir, handle, obj) {
  const f = path.join(dir, `instagram-auth-${handle}.json`)
  fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2))
  return f
}

// ── owned handles (#191633) ──

test('owned handles come from SOM_OWNED_HANDLES, auth files, the campaign cache and the accounts being read', () => {
  const dir = tmp()
  put(dir, 'thediscoverpage_', session(1))
  put(dir, 'freelabelnet', session(2))
  fs.writeFileSync(path.join(dir, 'instagram-auth.json'), '{}') // legacy file is not a handle
  fs.writeFileSync(path.join(dir, '.som-campaigns-cache.json'), JSON.stringify({ campaigns: {
    beatbox: { boardId: '224', igAccount: 'thebeatbox__', active: true },
    old: { boardId: '9', igAccount: 'OldBrand', active: false },
    none: { boardId: '302', igAccount: null },
  } }))
  const owned = ig.loadOwnedHandles({ somDir: dir, extraDirs: [], env: { SOM_OWNED_HANDLES: '@Extra.One, ', CAPTURE_ACCOUNTS: 'heyiris.io:38', IG_ACCOUNT: 'hourdemayo' } })
  assert.deepStrictEqual([...owned].sort(), ['extra.one', 'freelabelnet', 'heyiris.io', 'hourdemayo', 'oldbrand', 'thebeatbox__', 'thediscoverpage_'])
  assert.ok(ig.isOwnedHandle('@TheDiscoverPage_', owned))
  assert.ok(!ig.isOwnedHandle('thediscoverpage', owned), 'exact handle only — a near miss is someone else')
  assert.ok(!ig.isOwnedHandle('', owned))
})

test('keyword DM never targets any of our accounts, not just the sender', () => {
  const commenters = [
    { username: 'freelabelnet', commentText: 'PIPELINE' },
    { username: 'alice', commentText: 'pipeline please' },
  ]
  const { targets, skipped } = kdm.selectTargets({ commenters, keywords: ['pipeline'], account: 'heyiris.io', handled: new Set(), max: 10, owned: new Set(['freelabelnet', 'heyiris.io']) })
  assert.deepStrictEqual(targets.map(t => t.handle), ['alice'])
  assert.deepStrictEqual(skipped, [{ handle: 'freelabelnet', comment: 'PIPELINE', reason: 'own account' }])
})

// ── identical auth files (#191635) ──

test('identical auth files are found and refused, naming both accounts', () => {
  const dir = tmp()
  const same = JSON.stringify(session(555))
  put(dir, 'freelabelnet', same)
  put(dir, 'thediscoverpage_', same)
  put(dir, 'heyiris.io', session(777))
  const d = ig.findDuplicateAuthFiles(dir)
  assert.strictEqual(d.length, 1)
  assert.deepStrictEqual(d[0].handles, ['freelabelnet', 'thediscoverpage_'])
  assert.strictEqual(d[0].why, 'identical files')
  assert.throws(() => ig.assertDistinctAuthFile(dir, 'thediscoverpage_'),
    (e) => e instanceof ig.DuplicateAuthError && /instagram-auth-freelabelnet\.json/.test(e.message) && /instagram-auth-thediscoverpage_\.json/.test(e.message))
  assert.doesNotThrow(() => ig.assertDistinctAuthFile(dir, 'heyiris.io'))
})

test('two files holding the same logged-in user are duplicates even when the bytes differ', () => {
  const dir = tmp()
  put(dir, 'a.acct', session(42))
  put(dir, 'b.acct', session(42, { origins: [{ origin: 'https://www.instagram.com', localStorage: [] }] }))
  const d = ig.findDuplicateAuthFiles(dir)
  assert.strictEqual(d.length, 1)
  assert.strictEqual(d[0].why, 'the same logged-in Instagram user')
})

// ── writing an auth file ──

test('an auth file is written only for the username the session was verified as', () => {
  const dir = tmp()
  assert.throws(() => ig.writeAuthFile(dir, 'thediscoverpage_', session(1), {}), /nobody checked/)
  assert.throws(() => ig.writeAuthFile(dir, 'thediscoverpage_', session(1), { verifiedUsername: 'freelabelnet' }), /logged in as @freelabelnet/)
  assert.throws(() => ig.writeAuthFile(dir, 'x', { cookies: [] }, { verifiedUsername: 'x' }), /no cookies/)
  assert.ok(!fs.existsSync(path.join(dir, 'instagram-auth-thediscoverpage_.json')))

  const f = ig.writeAuthFile(dir, '@TheDiscoverPage_', session(1), { verifiedUsername: 'thediscoverpage_', now: () => 'T' })
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'))
  assert.deepStrictEqual(saved[ig.STAMP_KEY], { handle: 'thediscoverpage_', userId: '1', verifiedAt: 'T' })
  assert.strictEqual(saved.cookies.length, 2)
})

test('one account\'s login is never saved under another account\'s name', () => {
  const dir = tmp()
  put(dir, 'freelabelnet', session(555))
  assert.throws(() => ig.writeAuthFile(dir, 'thediscoverpage_', session(555), { verifiedUsername: 'thediscoverpage_' }),
    (e) => e instanceof ig.DuplicateAuthError && /instagram-auth-freelabelnet\.json/.test(e.message))
  assert.ok(!fs.existsSync(path.join(dir, 'instagram-auth-thediscoverpage_.json')))
})

test('a cloud session must carry a stamp for this handle and the login it holds', () => {
  assert.match(ig.pulledSessionProblem('a', session(1)), /never verified/)
  assert.match(ig.pulledSessionProblem('a', session(1, { [ig.STAMP_KEY]: { handle: 'b', userId: '1' } })), /@b's login/)
  assert.match(ig.pulledSessionProblem('a', session(2, { [ig.STAMP_KEY]: { handle: 'a', userId: '1' } })), /no longer holds/)
  assert.match(ig.pulledSessionProblem('a', { cookies: [] }), /not logged in/)
  assert.strictEqual(ig.pulledSessionProblem('a', session(1, { [ig.STAMP_KEY]: { handle: 'A', userId: '1' } })), '')
})

// ── the daemon's cloud pull — the writer behind 2026-10-03 and 2026-10-26 ──

function fakeFetch (byBoard) {
  const calls = []
  const fn = async (url) => {
    calls.push(url)
    const board = new URL(url).searchParams.get('bloq_id')
    const cred = byBoard[board]
    if (!cred) return { ok: false, status: 404, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => ({ credentials: cred }) }
  }
  fn.calls = calls
  return fn
}
const deps = (fetch) => ({ fetch, identity: { userId: 193, token: 't' }, apiBase: 'http://cloud.test', log: () => {} })

test('a board shared by two accounts is never pulled into either account\'s file', async () => {
  const dir = tmp()
  // Board 80's single slot holds @freelabelnet's login, as it did on iris-hive-001.
  const fetch = fakeFetch({ 80: session(555, { [ig.STAMP_KEY]: { handle: 'freelabelnet', userId: '555' } }) })
  const configs = {
    creators: { boardId: '80', igAccount: 'thediscoverpage_' },
    freelabelnet: { boardId: '80', igAccount: 'freelabelnet' },
  }
  const r = await ensureSomSessions(dir, configs, deps(fetch))
  assert.deepStrictEqual(fs.readdirSync(dir), [])
  assert.deepStrictEqual(fetch.calls, [])
  assert.deepStrictEqual(r.missing.sort(), ['freelabelnet', 'thediscoverpage_'])
  assert.match(r.refused[0].reason, /shared by @freelabelnet and @thediscoverpage_/)
})

test('an unverified or wrong-account cloud session is not written; a verified one is', async () => {
  const dir = tmp()
  const fetch = fakeFetch({
    1: session(11), // never verified
    2: session(22, { [ig.STAMP_KEY]: { handle: 'someoneelse', userId: '22' } }),
    3: session(33, { [ig.STAMP_KEY]: { handle: 'gamma', userId: '33', verifiedAt: 'V' } }),
    // stamped as @delta, but the login inside was replaced since — not the one verified
    4: session(44, { [ig.STAMP_KEY]: { handle: 'delta', userId: '99' } }),
  })
  const configs = { a: { boardId: 1, igAccount: 'alpha' }, b: { boardId: 2, igAccount: 'beta' }, c: { boardId: 3, igAccount: 'gamma' }, d: { boardId: 4, igAccount: 'delta' } }
  const r = await ensureSomSessions(dir, configs, deps(fetch))
  assert.deepStrictEqual(fs.readdirSync(dir), ['instagram-auth-gamma.json'])
  assert.deepStrictEqual(r.missing.sort(), ['alpha', 'beta', 'delta'])
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'instagram-auth-gamma.json'), 'utf8'))
  assert.deepStrictEqual(saved[ig.STAMP_KEY], { handle: 'gamma', userId: '33', verifiedAt: 'V' })
})

test('a pulled login that another local account already holds is refused', async () => {
  const dir = tmp()
  put(dir, 'freelabelnet', session(555))
  const fetch = fakeFetch({ 7: session(555, { [ig.STAMP_KEY]: { handle: 'thediscoverpage_', userId: '555' } }) })
  const r = await ensureSomSessions(dir, { c: { boardId: 7, igAccount: 'thediscoverpage_' } }, deps(fetch))
  assert.ok(!fs.existsSync(path.join(dir, 'instagram-auth-thediscoverpage_.json')))
  assert.match(r.refused[0].reason, /instagram-auth-freelabelnet\.json already holds/)
})

test('stamping a verified file is idempotent and keeps the session', () => {
  const dir = tmp()
  put(dir, 'gamma', session(33))
  assert.strictEqual(ig.stampVerifiedAuthFile(dir, 'gamma', { now: () => 'T' }), true)
  assert.strictEqual(ig.stampVerifiedAuthFile(dir, 'gamma', { now: () => 'T2' }), false)
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'instagram-auth-gamma.json'), 'utf8'))
  assert.strictEqual(saved[ig.STAMP_KEY].verifiedAt, 'T')
  assert.strictEqual(ig.sessionUserId(saved), '33')
})
