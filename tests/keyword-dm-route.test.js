// POST /api/instagram/keyword-dm and its ledger (FL-CO-47, #190735), driven over HTTP with a fake
// spawn: no Playwright, no Instagram. What the route hands the spec is what decides whether people
// get messaged, so that is what these check.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { EventEmitter } = require('events')
const express = require('express')
const { mountKeywordDm } = require('../lib/keyword-dm-route')
const k = require('../som/helpers/keyword-dm')

const POST = 'https://www.instagram.com/p/DAbc123_x/'

function fixtureRoot () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kdm-route-'))
  fs.mkdirSync(path.join(root, 'som'))
  fs.writeFileSync(path.join(root, 'som', 'instagram-auth-heyiris.io.json'), '{"cookies":[]}')
  return root
}

function fakeSpawn (calls, { summary = { ok: true, sent: 0 }, hold = false } = {}) {
  return (cmd, args, opts) => {
    const p = new EventEmitter()
    p.pid = 424242 + calls.length
    p.stdout = new EventEmitter()
    p.stderr = new EventEmitter()
    p.kill = () => { p.killed = true; setImmediate(() => p.emit('close', null)) }
    calls.push({ cmd, args, opts, proc: p })
    if (!hold) {
      setImmediate(() => {
        p.stdout.emit('data', Buffer.from(`noise\n${k.formatResultLine(summary)}\n`))
        p.emit('close', 0)
      })
    }
    return p
  }
}

async function serve (opts) {
  const app = express()
  app.use(express.json())
  mountKeywordDm(app, { log: () => {}, somLockFile: path.join(os.tmpdir(), 'no-such-som-lock'), ...opts })
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, close: () => new Promise((r) => server.close(r)) }
}

const post = (base, body, signal) => fetch(`${base}/api/instagram/keyword-dm`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
})

test('without send:true the spec runs as a dry run; the summary comes back as JSON', async () => {
  const calls = []
  const s = await serve({ rootDir: fixtureRoot(), spawn: fakeSpawn(calls, { summary: { ok: true, dry: true, targets: [{ handle: 'alice' }] } }) })
  try {
    const r = await post(s.base, { postUrl: POST, keyword: 'PIPELINE', message: 'hi', account: 'heyiris.io', send: 'true' })
    assert.strictEqual(r.status, 200)
    const body = await r.json()
    assert.deepStrictEqual(body.targets, [{ handle: 'alice' }])
    assert.strictEqual(calls.length, 1)
    const { cmd, args, opts } = calls[0]
    assert.strictEqual(cmd, 'npx')
    assert.deepStrictEqual(args.slice(0, 3), ['playwright', 'test', 'som/instagram-keyword-dm.spec.ts'])
    assert.strictEqual(opts.env.DRY_RUN, '1')
    assert.strictEqual(opts.env.KEYWORD, 'pipeline')
    assert.strictEqual(opts.env.IG_ACCOUNT, 'heyiris.io')
    assert.match(opts.env.BROWSER_SESSION_FILE, /instagram-auth-heyiris\.io\.json$/)
    assert.strictEqual(opts.detached, true)
  } finally { await s.close() }
})

test('send:true with a confirmed list sends to that list only, capped', async () => {
  const calls = []
  const s = await serve({ rootDir: fixtureRoot(), spawn: fakeSpawn(calls) })
  try {
    const r = await post(s.base, { postUrl: POST, keyword: 'pipeline', message: 'hi {handle}', account: 'heyiris.io', send: true, max: 80, handles: ['alice', '@Erin'] })
    assert.strictEqual(r.status, 200)
    const env = calls[0].opts.env
    assert.deepStrictEqual([env.DRY_RUN, env.MAX_SENDS, env.ONLY_HANDLES, env.MESSAGE], ['0', '25', 'alice,erin', 'hi {handle}'])
  } finally { await s.close() }
})

test('bad input and a missing session are refused before anything is spawned', async () => {
  const calls = []
  const s = await serve({ rootDir: fixtureRoot(), spawn: fakeSpawn(calls) })
  try {
    assert.strictEqual((await post(s.base, { postUrl: 'https://x.com/p/1', keyword: 'a', message: 'b' })).status, 400)
    assert.strictEqual((await post(s.base, { postUrl: POST, keyword: '', message: 'b' })).status, 400)
    const r = await post(s.base, { postUrl: POST, keyword: 'a', message: 'b', account: 'someoneelse' })
    assert.strictEqual(r.status, 404)
    assert.match((await r.json()).error, /save-session/)
    assert.strictEqual(calls.length, 0)
  } finally { await s.close() }
})

