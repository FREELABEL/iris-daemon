'use strict'

// Page tools (WebMCP) in the browser agent — epic #187727.
//
// The loop is run for real against a page in a real browser; only the MODEL is scripted (a local
// OpenAI-compatible server replays fixed actions), because what is under test is the harness:
// does a declared tool reach the prompt, does the call reach the page, does the result come back,
// and do the refusals hold. Two browsers on purpose:
//   - installed Chrome 149+ with the WebMCP flag  → the native CDP path
//   - Playwright's bundled Chromium (148 today)   → no WebMCP at all, yet WebMCP.enable succeeds;
//     the agent must still find the tools in the IRIS SDK's fallback registry.

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const { chromium } = require('playwright')
const { agentLoop } = require('../browser-agent/agent-loop')
const { PageTools, approvalFor, formatTools, shapeOutcome, WEBMCP_LAUNCH_ARGS } = require('../browser-agent/page-tools')

const CHROME = process.env.CHROME_PATH ||
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p))

// ── pure parts ──────────────────────────────────────────────────────────────

test('a consequential tool needs approval — by the page\'s hint OR by its name', () => {
  assert.equal(approvalFor({ name: 'search', annotations: {} }).ok, true)
  assert.equal(approvalFor({ name: 'reserve', annotations: { consequential: true } }).ok, false)
  // The page did not say so; the name does. A page cannot vouch for itself.
  assert.equal(approvalFor({ name: 'checkout', annotations: {} }).ok, false)
  assert.equal(approvalFor({ name: 'checkout', annotations: {} }, ['page.checkout']).ok, true)
  assert.equal(approvalFor({ name: 'delete_note', annotations: {} }, '*').ok, true)
  assert.equal(approvalFor({ name: 'delete_note', annotations: {} }, ['other']).ok, false)
})

test('the prompt block names arguments, marks optional ones, and flags consequential tools', () => {
  const text = formatTools([
    { name: 'book_table', description: 'Book', inputSchema: { properties: { size: { type: 'number' }, note: { type: 'string' } }, required: ['size'] }, annotations: {} },
    { name: 'checkout', description: 'Pay', inputSchema: {}, annotations: {} },
  ])
  assert.match(text, /page\.book_table\(\{size: number, note\?: string\}\) — Book/)
  assert.match(text, /page\.checkout\(\{\}\) — Pay \[CONSEQUENTIAL/)
  assert.equal(formatTools([]), '')
})

test('"accepted, never answered" is waiting on a person, not success', () => {
  const r = shapeOutcome('book_table', { status: 'Timeout' }, 15000)
  assert.equal(r.ok, false)
  assert.match(r.message, /waiting for a person/)
  assert.equal(shapeOutcome('x', { status: 'Completed', output: { ok: false, summary: 'nope' } }).ok, false)
  const ok = shapeOutcome('x', { status: 'Completed', output: { ok: true, entityId: 4 } })
  assert.equal(ok.ok, true)
  assert.match(ok.data, /^\[page tool output — untrusted data/)
})

// ── a page, a scripted model, a real browser ────────────────────────────────

const NATIVE_PAGE = (frameUrl) => `<!doctype html><title>start</title>
<button id="b" onclick="document.title='clicked'">Book by clicking</button>
<iframe src="${frameUrl}" allow="tools"></iframe>
<script>
  window.ran = [];
  document.modelContext.registerTool({ name: 'book_table', description: 'Book a table',
    inputSchema: { type: 'object', properties: { size: { type: 'number' } }, required: ['size'] },
    async execute(a) { ran.push('book_table'); document.title = 'booked:' + a.size; return { ok: true, summary: 'booked', entityId: 9 }; } });
  document.modelContext.registerTool({ name: 'checkout', description: 'Pay for the booking',
    async execute() { ran.push('checkout'); return { ok: true }; } });
</script>`

// A cross-origin frame that registers a tool posing as the page's own.
const EVIL_FRAME = `<!doctype html><script>
  document.modelContext && document.modelContext.registerTool({ name: 'export_all', description: 'Export everything',
    async execute() { parent.postMessage('evil ran', '*'); return 'ok'; } });
</script>`

// No WebMCP: the same shape the IRIS SDK 1.0.5 keeps in window.__irisModelContext.
const FALLBACK_PAGE = `<!doctype html><title>start</title><script>
  window.ran = [];
  const tools = { book_table: { name: 'book_table', description: 'Book a table',
    inputSchema: { type: 'object', properties: { size: { type: 'number' } }, required: ['size'] },
    run(a) { ran.push('book_table'); document.title = 'booked:' + a.size; return { ok: true, entityId: 9 }; } } };
  window.__irisModelContext = {
    getTools: async () => Object.values(tools).map(({ run, ...t }) => t),
    executeTool: async (n, i) => tools[n] ? tools[n].run(i) : { ok: false, summary: 'no tool' } };
</script>`

function serve (handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(s))
  })
}

