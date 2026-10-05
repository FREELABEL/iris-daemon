'use strict'

/**
 * #187917 / #187918 — GAP J: what a portal robot saw stays on the node it ran on.
 *
 *   #187917  the browser agent's model calls go through the IRIS model proxy (where the PHI
 *            egress guard runs), never straight to OpenAI unless direct mode is explicitly
 *            configured AND the task is not PHI.
 *   #187918  a PHI task sends no free-text stdout, no recordings, no screenshots off the node:
 *            the cloud gets a structured status and a local reference.
 *
 * These drive the real modules (no Playwright needed): a stub page for the agent loop, a local
 * HTTP server standing in for the proxy, and a CloudClient whose network layer is captured.
 */

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const { isPhiTask, phiSafeResult } = require('../lib/phi-task')
const { resolveModelEndpoint } = require('../browser-agent/model-endpoint')
const { agentLoop } = require('../browser-agent/agent-loop')
const { CloudClient } = require('../daemon/cloud-client')

const PATIENT_TEXT = 'Patient: Jane Doe  DOB 1970-01-01  MRN 4411'
const noToken = () => null

// ─── isPhiTask ──────────────────────────────────────────────────────────────

test('isPhiTask: the server-stamped config.phi, contains_phi and top-level phi all count', () => {
  assert.equal(isPhiTask({ config: { phi: true } }), true)
  assert.equal(isPhiTask({ config: { contains_phi: true } }), true)
  assert.equal(isPhiTask({ phi: true, config: {} }), true)
  assert.equal(isPhiTask({ config: { phi: '1' } }), true)
  assert.equal(isPhiTask({ config: {} }), false)
  assert.equal(isPhiTask({ config: { phi: false } }), false)
  assert.equal(isPhiTask(null), false)
})

// ─── resolveModelEndpoint (#187917) ─────────────────────────────────────────

test('default is the IRIS model proxy, never api.openai.com, even with OPENAI_API_KEY set', () => {
  const e = resolveModelEndpoint({
    env: { OPENAI_API_KEY: 'sk-node-own', IRIS_MODEL_PROXY_TOKEN: 'node_live_x', IRIS_API_URL: 'https://iris.example' },
    task: { config: {} },
    resolveToken: noToken,
  })
  assert.equal(e.mode, 'proxy')
  assert.equal(e.url, 'https://iris.example/api/v6/openai/chat/completions')
  assert.equal(e.headers.Authorization, 'Bearer node_live_x')
  assert.ok(!JSON.stringify(e).includes('sk-node-own'), 'the node\'s own provider key must not be used')
  assert.equal(e.headers['X-Iris-Phi'], undefined)
})

test('a PHI task declares itself to the proxy so the egress guard applies', () => {
  const e = resolveModelEndpoint({ env: { IRIS_MODEL_PROXY_TOKEN: 't' }, task: { config: { phi: true } }, resolveToken: noToken })
  assert.equal(e.mode, 'proxy')
  assert.equal(e.headers['X-Iris-Phi'], '1')
  const viaEnv = resolveModelEndpoint({ env: { IRIS_MODEL_PROXY_TOKEN: 't', IRIS_TASK_PHI: '1' }, task: {}, resolveToken: noToken })
  assert.equal(viaEnv.headers['X-Iris-Phi'], '1')
})

test('direct provider mode works only when explicitly configured, for a non-PHI task', () => {
  const e = resolveModelEndpoint({
    env: { BROWSER_AGENT_PROVIDER: 'direct', OPENAI_API_KEY: 'sk-x' },
    task: { config: {} },
    resolveToken: noToken,
  })
  assert.equal(e.mode, 'direct')
  assert.equal(e.url, 'https://api.openai.com/v1/chat/completions')
})

test('direct provider mode is REFUSED for a PHI task', () => {
  for (const task of [{ config: { phi: true } }, { config: { contains_phi: true } }]) {
    assert.throws(
      () => resolveModelEndpoint({ env: { BROWSER_AGENT_PROVIDER: 'direct', OPENAI_API_KEY: 'sk-x' }, task, resolveToken: noToken }),
      /Refused.*PHI.*#187917/
    )
  }
  assert.throws(
    () => resolveModelEndpoint({ env: { BROWSER_AGENT_PROVIDER: 'direct', OPENAI_API_KEY: 'sk-x', IRIS_TASK_PHI: '1', OPENAI_API_BASE: 'https://api.openai.com/v1' }, task: {}, resolveToken: noToken }),
    /Refused/
  )
})

