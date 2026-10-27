// clip_cutter download=hive (#191214): YouTube blocks the server's IPs, so the node downloads the
// clip's section and hands it to fl-api through a pre-signed R2 upload.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { toSeconds, sectionArg, resolveYtDlp, run } = require('../daemon/clip-hive-download')
const { statusForExit } = require('../daemon/task-executor')

test('times parse the way fl-api writes them', () => {
  assert.strictEqual(toSeconds('0:10'), 10)
  assert.strictEqual(toSeconds('1:02:03'), 3723)
  assert.strictEqual(toSeconds('90s'), 90)
  assert.strictEqual(toSeconds(45), 45)
  assert.strictEqual(sectionArg('0:10', '90s'), '*10-100')
})

test('yt-dlp is found by override, then PATH, then python module', () => {
  assert.deepStrictEqual(resolveYtDlp({ YTDLP_PATH: '/x/yt' }, () => false), ['/x/yt'])
  assert.deepStrictEqual(resolveYtDlp({}, (c) => c === 'yt-dlp'), ['yt-dlp'])
  assert.deepStrictEqual(resolveYtDlp({}, (c) => c === 'python3'), ['python3', '-m', 'yt_dlp'])
  assert.strictEqual(resolveYtDlp({}, () => false), null)
})

test('a failed clip task is failed, not "completed with warnings"', () => {
  assert.strictEqual(statusForExit('clip_cutter', 1), 'failed')
})

function fakeYtDlp (dir, { fail } = {}) {
  const p = path.join(dir, 'yt-dlp')
  fs.writeFileSync(p, fail
    ? '#!/bin/sh\necho "ERROR: Sign in to confirm you\'re not a bot" >&2\nexit 1\n'
    : '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done; echo "$@" > "$2.args"; head -c 4096 /dev/zero > "$2"\n')
  fs.chmodSync(p, 0o755)
  return p
}

function fakeApi (pick) {
  const calls = []
  global.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method, body: opts.body })
    const reply = (status, json) => ({ ok: status < 300, status, text: async () => JSON.stringify(json) })
    if (url.endsWith('/clips/cut-scheduled')) return reply(200, pick)
    if (url.startsWith('https://r2.example/')) return reply(200, {})
    if (url.includes('/source-ready')) return reply(200, { success: true, status: 'pending' })
    return reply(404, {})
  }
  return calls
}

test('pick -> download the section -> PUT to R2 -> source-ready, in that order', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chd-'))
  process.env.YTDLP_PATH = fakeYtDlp(dir)
  const calls = fakeApi({ job_id: 42, youtube_url: 'https://www.youtube.com/watch?v=abc', start: '0:10', duration: '90s', title: 'T',
    upload: { upload_url: 'https://r2.example/clips/sources/42.mp4?sig=1', method: 'PUT', headers: { 'Content-Type': 'video/mp4' } } })

  const r = await run({ api: 'https://api.example', token: 't', body: { brand: 'discover' }, log: () => {} })

  assert.strictEqual(r.job_id, 42)
  assert.deepStrictEqual(calls.map(c => c.method + ' ' + c.url.split('?')[0]), [
    'POST https://api.example/api/v1/clips/cut-scheduled',
    'PUT https://r2.example/clips/sources/42.mp4',
    'POST https://api.example/api/v1/clips/42/source-ready'])
  assert.strictEqual(JSON.parse(calls[0].body).hive_download, true)
  assert.strictEqual(calls[1].body.length, 4096) // the downloaded bytes, not a path
  delete process.env.YTDLP_PATH
})

test('nothing fresh to clip: no download, no upload', async () => {
  process.env.YTDLP_PATH = '/bin/false'
  const calls = fakeApi({ job_id: null, message: 'No unclipped video published in the last 72h' })
  const r = await run({ api: 'https://api.example', token: 't', body: {}, log: () => {} })
  assert.strictEqual(r.job_id, null)
  assert.strictEqual(calls.length, 1)
  delete process.env.YTDLP_PATH
})

test('a failed download never reports ready', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chd-'))
  process.env.YTDLP_PATH = fakeYtDlp(dir, { fail: true })
  const calls = fakeApi({ job_id: 7, youtube_url: 'u', start: '0:10', duration: '90s', upload: { upload_url: 'https://r2.example/x' } })
  await assert.rejects(run({ api: 'https://api.example', token: 't', body: {}, log: () => {} }), /bot check on this node too/)
  assert.ok(!calls.some(c => c.url.includes('source-ready')))
  delete process.env.YTDLP_PATH
})

test('a refused R2 upload never reports ready', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chd-'))
  process.env.YTDLP_PATH = fakeYtDlp(dir)
  const calls = fakeApi({ job_id: 9, youtube_url: 'u', start: '0:10', duration: '90s', upload: { upload_url: 'https://r2.denied/x' } })
  const base = global.fetch
  global.fetch = async (url, opts) => url.startsWith('https://r2.denied/')
    ? (calls.push({ url, method: opts.method }), { ok: false, status: 403, text: async () => 'SignatureDoesNotMatch' })
    : base(url, opts)
  await assert.rejects(run({ api: 'https://api.example', token: 't', body: {}, log: () => {} }), /R2 upload for job #9 -> HTTP 403/)
  assert.ok(!calls.some(c => c.url.includes('source-ready')))
  delete process.env.YTDLP_PATH
})