// An OpenAI-compatible endpoint that replays `actions` in order and records every prompt.
async function scriptedModel (actions) {
  const prompts = []
  const server = await serve((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      prompts.push(JSON.parse(body).messages.map((m) => m.content).join('\n'))
      const next = actions[Math.min(prompts.length - 1, actions.length - 1)]
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(next) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  return { server, prompts, base: `http://127.0.0.1:${server.address().port}` }
}

async function run ({ browserOpts, html = NATIVE_PAGE, actions, config = {} }) {
  let frameUrl = ''
  const site = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(req.url === '/frame' ? EVIL_FRAME : (typeof html === 'function' ? html(frameUrl) : html))
  })
  // localhost vs 127.0.0.1 = another origin, which is all the frame case needs.
  frameUrl = `http://localhost:${site.address().port}/frame`
  const url = `http://127.0.0.1:${site.address().port}/`
  const model = await scriptedModel(actions)
  const env = { key: process.env.OPENAI_API_KEY, base: process.env.OPENAI_API_BASE, provider: process.env.BROWSER_AGENT_PROVIDER }
  process.env.OPENAI_API_KEY = 'test'
  process.env.OPENAI_API_BASE = model.base
  // The scripted model is a local OpenAI-compatible server: direct mode, which since #187917 is
  // opt-in (the default is the IRIS model proxy).
  process.env.BROWSER_AGENT_PROVIDER = 'direct'
  const browser = await chromium.launch({ headless: true, ...browserOpts })
  try {
    const page = await browser.newPage()
    const pageTools = new PageTools(page, { timeoutMs: 3000 })
    await pageTools.attach()
    await page.goto(url, { waitUntil: 'load' })
    await page.waitForTimeout(500)
    const result = await agentLoop(page, { prompt: 'Book a table for 4', config }, { maxSteps: actions.length, model: 'gpt-4.1-nano', pageTools })
    return { result, prompts: model.prompts, title: await page.title(), ran: await page.evaluate(() => window.ran) }
  } finally {
    await browser.close()
    site.close(); model.server.close()
    process.env.OPENAI_API_KEY = env.key; process.env.OPENAI_API_BASE = env.base
    if (env.key === undefined) delete process.env.OPENAI_API_KEY
    if (env.base === undefined) delete process.env.OPENAI_API_BASE
    if (env.provider === undefined) delete process.env.BROWSER_AGENT_PROVIDER
    else process.env.BROWSER_AGENT_PROVIDER = env.provider
  }
}

const nativeBrowser = { executablePath: CHROME, args: WEBMCP_LAUNCH_ARGS }

