// Comment a keyword, get a DM (FL-CO-47, #190735). Every rule that decides who is messaged lives in
// som/helpers/keyword-dm.js; these pin them without a browser or an Instagram login.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const k = require('../som/helpers/keyword-dm')

const POST = 'https://www.instagram.com/p/DAbc123_x/'

test('keywords: comma-separated, trimmed, lowercased, # dropped, no duplicates', () => {
  assert.deepStrictEqual(k.parseKeywords(' PIPELINE, #Guide ,pipeline,, '), ['pipeline', 'guide'])
  assert.deepStrictEqual(k.parseKeywords(''), [])
  assert.deepStrictEqual(k.parseKeywords(undefined), [])
})

test('a keyword matches as a whole word, any case, with punctuation or emoji around it', () => {
  const kw = ['pipeline']
  for (const c of ['PIPELINE', 'pipeline please', 'Pipeline!', '#pipeline 🙏', 'send the PIPELINE.', '🔥PIPELINE🔥', '"pipeline"']) {
    assert.strictEqual(k.matchKeyword(c, kw), 'pipeline', c)
  }
  for (const c of ['pipelines', 'mypipeline', 'pipe line', 'pipeline_v2', '', 'great post']) {
    assert.strictEqual(k.matchKeyword(c, kw), null, c)
  }
  assert.strictEqual(k.matchKeyword('guide pls', ['pipeline', 'guide']), 'guide')
  assert.strictEqual(k.matchKeyword('a.b', ['a.b']), 'a.b', 'regex characters are literal')
  assert.strictEqual(k.matchKeyword('axb', ['a.b']), null)
})

test('cap: default 10, ceiling 25, junk falls back to the default', () => {
  assert.strictEqual(k.clampMax(undefined), 10)
  assert.strictEqual(k.clampMax('abc'), 10)
  assert.strictEqual(k.clampMax(0), 10)
  assert.strictEqual(k.clampMax(-3), 10)
  assert.strictEqual(k.clampMax(3), 3)
  assert.strictEqual(k.clampMax('25'), 25)
  assert.strictEqual(k.clampMax(100), 25)
})

test('dry run is on unless DRY_RUN is exactly 0 or false', () => {
  for (const v of [undefined, '', '1', 'true', 'yes', 'no', 'off', ' 2 ']) assert.strictEqual(k.isDryRun(v), true, String(v))
  for (const v of ['0', 'false', 'FALSE', ' 0 ']) assert.strictEqual(k.isDryRun(v), false, v)
})

test('template fills every {handle} without the @', () => {
  assert.strictEqual(k.fillTemplate('hey @{handle}, here: x.co — {handle}!', '@jane.doe'), 'hey @jane.doe, here: x.co — jane.doe!')
  assert.strictEqual(k.fillTemplate('no placeholder', 'jane'), 'no placeholder')
})

test('post key is the shortcode: /p/, /reel/, query strings and trailing slashes are one post', () => {
  assert.strictEqual(k.postKey(POST), 'DAbc123_x')
  assert.strictEqual(k.postKey('https://instagram.com/reel/DAbc123_x?igsh=zz'), 'DAbc123_x')
  assert.strictEqual(k.postKey('https://www.instagram.com/heyiris.io/p/DAbc123_x/'), 'DAbc123_x')
  assert.strictEqual(k.postKey('https://www.instagram.com/heyiris.io/'), null)
  assert.strictEqual(k.postKey('https://example.com/p/abc'), null)
  assert.strictEqual(k.postKey(''), null)
})

const commenters = [
  { username: 'heyiris.io', commentText: 'Comment PIPELINE below' },
  { username: 'Alice', commentText: 'PIPELINE' },
  { username: 'bob', commentText: 'love this' },
  { username: 'carol', commentText: 'pipeline pls' },
  { username: 'alice', commentText: 'pipeline again' },
  { username: 'dave', commentText: 'pipelines?' },
  { username: 'erin', commentText: '#Pipeline' },
  { username: 'frank', commentText: 'PIPELINE 🙌' },
]

test('targets: keyword commenters only, own account and repeats skipped, in page order', () => {
  const { targets, skipped } = k.selectTargets({ commenters, keywords: ['pipeline'], account: '@HeyIris.io', handled: new Set(), max: 10 })
  assert.deepStrictEqual(targets.map(t => t.handle), ['alice', 'carol', 'erin', 'frank'])
  assert.deepStrictEqual(skipped, [{ handle: 'heyiris.io', comment: 'Comment PIPELINE below', reason: 'own account' }])
  assert.strictEqual(targets[0].comment, 'PIPELINE')
})

test('targets: the ledger and the cap both skip, and say why', () => {
  const { targets, skipped } = k.selectTargets({ commenters, keywords: ['pipeline'], account: 'heyiris.io', handled: new Set(['carol']), max: 2 })
  assert.deepStrictEqual(targets.map(t => t.handle), ['alice', 'erin'])
  assert.deepStrictEqual(skipped.map(s => `${s.handle}:${s.reason}`), ['heyiris.io:own account', 'carol:already in ledger', 'frank:over cap (2)'])
})

test('targets: the cap can never exceed 25 however many people ask', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ username: `u${i}`, commentText: 'PIPELINE' }))
  const { targets, skipped } = k.selectTargets({ commenters: many, keywords: ['pipeline'], account: 'x', handled: new Set(), max: 500 })
  assert.strictEqual(targets.length, 25)
  assert.strictEqual(skipped.length, 35)
})