test('one run at a time; the caller hanging up stops the run', async () => {
  const calls = []
  const s = await serve({ rootDir: fixtureRoot(), spawn: fakeSpawn(calls, { hold: true }) })
  const killed = []
  const realKill = process.kill
  process.kill = (pid, sig) => { if (pid < 0) { killed.push([pid, sig]); calls[0].proc.kill(); return true } return realKill.call(process, pid, sig) }
  try {
    const ac = new AbortController()
    const first = post(s.base, { postUrl: POST, keyword: 'a', message: 'b', account: 'heyiris.io' }, ac.signal).catch(e => e)
    await new Promise(r => setTimeout(r, 100))
    const second = await post(s.base, { postUrl: POST, keyword: 'a', message: 'b', account: 'heyiris.io' })
    assert.strictEqual(second.status, 409)
    const ledger = await (await fetch(`${s.base}/api/instagram/keyword-dm/ledger?postUrl=${encodeURIComponent(POST)}`)).json()
    assert.strictEqual(ledger.running.pid, calls[0].proc.pid)
    ac.abort()
    await first
    await new Promise(r => setTimeout(r, 100))
    assert.deepStrictEqual(killed, [[-calls[0].proc.pid, 'SIGTERM']])
    const after = await (await fetch(`${s.base}/api/instagram/keyword-dm/ledger?postUrl=${encodeURIComponent(POST)}`)).json()
    assert.strictEqual(after.running, null)
  } finally { process.kill = realKill; await s.close() }
})

test('a live SOM batch holding the lock blocks a run', async () => {
  const lock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kdm-lock-')), 'som_batch.lock')
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, started: Date.now() }))
  const calls = []
  const s = await serve({ rootDir: fixtureRoot(), spawn: fakeSpawn(calls), somLockFile: lock })
  try {
    const r = await post(s.base, { postUrl: POST, keyword: 'a', message: 'b', account: 'heyiris.io' })
    assert.strictEqual(r.status, 409)
    assert.match((await r.json()).error, /SOM batch/)
    assert.strictEqual(calls.length, 0)
  } finally { await s.close() }
})

test('a run that prints no result line is a 500 with the output tail, not a fake success', async () => {
  const calls = []
  const spawn = (cmd, args, opts) => {
    const p = new EventEmitter(); p.pid = 9; p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => {}
    calls.push(p)
    setImmediate(() => { p.stderr.emit('data', Buffer.from('Error: browserType.launch: Executable does not exist')); p.emit('close', 1) })
    return p
  }
  const s = await serve({ rootDir: fixtureRoot(), spawn })
  try {
    const r = await post(s.base, { postUrl: POST, keyword: 'a', message: 'b', account: 'heyiris.io' })
    assert.strictEqual(r.status, 500)
    assert.match((await r.json()).output, /Executable does not exist/)
  } finally { await s.close() }
})

test('ledger: returns this post\'s entries and the count actually sent', async () => {
  const ledgerFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kdm-ledger-')), 'l.json')
  k.writeLedger(ledgerFile, k.appendLedger({ posts: {} }, POST, [
    { handle: 'a', status: 'sent', dry: false }, { handle: 'b', status: 'dry', dry: true }, { handle: 'c', status: 'failed', dry: false },
  ]))
  const s = await serve({ rootDir: fixtureRoot(), spawn: fakeSpawn([]), ledgerFile })
  try {
    const body = await (await fetch(`${s.base}/api/instagram/keyword-dm/ledger?postUrl=${encodeURIComponent('https://instagram.com/reel/DAbc123_x')}`)).json()
    assert.strictEqual(body.key, 'DAbc123_x')
    assert.deepStrictEqual(body.entries.map(e => e.handle), ['a', 'b', 'c'])
    assert.strictEqual(body.sent, 1)
    assert.strictEqual((await fetch(`${s.base}/api/instagram/keyword-dm/ledger?postUrl=nope`)).status, 400)
  } finally { await s.close() }
})