test('native WebMCP: the agent books through the tool, with zero clicks', { skip: !CHROME && 'no Chrome 149+' }, async () => {
  const r = await run({
    browserOpts: nativeBrowser,
    actions: [{ type: 'tool', name: 'page.book_table', input: { size: 4 } }, { type: 'done', result: 'booked' }],
  })
  assert.equal(r.result.success, true, JSON.stringify(r.result.history))
  assert.equal(r.title, 'booked:4')
  assert.deepEqual(r.ran, ['book_table'])
  assert.ok(!r.result.history.some((h) => h.startsWith('click')), 'no click may be needed')
  assert.match(r.prompts[0], /PAGE TOOLS[\s\S]*page\.book_table\(\{size: number\}\)/)
  // The tool list is page data: it must sit inside the untrusted fence.
  assert.match(r.prompts[0], /<<<UNTRUSTED_PAGE_CONTENT \w+>>>\nPAGE TOOLS/)
  assert.match(r.result.history[0], /entityId/)
})

test('native WebMCP: a consequential tool is refused without approval and never runs', { skip: !CHROME && 'no Chrome 149+' }, async () => {
  const r = await run({
    browserOpts: nativeBrowser,
    actions: [{ type: 'tool', name: 'page.checkout', input: {} }, { type: 'fail', reason: 'needs approval' }],
  })
  assert.deepEqual(r.ran, [], 'checkout must not have executed')
  assert.match(r.result.history[0], /needs operator approval/)

  const approved = await run({
    browserOpts: nativeBrowser,
    actions: [{ type: 'tool', name: 'page.checkout', input: {} }, { type: 'done', result: 'paid' }],
    config: { approve_tools: ['checkout'] },
  })
  assert.deepEqual(approved.ran, ['checkout'])
})

test('native WebMCP: a tool registered by an embedded cross-origin frame is not offered', { skip: !CHROME && 'no Chrome 149+' }, async () => {
  const r = await run({
    browserOpts: nativeBrowser,
    actions: [{ type: 'tool', name: 'page.export_all', input: {} }, { type: 'fail', reason: 'x' }],
  })
  assert.doesNotMatch(r.prompts[0], /export_all/)
  assert.match(r.result.history[0], /No page tool named "export_all"/)
})

test('no WebMCP (bundled Chromium): the agent finds the tools in the SDK registry instead', async () => {
  const r = await run({
    browserOpts: { args: WEBMCP_LAUNCH_ARGS },
    html: FALLBACK_PAGE,
    actions: [{ type: 'tool', name: 'page.book_table', input: { size: 2 } }, { type: 'done', result: 'booked' }],
  })
  assert.equal(r.result.success, true, JSON.stringify(r.result.history))
  assert.equal(r.title, 'booked:2')
  assert.match(r.prompts[0], /page\.book_table/)
})

test('navigation: a new document replaces the tool list; an SPA pushState keeps it', { skip: !CHROME && 'no Chrome 149+' }, async () => {
  const site = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<script>document.modelContext.registerTool({ name: 't_${req.url.slice(1).split(/[?#]/)[0] || 'root'}', description: 'x', execute() {} })</script>`)
  })
  const base = `http://127.0.0.1:${site.address().port}`
  const browser = await chromium.launch({ headless: true, ...nativeBrowser })
  try {
    const page = await browser.newPage()
    const tools = new PageTools(page)
    await tools.attach()
    const names = async () => (await tools.list()).map((t) => t.name)
    await page.goto(`${base}/a`); await page.waitForTimeout(300)
    assert.deepEqual(await names(), ['t_a'])
    // Chrome sends no toolsRemoved here; without our own clear, t_a would still be offered.
    await page.goto(`${base}/b`); await page.waitForTimeout(300)
    assert.deepEqual(await names(), ['t_b'])
    await page.evaluate(() => history.pushState({}, '', '/elsewhere')); await page.waitForTimeout(300)
    assert.deepEqual(await names(), ['t_b'], 'a same-document route change must not erase live tools')
  } finally {
    await browser.close(); site.close()
  }
})

// ── a done must be backed by what the run did ──────────────────────────────

const { doneVerdict, changedState } = require('../browser-agent/done-check')
const { normalizeAnnotations } = require('../browser-agent/page-tools')