test('ledger: dry runs and logged-out failures do not block a send; real attempts do', () => {
  const ledger = { posts: {} }
  k.appendLedger(ledger, POST, [
    { handle: 'dry1', status: 'dry', dry: true },
    { handle: 'sent1', status: 'sent', delivered: true, dry: false },
    { handle: 'unconfirmed', status: 'failed', error: 'message typed but not confirmed in chat', dry: false },
    { handle: 'private', status: 'failed', error: 'could not open DM view (private/DM-restricted?)', dry: false },
    { handle: 'loggedout', status: 'failed', error: 'session expired', dry: false },
  ])
  assert.deepStrictEqual([...k.handledHandles(ledger, POST)].sort(), ['private', 'sent1', 'unconfirmed'])
  assert.deepStrictEqual([...k.handledHandles(ledger, 'https://www.instagram.com/p/OTHER/')], [], 'per post')
  assert.deepStrictEqual([...k.handledHandles(ledger, 'https://instagram.com/reel/DAbc123_x')].length, 3, 'same post via /reel/')
})

test('ledger: round-trips through a file, and a missing or corrupt file reads as empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdm-'))
  const file = path.join(dir, 'nested', 'ledger.json')
  assert.deepStrictEqual(k.readLedger(file), { posts: {} })
  k.writeLedger(file, k.appendLedger(k.readLedger(file), POST, [{ handle: 'a', status: 'sent', dry: false }]))
  k.writeLedger(file, k.appendLedger(k.readLedger(file), POST, [{ handle: 'b', status: 'sent', dry: false }]))
  const back = k.readLedger(file)
  assert.deepStrictEqual(k.ledgerEntries(back, POST).map(e => e.handle), ['a', 'b'])
  assert.strictEqual(back.posts.DAbc123_x.postUrl, POST)
  fs.writeFileSync(file, '{not json')
  assert.deepStrictEqual(k.readLedger(file), { posts: {} })
  assert.throws(() => k.appendLedger({ posts: {} }, 'https://example.com', []))
})

test('a logged-out or challenged send stops the run; an ordinary failure does not', () => {
  assert.strictEqual(k.isSessionStop({ status: 'failed', error: 'session expired' }), true)
  assert.strictEqual(k.isSessionStop({ status: 'failed', error: 'challenge required' }), true)
  assert.strictEqual(k.isSessionStop({ status: 'failed', error: 'account not found' }), false)
  assert.strictEqual(k.isSessionStop({ status: 'sent', delivered: true }), false)
})

test('send gaps jitter around the base by ±40%', () => {
  assert.strictEqual(k.jitterDelay(45000, () => 0.5), 45000)
  assert.strictEqual(k.jitterDelay(45000, () => 0), 27000)
  assert.strictEqual(k.jitterDelay(45000, () => 1), 63000)
})

test('result line round-trips and the last one wins over noise', () => {
  const out = `noise\n${k.formatResultLine({ sent: 1 })}\n  ${k.formatResultLine({ sent: 2 })}\n[list] 1 passed\n`
  assert.deepStrictEqual(k.parseResultLine(out), { sent: 2 })
  assert.strictEqual(k.parseResultLine('nothing here'), null)
})

test('route body: only send === true sends; everything else is a dry run', () => {
  const base = { postUrl: POST, keyword: 'PIPELINE', message: 'here you go' }
  for (const send of [undefined, false, 'true', 1, 'yes']) {
    const r = k.buildRunEnv({ ...base, send })
    assert.strictEqual(r.dry, true, String(send))
    assert.strictEqual(r.env.DRY_RUN, '1')
  }
  const live = k.buildRunEnv({ ...base, send: true, max: 99, account: '@heyiris.io' })
  assert.strictEqual(live.dry, false)
  assert.deepStrictEqual(
    { DRY_RUN: live.env.DRY_RUN, MAX_SENDS: live.env.MAX_SENDS, IG_ACCOUNT: live.env.IG_ACCOUNT, KEYWORD: live.env.KEYWORD },
    { DRY_RUN: '0', MAX_SENDS: '25', IG_ACCOUNT: 'heyiris.io', KEYWORD: 'pipeline' },
  )
  assert.strictEqual(k.buildRunEnv(base).env.IG_ACCOUNT, undefined, 'no account → route picks the saved session')
})

test('route body: bad input is refused before any browser starts', () => {
  const base = { postUrl: POST, keyword: 'PIPELINE', message: 'hi' }
  assert.match(k.buildRunEnv({ ...base, postUrl: 'https://www.instagram.com/heyiris.io/' }).error, /postUrl/)
  assert.match(k.buildRunEnv({ ...base, keyword: ' , ' }).error, /keyword/)
  assert.match(k.buildRunEnv({ ...base, message: '   ' }).error, /message/)
  assert.match(k.buildRunEnv({ ...base, message: 'x'.repeat(1001) }).error, /1000/)
  assert.match(k.buildRunEnv({ ...base, account: 'a b; rm -rf' }).error, /account/)
  assert.match(k.buildRunEnv(null).error, /postUrl/)
})

test('the route exists, runs the spec without blocking the event loop, and never schedules itself', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
  assert.match(src, /app\.post\('\/api\/instagram\/keyword-dm'/)
  assert.match(src, /app\.get\('\/api\/instagram\/keyword-dm\/ledger'/)
  const start = src.indexOf("app.post('/api/instagram/keyword-dm'")
  const block = src.slice(start, src.indexOf("app.get('/api/instagram/keyword-dm/ledger'"))
  assert.match(block, /keywordDm\.buildRunEnv\(req\.body\)/)
  assert.match(block, /spawn\('npx'/)
  assert.doesNotMatch(block, /execSync|setInterval|cron/)
  const spec = fs.readFileSync(path.join(__dirname, '..', 'som', 'instagram-keyword-dm.spec.ts'), 'utf8')
  assert.doesNotMatch(spec, /setInterval|cron|repeat/i)
})