test('a PHI task may use a model on THIS machine (loopback) — nothing leaves the node', () => {
  const e = resolveModelEndpoint({
    env: { BROWSER_AGENT_PROVIDER: 'direct', OPENAI_API_BASE: 'http://127.0.0.1:11434/v1' },
    task: { config: { phi: true } },
    resolveToken: noToken,
  })
  assert.equal(e.mode, 'direct')
  assert.equal(e.url, 'http://127.0.0.1:11434/v1/chat/completions')
  // A hostname that merely STARTS like loopback is not loopback.
  assert.throws(() => resolveModelEndpoint({
    env: { BROWSER_AGENT_PROVIDER: 'direct', OPENAI_API_KEY: 'k', OPENAI_API_BASE: 'http://localhost.evil.example/v1' },
    task: { config: { phi: true } },
    resolveToken: noToken,
  }), /Refused/)
})

test('no IRIS credential → a clear error, not a silent fall back to direct', () => {
  assert.throws(
    () => resolveModelEndpoint({ env: { OPENAI_API_KEY: 'sk-x' }, task: {}, resolveToken: noToken }),
    /No IRIS credential/
  )
})

// ─── agentLoop end to end against a stand-in proxy ──────────────────────────

function stubPage () {
  return {
    url: () => 'https://portal.example/chart/4411',
    title: async () => 'Chart',
    evaluate: async (fn, arg) => (arg ? [] : PATIENT_TEXT),
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
  }
}

function serve (handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler)
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
}

async function withEnv (vars, fn) {
  const saved = {}
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k] }
  try { return await fn() } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  }
}

test('agentLoop sends the page to the proxy with the node credential and the PHI header', async () => {
  const seen = []
  const proxy = await serve((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, phi: req.headers['x-iris-phi'], body })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '{"type":"done","result":"read the chart"}' } }] }))
    })
  })
  try {
    const r = await withEnv({
      IRIS_MODEL_PROXY_URL: `http://127.0.0.1:${proxy.address().port}/api/v6/openai`,
      IRIS_MODEL_PROXY_TOKEN: 'node_live_test',
      OPENAI_API_KEY: 'sk-must-not-be-used',
      OPENAI_API_BASE: 'http://127.0.0.1:1/never',
      BROWSER_AGENT_PROVIDER: undefined,
      IRIS_TASK_PHI: undefined,
    }, () => agentLoop(stubPage(), { prompt: 'Read the chart', config: { phi: true } }, { maxSteps: 1, pageTools: null }))
    assert.equal(r.success, true, JSON.stringify(r))
    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, '/api/v6/openai/chat/completions')
    assert.equal(seen[0].auth, 'Bearer node_live_test')
    assert.equal(seen[0].phi, '1')
    assert.ok(seen[0].body.includes('Jane Doe'), 'the page reached the proxy (where the guard runs)')
  } finally {
    proxy.close()
  }
})

test('agentLoop refuses up front — zero model calls — when direct mode meets a PHI task', async () => {
  let calls = 0
  const provider = await serve((req, res) => { calls++; res.writeHead(500); res.end() })
  try {
    const r = await withEnv({
      BROWSER_AGENT_PROVIDER: 'direct',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_API_BASE: `http://localhost.invalid:${provider.address().port}/v1`,
      IRIS_TASK_PHI: undefined,
    }, () => agentLoop(stubPage(), { prompt: 'Read the chart', config: { phi: true } }, { maxSteps: 3, pageTools: null }))
    assert.equal(r.success, false)
    assert.equal(r.steps, 0)
    assert.match(r.error, /Refused/)
    assert.equal(calls, 0)
  } finally {
    provider.close()
  }
})

// ─── #187918: what a PHI task's reports may carry ───────────────────────────

test('phiSafeResult carries status, exit code, booleans and the local ref — no free text', () => {
  const full = {
    status: 'failed',
    output: PATIENT_TEXT,
    stdout: PATIENT_TEXT,
    stderr: 'trace ' + PATIENT_TEXT,
    files: [{ name: 'final-state.png', content: 'x' }, { name: 'video.webm', content: 'y' }],
    error: `could not find ${PATIENT_TEXT}`,
    exit_code: 1,
    duration_ms: 1200,
    metadata: { executed_by_node_id: 'n1', exit_code: 1 },
  }
  const safe = phiSafeResult(full, { localRef: '/tmp/t/phi-result.json' })
  const wire = JSON.stringify(safe)
  assert.ok(!wire.includes('Jane Doe'), wire)
  assert.ok(!wire.includes('.webm') && !wire.includes('.png'), wire)
  for (const k of ['output', 'stdout', 'stderr', 'files']) assert.equal(safe[k], undefined, k)
  assert.equal(safe.status, 'failed')
  assert.equal(safe.exit_code, 1)
  assert.equal(safe.data.local_ref, '/tmp/t/phi-result.json')
  assert.equal(safe.data.success, false)
  assert.match(safe.error, /^phi_task_failed/)
  assert.deepEqual(safe.metadata.withheld.sort(), ['error', 'files', 'output', 'stderr', 'stdout'])
})