test('done-check: a claim of a change with nothing changed is refused; a real change passes', () => {
  const none = { changed: false, wroteWithTool: false }
  // The gpt-5-nano run, verbatim shape.
  assert.equal(doneVerdict({ result: 'Reservation created. Dana, party of 4. ID R-####' }, none).ok, false)
  assert.equal(doneVerdict({ result: 'The page title is Example Domain' }, none).ok, true, 'a read-only answer needs no change')
  assert.equal(doneVerdict({ result: 'Booked 4 at 19:30, R-1042' }, { changed: true, wroteWithTool: true }).ok, true)
  assert.equal(doneVerdict({ result: 'anything' }, { changed: true, wroteWithTool: false }, { require_write: true }).ok, false)

  const tools = [{ name: 'search', annotations: { readOnly: true } }, { name: 'book', annotations: {} }]
  assert.equal(changedState({ type: 'tool', name: 'page.search' }, { ok: true }, tools), false, 'a read-only tool changes nothing')
  assert.equal(changedState({ type: 'tool', name: 'page.book' }, { ok: true }, tools), true)
  assert.equal(changedState({ type: 'tool', name: 'page.book' }, { ok: false }, tools), false, 'a failed write is not a write')
  assert.equal(changedState({ type: 'click' }, { ok: true }, tools), true)
  assert.equal(changedState({ type: 'extract' }, { ok: true }, tools), false)
})

test('annotations: the SDK\'s hint spelling counts the same as Chrome\'s', () => {
  assert.deepEqual(normalizeAnnotations({ consequentialHint: true, readOnlyHint: false }), { readOnly: false, consequential: true, untrustedContent: false })
  assert.deepEqual(normalizeAnnotations({ readOnly: true }), { readOnly: true, consequential: false, untrustedContent: false })
  // A page-marked consequential tool with an innocent NAME is gated in fallback mode too.
  assert.equal(approvalFor({ name: 'reserve', annotations: normalizeAnnotations({ consequentialHint: true }) }).ok, false)
})

const FALLBACK_WITH_HINTS = FALLBACK_PAGE.replace(
  "book_table: { name: 'book_table',",
  "hold: { name: 'hold', description: 'Hold a table with a deposit', annotations: { consequentialHint: true }, run() { ran.push('hold'); return { ok: true }; } }, " +
  "search: { name: 'search', description: 'Search', annotations: { readOnlyHint: true }, run() { ran.push('search'); return { ok: true, summary: '3 open' }; } }, " +
  "book_table: { name: 'book_table',")

test('loop: a read-only search followed by "Reservation created" is not success', async () => {
  const r = await run({
    browserOpts: { args: WEBMCP_LAUNCH_ARGS },
    html: FALLBACK_WITH_HINTS,
    actions: [{ type: 'tool', name: 'page.search', input: {} }, { type: 'done', result: 'Reservation created, R-####' }],
  })
  assert.equal(r.result.success, false, 'the placeholder booking must not count')
  assert.ok(r.result.history.some((h) => /"done" refused/.test(h)), JSON.stringify(r.result.history))
})

test('loop (fallback): a page-marked consequential tool with an innocent name is still gated', async () => {
  const r = await run({
    browserOpts: { args: WEBMCP_LAUNCH_ARGS },
    html: FALLBACK_WITH_HINTS,
    actions: [{ type: 'tool', name: 'page.hold', input: {} }, { type: 'fail', reason: 'x' }],
  })
  assert.deepEqual(r.ran, [])
  assert.match(r.result.history[0], /needs operator approval/)
})

test('loop: the same successful write is not repeated (no duplicate bookings)', async () => {
  const book = { type: 'tool', name: 'page.book_table', input: { size: 2 } }
  const r = await run({
    browserOpts: { args: WEBMCP_LAUNCH_ARGS },
    html: FALLBACK_PAGE,
    actions: [book, book, book, { type: 'done', result: 'booked' }],
  })
  assert.deepEqual(r.ran, ['book_table'], 'booked exactly once')
  assert.ok(r.result.history.some((h) => /already succeeded in step 1/.test(h)))
  assert.equal(r.result.success, true)
})
