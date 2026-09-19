/**
 * A saved script must not be able to take the daemon down (#186174).
 *
 * MEASURED FAILURE, 2026-09-18. `iris scripts run <slug> --node <this machine>`:
 *
 *   Error: Failed to pull script 'deal-scenarios' from cloud: HTTP 401
 *       at resolveUserScriptBySlug (daemon/task-executor.js:309)
 *   Node.js v22.23.2                     <- the whole daemon exited
 *
 * launchd restarted it, the hub kept the task "running" forever, the CLI timed out and exited 0,
 * and any other task on the node died with it. Two defects stacked:
 *
 *   1. AUTH. The script and asset pulls are /api/v6/node-agent/* routes, which accept the NODE
 *      key. They sent the ACCOUNT token instead (resolveDaemonIdentity prefers HEYIRIS_TOKEN /
 *      IRIS_API_KEY), so every pull 401'd. Measured: account key -> 401, node key -> 200, on
 *      both freelabel.net and heyiris.io. Every other node-agent call goes through the cloud
 *      client and its node key; these two used a raw fetch with the wrong identity.
 *
 *   2. CRASH. runProcess was `new Promise(async (resolve, reject) => { ... })`. A throw inside an
 *      async executor never reaches `reject` — it becomes an unhandled rejection, and Node exits.
 *      So ANY error before spawn killed the daemon, not only this one.
 */

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { TaskExecutor, resolveUserScriptBySlug, resolveUserScriptAssets } = require('../daemon/task-executor')

const NODE_KEY = 'node-key-for-test'
const ACCOUNT_TOKEN = 'account-token-for-test'

let server, apiUrl
const seen = [] // { path, auth }

before(async () => {
  // The account token is present in the environment exactly as it is on a signed-in machine —
  // that is the precondition of the bug. The node-agent routes must ignore it.
  process.env.HEYIRIS_TOKEN = ACCOUNT_TOKEN
  server = http.createServer((req, res) => {
    seen.push({ path: req.url, auth: req.headers.authorization })
    const ok = req.headers.authorization === `Bearer ${NODE_KEY}`
    res.setHeader('Content-Type', 'application/json')
    if (!ok) { res.statusCode = 401; return res.end('{"message":"Unauthenticated."}') }
    if (req.url.includes('/scripts/runs/assets')) {
      const body = Buffer.from('the-watermark')
      return res.end(JSON.stringify({ data: [{ path: 'mark.txt', bytes: body.length, sha256: require('crypto').createHash('sha256').update(body).digest('hex'), content_base64: body.toString('base64') }] }))
    }
    if (req.url.endsWith('/assets')) return res.end('{"data":[]}')
    if (req.url.includes('/scripts/runs')) return res.end(JSON.stringify({ data: { script_content: 'cat mark.txt; echo; echo ran-ok\n', runtime: 'bash' } }))
    res.end(JSON.stringify({ data: { script_content: 'echo hi\n', runtime: 'bash' } }))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  apiUrl = `http://127.0.0.1:${server.address().port}`
})

after(() => {
  delete process.env.HEYIRIS_TOKEN
  server.close()
})

const cloud = () => ({ apiUrl, apiKey: NODE_KEY })

describe('node-agent script routes authenticate as the NODE', () => {
  it('the script pull sends the node key, not the account token', async () => {
    seen.length = 0
    const script = await resolveUserScriptBySlug('auth-probe', null, cloud())
    assert.equal(script.script_content, 'echo hi\n')
    assert.equal(seen[0].auth, `Bearer ${NODE_KEY}`)
  })

  it('the asset pull sends the node key, not the account token', async () => {
    seen.length = 0
    const assets = await resolveUserScriptAssets('auth-probe', cloud())
    assert.deepEqual(assets, [])
    assert.equal(seen[0].auth, `Bearer ${NODE_KEY}`)
  })
})

describe('an error before spawn fails the TASK, never the daemon', () => {
  let unhandled = []
  const onUnhandled = (e) => unhandled.push(e)
  before(() => process.on('unhandledRejection', onUnhandled))
  after(() => process.off('unhandledRejection', onUnhandled))

  const settle = (p, ms = 3000) => Promise.race([
    p.then(() => ({ settled: 'resolved' }), (err) => ({ settled: 'rejected', err })),
    new Promise((r) => setTimeout(() => r({ settled: 'never' }), ms))
  ])

  it('a pull that 401s rejects runProcess with the reason', async () => {
    unhandled = []
    // A node whose key the server does not accept: the pull 401s.
    const ex = new TaskExecutor({ apiUrl, apiKey: 'wrong-key' }, {})
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-auth-'))
    const out = await settle(ex.runProcess({ id: 't-401', type: 'user_script', prompt: 'auth-probe', config: {} }, { dir }, []))
    assert.equal(out.settled, 'rejected', 'runProcess must reject, not hang with an unhandled rejection')
    assert.match(out.err.message, /HTTP 401/)
    await new Promise((r) => setImmediate(r))
    assert.equal(unhandled.length, 0, 'nothing may escape as an unhandled rejection — Node exits on one')
  })

  it('a malformed task rejects runProcess instead of escaping', async () => {
    unhandled = []
    const ex = new TaskExecutor(cloud(), {})
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-auth-'))
    const out = await settle(ex.runProcess({ id: 't-noslug', type: 'user_script', prompt: '', config: {} }, { dir }, []))
    assert.equal(out.settled, 'rejected')
    assert.match(out.err.message, /requires a script_slug/)
    await new Promise((r) => setImmediate(r))
    assert.equal(unhandled.length, 0)
  })
})

describe('a saved script gets past the pull and actually RUNS', () => {
  // MEASURED 2026-09-18, the run after the auth fixes deployed: "planScriptExecution is not
  // defined". 1ab5101 (2026-08-28) wired isolation into this branch and never imported
  // planScriptExecution / nodePolicyFromEnv / materialiseAssets, nor defined getIsolationState.
  // Every earlier failure (401, then 422) stopped the run before this line, so no user_script
  // run through `iris scripts run` has completed since.
  it('runs the script with its asset written beside it', async () => {
    const savedPath = process.env.PATH
    process.env.PATH = '/usr/bin:/bin' // no docker on PATH -> the host path, deterministically
    try {
      const ex = new TaskExecutor(cloud(), {})
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-run-'))
      const lines = []
      const out = await Promise.race([
        ex.runProcess({ id: 't-run', type: 'user_script', prompt: 'runs', config: {} }, { dir }, lines)
          .then((r) => ({ settled: 'resolved', r }), (err) => ({ settled: 'rejected', err })),
        new Promise((r) => setTimeout(() => r({ settled: 'never' }), 20000))
      ])
      assert.equal(out.settled, 'resolved', out.err ? `rejected: ${out.err.message}` : 'did not finish')
      assert.equal(fs.readFileSync(path.join(dir, 'mark.txt'), 'utf8'), 'the-watermark')
      const text = lines.join('\n') + JSON.stringify(out.r || {})
      assert.match(text, /ran-ok/)
    } finally {
      process.env.PATH = savedPath
    }
  })
})