function capturingClient () {
  const c = new CloudClient('https://iris.example', 'node_live_test')
  const sent = []
  c._requestWithFailover = async (method, p, body) => { sent.push({ method, path: p, body }); return { ok: true } }
  return { c, sent }
}

test('CloudClient: a PHI task\'s result leaves as structured status; the full record stays local', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-task-'))
  const { c, sent } = capturingClient()
  c.markPhiTask('t-phi', dir)
  await c.submitResult('t-phi', {
    status: 'completed',
    output: PATIENT_TEXT,
    stdout: PATIENT_TEXT,
    files: [{ name: 'test-results/a/video.webm', size: 10, content: 'webm-bytes' }],
    exit_code: 0,
  })
  assert.equal(sent.length, 1)
  const wire = JSON.stringify(sent[0].body)
  assert.ok(!wire.includes('Jane Doe'), 'no free-text stdout off the node')
  assert.ok(!wire.includes('.webm'), 'no recording off the node')
  assert.equal(sent[0].body.status, 'completed')
  const local = path.join(dir, 'phi-result.json')
  assert.equal(sent[0].body.data.local_ref, local)
  assert.ok(fs.readFileSync(local, 'utf8').includes('Jane Doe'), 'the full record is kept on the node')
  if (process.platform !== 'win32') assert.equal(fs.statSync(local).mode & 0o777, 0o600)
})

test('CloudClient: live output and artifact uploads for a PHI task never hit the wire; progress loses its text', async () => {
  const { c, sent } = capturingClient()
  c.markPhiTask('t-phi', null)
  const out = await c.reportOutput('t-phi', 0, PATIENT_TEXT, 'stdout')
  assert.equal(out.withheld, 'phi')
  const art = await c.post('/api/v6/node-agent/tasks/t-phi/artifacts', { files: [{ filename: 'run.webm', content_base64: 'AA' }] })
  assert.deepEqual(art.cdn_urls, [])
  await c.reportProgress('t-phi', 40, PATIENT_TEXT)
  assert.equal(sent.length, 1, 'only progress went out')
  assert.deepEqual(sent[0].body, { progress: 40, message: null })
})

test('CloudClient: a non-PHI task is untouched', async () => {
  const { c, sent } = capturingClient()
  c.markPhiTask('t-phi', null)
  await c.submitResult('t-other', { status: 'completed', output: 'hello', stdout: 'hello' })
  await c.reportOutput('t-other', 0, 'hello', 'stdout')
  assert.equal(sent.length, 2)
  assert.equal(sent[0].body.stdout, 'hello')
  assert.equal(sent[1].body.chunk, 'hello')
})

// ─── wiring in the executor (the pieces that are not reachable without a browser) ───────

test('executor wiring: PHI tasks are marked first, not recorded, not uploaded, not cleaned up', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'task-executor.js'), 'utf8')
  const execStart = src.indexOf('async execute (task, opts = {})')
  const firstReport = src.indexOf('this.cloud.submitResult', execStart)
  const mark = src.indexOf('this.cloud.markPhiTask(taskId', execStart)
  assert.ok(mark > execStart && mark < firstReport, 'markPhiTask must run before the first submitResult in execute()')
  assert.match(src, /task\.type === 'custom_playwright' && task\.config\?\.lead_id && !phi/)
  assert.match(src, /phiRun \? `    video: 'off',`/)
  assert.match(src, /if \(!phi\) setTimeout\(\(\) => this\.workspaces\.cleanup\(taskId\)/)
  // Proxy credentials are set AFTER the task's env_vars are merged into config — so they win.
  const browserCase = src.slice(src.indexOf("case 'browser': {"), src.indexOf("case 'deploy_project':"))
  assert.match(browserCase, /IRIS_MODEL_PROXY_TOKEN = this\.cloud\.apiKey/)
  assert.match(browserCase, /IRIS_TASK_PHI = '1'/)
})
