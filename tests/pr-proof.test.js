'use strict'
const test = require('node:test')
const assert = require('node:assert')
const P = require('../daemon/pr-proof')

// ── the rule ────────────────────────────────────────────────────────────────
test('a coding prompt carries the rule, naming the script by absolute path', () => {
  const out = P.withProofRule('fix the checkout button', { scriptPath: '/opt/bridge/scripts/pr-proof.js' })
  assert.match(out, /^fix the checkout button\n\n## Hive rule: prove it on the PR/)
  assert.match(out, /open the app · test it · record a video · attach it to the PR/)
  assert.match(out, /node \/opt\/bridge\/scripts\/pr-proof\.js --url/)
})

test('a PHI task is never told to upload a recording (#187918)', () => {
  assert.strictEqual(P.withProofRule('p', { scriptPath: '/x.js', phi: true }), 'p')
  const t = { prompt: 'p', config: {} }
  assert.strictEqual(P.promptForCodingTask(t, { phi: true }), 'p')
})

test('config.proof_video=false opts a task out; the rule is never added twice', () => {
  assert.strictEqual(P.promptForCodingTask({ prompt: 'p', config: { proof_video: false } }), 'p')
  const once = P.promptForCodingTask({ prompt: 'p' })
  assert.strictEqual(P.withProofRule(once, { scriptPath: P.PROOF_SCRIPT }), once)
  assert.ok(once.includes(P.PROOF_SCRIPT))
})

test('the rule points at a script that exists in this checkout', () => {
  assert.ok(require('fs').existsSync(P.PROOF_SCRIPT), P.PROOF_SCRIPT)
})

// ── PR references ───────────────────────────────────────────────────────────
test('PR refs: owner/repo#N, a PR URL, and a bare number with the git origin', () => {
  assert.deepStrictEqual(P.parsePrRef('FREELABEL/iris-daemon#15'), { owner: 'FREELABEL', repo: 'iris-daemon', number: 15 })
  assert.deepStrictEqual(P.parsePrRef('https://github.com/a/b/pull/7/files'), { owner: 'a', repo: 'b', number: 7 })
  assert.deepStrictEqual(P.parsePrRef('12', 'git@github.com:a/b.git'), { owner: 'a', repo: 'b', number: 12 })
  assert.deepStrictEqual(P.parsePrRef('#12', 'https://github.com/a/b.git'), { owner: 'a', repo: 'b', number: 12 })
  assert.strictEqual(P.parsePrRef('12'), null)
  assert.strictEqual(P.parsePrRef('not a pr'), null)
})

// ── comment body ────────────────────────────────────────────────────────────
test('the comment links the video, says what was recorded, and carries the marker', () => {
  const body = P.buildCommentBody({
    videoUrl: 'https://cdn.example/v.mp4',
    shareUrl: 'https://share.example/1',
    flowUrl: 'http://localhost:5173/checkout',
    steps: [{ action: 'click', selector: '#buy' }, { action: 'wait', ms: 500 }],
    seconds: 6.24,
    node: 'iris-hive-001',
    taskId: 'abcdef1234567890'
  })
  assert.ok(body.startsWith(P.COMMENT_MARKER))
  assert.match(body, /\[Watch the change working\]\(https:\/\/cdn\.example\/v\.mp4\)/)
  assert.match(body, /\[share page\]\(https:\/\/share\.example\/1\)/)
  assert.match(body, /opened `http:\/\/localhost:5173\/checkout`; 2 steps: click #buy → wait 500/)
  assert.match(body, /6\.2s · headless Chromium \(Playwright\) · on Hive node `iris-hive-001` · task `abcdef123456`/)
})

test('the comment refuses to exist without a video URL', () => {
  assert.throws(() => P.buildCommentBody({}), /videoUrl is required/)
})

test('no share link line when the share URL is the CDN URL', () => {
  const body = P.buildCommentBody({ videoUrl: 'https://cdn/x.mp4', shareUrl: 'https://cdn/x.mp4' })
  assert.ok(!body.includes('share page'))
})

// ── upload output parsing ───────────────────────────────────────────────────
test('upload: the JSON is found among spinner and log lines', () => {
  const out = '\x1b[?25l◒ Uploading…\x1b[0m\n◇ Uploaded\n{\n  "file_id": 991,\n  "title": "x",\n  "cdn_url": "https://cdn.freelabel.net/f/x.mp4",\n  "share_url": "https://elon.freelabel.net/content/Cloud/file/991",\n  "size": 12\n}\n'
  assert.deepStrictEqual(P.parseUploadOutput(out), {
    cdn_url: 'https://cdn.freelabel.net/f/x.mp4',
    share_url: 'https://elon.freelabel.net/content/Cloud/file/991',
    file_id: 991
  })
})

test('upload: a failed upload (exit 0, no JSON) is a failure, never "uploaded"', () => {
  assert.throws(() => P.parseUploadOutput('◒ Uploading…\n■ Upload failed: {"message":"Unauthenticated."}\n└ Done\n'),
    /no CDN URL: .*Upload failed/)
})

test('upload: JSON without an http(s) URL is not success', () => {
  assert.throws(() => P.parseUploadOutput('{"file_id": 1, "cdn_url": ""}'), /no CDN URL/)
})

test('upload: braces inside strings do not confuse the parser; the last object wins', () => {
  const out = '{"note":"a { b"}\n{"cdn_url":"https://a/1.mp4"}\n{"cdn_url":"https://a/2.mp4","file_id":2}'
  assert.strictEqual(P.parseUploadOutput(out).cdn_url, 'https://a/2.mp4')
})

// ── rate limits ─────────────────────────────────────────────────────────────
test('rate-limit headers are read off the response (Headers or a plain object)', () => {
  const h = new Headers({ 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4998', 'x-ratelimit-reset': '1760000000' })
  const r = P.rateLimitFromHeaders(h)
  assert.strictEqual(r.limit, 5000)
  assert.strictEqual(r.remaining, 4998)
  assert.strictEqual(r.resetAt, new Date(1760000000 * 1000).toISOString())
  assert.strictEqual(P.rateLimitFromHeaders({ 'X-RateLimit-Remaining': '0' }).remaining, 0)
  assert.strictEqual(P.rateLimitFromHeaders(null).remaining, null)
})

test('201: ok, with the comment URL and the remaining count', () => {
  const r = P.interpretGithubResponse(201, { 'x-ratelimit-remaining': '4321' }, JSON.stringify({ id: 9, html_url: 'https://github.com/a/b/pull/1#issuecomment-9' }))
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.url, 'https://github.com/a/b/pull/1#issuecomment-9')
  assert.strictEqual(r.rate.remaining, 4321)
  assert.strictEqual(r.warning, undefined)
})

test('201 with few requests left: still ok, but warns', () => {
  const r = P.interpretGithubResponse(201, { 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': '1760000000' }, '{}')
  assert.strictEqual(r.ok, true)
  assert.match(r.warning, /rate limit low: 3 requests left/)
})

test('primary rate limit (403, remaining 0): stop, report the reset, do not retry', () => {
  const r = P.interpretGithubResponse(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1760000000' }, '{"message":"API rate limit exceeded"}')
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.rateLimited, true)
  assert.match(r.error, /not retrying — post again after 2025-10-09T08:53:20\.000Z/)
})

test('secondary rate limit (429 + retry-after) is rate-limited too', () => {
  const r = P.interpretGithubResponse(429, { 'retry-after': '60', 'x-ratelimit-remaining': '4000' }, '{"message":"You have exceeded a secondary rate limit"}')
  assert.strictEqual(r.rateLimited, true)
  assert.match(r.error, /in 60s/)
})

test('a permission 403 is NOT reported as a rate limit', () => {
  const r = P.interpretGithubResponse(403, { 'x-ratelimit-remaining': '4999' }, '{"message":"Resource not accessible by integration"}')
  assert.strictEqual(r.rateLimited, false)
  assert.match(r.error, /HTTP 403: Resource not accessible by integration — the token lacks permission/)
})

test('401 and 404 say what is likely wrong', () => {
  assert.match(P.interpretGithubResponse(401, {}, '{"message":"Bad credentials"}').error, /expired or revoked/)
  assert.match(P.interpretGithubResponse(404, {}, '{"message":"Not Found"}').error, /cannot see this repo/)
})

// ── posting: one call, never a poll ─────────────────────────────────────────
test('postPrComment makes exactly one POST to the issues-comments endpoint', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ id: 1, html_url: 'https://github.com/a/b/pull/3#issuecomment-1' }), { status: 201, headers: { 'x-ratelimit-remaining': '4990' } })
  }
  const r = await P.postPrComment({ owner: 'a', repo: 'b', number: 3, body: 'hi', token: 't0k', fetchImpl })
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].url, 'https://api.github.com/repos/a/b/issues/3/comments')
  assert.strictEqual(calls[0].init.method, 'POST')
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer t0k')
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), { body: 'hi' })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.rate.remaining, 4990)
})

test('a rate-limited post is not retried', async () => {
  let n = 0
  const fetchImpl = async () => { n++; return new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }) }
  const r = await P.postPrComment({ owner: 'a', repo: 'b', number: 3, body: 'x', token: 't', fetchImpl })
  assert.strictEqual(n, 1)
  assert.strictEqual(r.rateLimited, true)
})

test('no token: no request at all', async () => {
  let n = 0
  const r = await P.postPrComment({ owner: 'a', repo: 'b', number: 3, body: 'x', token: null, fetchImpl: async () => { n++ } })
  assert.strictEqual(n, 0)
  assert.match(r.error, /no GitHub token/)
})

// ── token ───────────────────────────────────────────────────────────────────
test('token: env first, then the user\'s gh login, else none — never a file', () => {
  const never = () => { throw new Error('should not run gh') }
  assert.deepStrictEqual(P.resolveGithubToken({ GITHUB_TOKEN: ' a ' }, never), { token: 'a', source: 'env GITHUB_TOKEN' })
  assert.deepStrictEqual(P.resolveGithubToken({ GH_TOKEN: 'b' }, never), { token: 'b', source: 'env GH_TOKEN' })
  assert.deepStrictEqual(P.resolveGithubToken({}, () => ({ status: 0, stdout: 'gho_x\n' })), { token: 'gho_x', source: 'gh auth token' })
  assert.deepStrictEqual(P.resolveGithubToken({}, () => ({ status: 1, stdout: '' })), { token: null, source: null })
})

// ── steps ───────────────────────────────────────────────────────────────────
test('steps: accepted shapes, and a bad step names its index', () => {
  assert.strictEqual(P.normalizeSteps([{ action: 'click', selector: '#a' }]).length, 1)
  assert.strictEqual(P.normalizeSteps({ steps: [{ action: 'wait', ms: 1 }] }).length, 1)
  assert.throws(() => P.normalizeSteps([{ action: 'click' }]), /step 0: click needs a selector/)
  assert.throws(() => P.normalizeSteps([{ action: 'wait' }, { action: 'eval' }]), /step 1: action must be one of/)
  assert.throws(() => P.normalizeSteps('nope'), /JSON array/)
})

// ── wiring: both paths that run a code_generation task carry the rule ──────
test('task-executor: the built-in and external-runtime coding paths both use promptForCodingTask', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'daemon', 'task-executor.js'), 'utf-8')
  assert.match(src, /agentCommand\(require\('\.\/pr-proof'\)\.promptForCodingTask\(task, \{ phi: isPhiTask\(task\) \}\)\)/)
  assert.match(src, /task\.type === 'code_generation'\s*\n\s*\? require\('\.\/pr-proof'\)\.promptForCodingTask\(task, \{ phi: isPhiTask\(task\) \}\)/)
  assert.ok(!/args = \['--print', task\.prompt\]/.test(src), 'claude_code runtime must use agentPrompt')
})
