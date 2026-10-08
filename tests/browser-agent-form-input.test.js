'use strict'

// form_input, zoom and stale_ref in the browser agent — #188588.
//
// Real headless Chromium, real pages; only the MODEL is scripted (a local OpenAI-compatible server
// replays fixed actions and records what it was sent), the same harness as
// browser-agent-page-tools.test.js. What is under test is the harness: does a form_input reach the
// field as a value, does a zoom come back as an image of the asked-for region and reach the next
// prompt, does an action on a vanished element come back typed so `find` can recover.

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { chromium } = require('playwright')
const { agentLoop } = require('../browser-agent/agent-loop')
const { executeAction, wantChecked } = require('../browser-agent/action-executor')
const { extractDOM } = require('../browser-agent/dom-extractor')
const { ACTION_HELP } = require('../browser-agent/prompt-parts')
const { changedState } = require('../browser-agent/done-check')

const FORM = `<!doctype html><title>signup</title><body style="margin:0">
<form id="f" onsubmit="return false">
  <input name="name" placeholder="Full name">
  <input name="email" type="email" placeholder="Email">
  <input name="phone" type="tel" placeholder="Phone">
  <input name="agree" type="checkbox"> I agree
  <input name="plan" type="radio" value="basic" checked> Basic
  <input name="plan" type="radio" value="pro"> Pro
  <select name="country"><option value="us">United States</option><option value="ca">Canada</option><option value="mx">Mexico</option></select>
  <textarea name="message" placeholder="Message"></textarea>
</form>
<script>
  // Typing fires one keydown per character; a direct set fires none. Counted so the test can tell.
  window.keys = 0; document.addEventListener('keydown', () => keys++, true)
  window.values = () => { const f = document.getElementById('f'); return {
    name: f.name.value, email: f.email.value, phone: f.phone.value, agree: f.agree.checked,
    plan: f.querySelector('[name=plan]:checked').value, country: f.country.value, message: f.message.value } }
</script>`

function serve (handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(s))
  })
}

async function scriptedModel (actions, onRequest) {
  const requests = []
  const server = await serve((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', async () => {
      requests.push(JSON.parse(body))
      // The page may change WHILE the model is thinking — that gap is where refs go stale.
      if (onRequest) await onRequest(requests.length)
      const next = actions[Math.min(requests.length - 1, actions.length - 1)]
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(next) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  return { server, requests, base: `http://127.0.0.1:${server.address().port}` }
}

let browser
test.before(async () => { browser = await chromium.launch({ headless: true }) })
test.after(async () => { if (browser) await browser.close() })

async function pageWith (html, viewport = { width: 800, height: 600 }) {
  const page = await browser.newPage({ viewport })
  await page.setContent(html)
  return page
}

async function runLoop (html, actions, onRequest) {
  const site = await serve((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html) })
  let page
  const model = await scriptedModel(actions, onRequest && ((n) => onRequest(n, page)))
  const saved = { key: process.env.OPENAI_API_KEY, base: process.env.OPENAI_API_BASE, provider: process.env.BROWSER_AGENT_PROVIDER }
  process.env.OPENAI_API_KEY = 'test'
  process.env.OPENAI_API_BASE = model.base
  process.env.BROWSER_AGENT_PROVIDER = 'direct'
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  try {
    await page.goto(`http://127.0.0.1:${site.address().port}/`, { waitUntil: 'load' })
    const result = await agentLoop(page, { prompt: 'Fill in the form' }, { maxSteps: actions.length, model: 'gpt-4.1-nano', pageTools: null })
    return { result, page, requests: model.requests }
  } finally {
    site.close(); model.server.close()
    for (const [k, v] of [['OPENAI_API_KEY', saved.key], ['OPENAI_API_BASE', saved.base], ['BROWSER_AGENT_PROVIDER', saved.provider]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  }
}

// ── form_input ──────────────────────────────────────────────────────────────

test('form_input is advertised to the model and counts as a change for done-check', () => {
  assert.match(ACTION_HELP, /"type": "form_input", "element": "@N", "value"/)
  assert.equal(changedState({ type: 'form_input' }, { ok: true }), true)
  assert.equal(wantChecked('false'), false)
  assert.equal(wantChecked(true), true)
  assert.equal(wantChecked('yes'), true)
})

test('a 7-field form is filled by exactly 7 form_input actions, and every value lands', async () => {
  // Element ids follow the extractor's selector order: inputs, then select, then textarea.
  const probe = await pageWith(FORM)
  const dom = await extractDOM(probe)
  await probe.close()
  assert.deepEqual(dom.elements.map((e) => e.placeholder || e.type || e.tag),
    ['Full name', 'Email', 'Phone', 'checkbox', 'radio', 'radio', 'select', 'Message'])

  const fills = [
    { type: 'form_input', element: '@1', value: 'Ada Lovelace' },
    { type: 'form_input', element: '@2', value: 'ada@example.com' },
    { type: 'form_input', element: '@3', value: '555-0100' },
    { type: 'form_input', element: '@4', value: true },
    { type: 'form_input', element: '@6', value: true },
    { type: 'form_input', element: '@7', value: 'Canada' }, // by label
    { type: 'form_input', element: '@8', value: 'Hello\nthere' },
  ]
  const { result, page, requests } = await runLoop(FORM, [...fills, { type: 'done', result: 'Form filled in' }])
  try {
    assert.equal(result.success, true, result.error)
    assert.equal(result.steps, 8, '7 fills + done')
    assert.equal(result.history.filter((h) => h.startsWith('form_input')).length, 7)
    for (const h of result.history.slice(0, 7)) assert.doesNotMatch(h, /FAILED/, h)
    assert.deepEqual(await page.evaluate(() => window.values()), {
      name: 'Ada Lovelace', email: 'ada@example.com', phone: '555-0100', agree: true,
      plan: 'pro', country: 'ca', message: 'Hello\nthere',
    })
    // Set, not typed: no keystrokes at all.
    assert.equal(await page.evaluate(() => window.keys), 0)
    // The model was told about form_input in the prompt it actually received.
    assert.match(requests[0].messages[0].content, /form_input/)
  } finally { await page.close() }
})

test('select by value, checkbox off, radio switch, and a bad option is a clear failure', async () => {
  const page = await pageWith(FORM)
  try {
    const dom = await extractDOM(page)
    assert.equal((await executeAction(page, { type: 'form_input', element: '@7', value: 'mx' }, dom)).ok, true)
    assert.equal(await page.evaluate(() => window.values().country), 'mx')

    await executeAction(page, { type: 'form_input', element: '@4', value: true }, dom)
    const off = await executeAction(page, { type: 'form_input', element: '@4', value: 'false' }, dom)
    assert.equal(off.ok, true)
    assert.equal(await page.evaluate(() => window.values().agree), false)

    assert.equal(await page.evaluate(() => window.values().plan), 'basic')
    await executeAction(page, { type: 'form_input', element: '@6', value: true }, dom)
    assert.equal(await page.evaluate(() => window.values().plan), 'pro')
    const unradio = await executeAction(page, { type: 'form_input', element: '@6', value: false }, dom)
    assert.equal(unradio.ok, false)
    assert.match(unradio.message, /radio/)

    const bad = await executeAction(page, { type: 'form_input', element: '@7', value: 'Atlantis' }, dom)
    assert.equal(bad.ok, false)
    assert.match(bad.message, /United States \| Canada \| Mexico/)
  } finally { await page.close() }
})

// ── zoom ────────────────────────────────────────────────────────────────────

// Decode the PNG in the browser and read one pixel: dimensions AND content of the crop.
async function inspectPng (page, base64, at) {
  return page.evaluate(async ({ u, at }) => {
    const i = new Image(); i.src = u; await i.decode()
    const c = document.createElement('canvas'); c.width = i.width; c.height = i.height
    const x = c.getContext('2d'); x.drawImage(i, 0, 0)
    return { width: i.width, height: i.height, rgb: [...x.getImageData(at[0], at[1], 1, 1).data].slice(0, 3) }
  }, { u: `data:image/png;base64,${base64}`, at })
}

const QUADRANTS = `<!doctype html><body style="margin:0">
<div style="position:absolute;left:0;top:0;width:400px;height:300px;background:#ff0000"></div>
<div style="position:absolute;left:400px;top:300px;width:400px;height:300px;background:#0000ff"></div>
<div style="position:absolute;left:0;top:1200px;width:800px;height:200px;background:#00ff00"></div>
<div style="height:2000px"></div>`

test('zoom returns a PNG of exactly the requested region, in screenshot (viewport) space', async () => {
  const page = await pageWith(QUADRANTS)
  try {
    const red = await executeAction(page, { type: 'zoom', x: 100, y: 50, w: 120, h: 90 }, {})
    assert.equal(red.ok, true, red.message)
    assert.deepEqual(red.clip, { x: 100, y: 50, width: 120, height: 90 })
    assert.deepEqual(await inspectPng(page, red.image.base64, [60, 45]), { width: 120, height: 90, rgb: [255, 0, 0] })

    const blue = await executeAction(page, { type: 'zoom', x: 500, y: 400, w: 50, h: 40 }, {})
    assert.deepEqual((await inspectPng(page, blue.image.base64, [25, 20])).rgb, [0, 0, 255])

    // Scrolled: viewport space follows the scroll, like the screenshot action; full_page does not.
    await page.evaluate(() => scrollTo(0, 1200))
    const vp = await executeAction(page, { type: 'zoom', x: 10, y: 10, w: 30, h: 30 }, {})
    assert.deepEqual((await inspectPng(page, vp.image.base64, [15, 15])).rgb, [0, 255, 0])
    const doc = await executeAction(page, { type: 'zoom', x: 10, y: 10, w: 30, h: 30, full_page: true }, {})
    assert.deepEqual((await inspectPng(page, doc.image.base64, [15, 15])).rgb, [255, 0, 0])

    // Clamped to the viewport; nonsense refused.
    const edge = await executeAction(page, { type: 'zoom', x: 780, y: 0, w: 100, h: 10 }, {})
    assert.equal(edge.clip.width, 20)
    assert.equal((await executeAction(page, { type: 'zoom', x: 0, y: 0, w: 0, h: 10 }, {})).ok, false)
    assert.equal((await executeAction(page, { type: 'zoom', x: 900, y: 0, w: 10, h: 10 }, {})).ok, false)
  } finally { await page.close() }
})

test('a zoom image reaches the model on the next step only, and not in history', async () => {
  const { result, page, requests } = await runLoop(QUADRANTS, [
    { type: 'zoom', x: 100, y: 50, w: 120, h: 90 },
    { type: 'scroll', direction: 'down' },
    { type: 'fail', reason: 'stop' },
  ])
  try {
    assert.equal(result.steps, 3)
    const userOf = (r) => r.messages[1].content
    assert.equal(typeof userOf(requests[0]), 'string')
    const withImage = userOf(requests[1])
    assert.ok(Array.isArray(withImage), 'step after zoom has no image')
    const img = withImage.find((p) => p.type === 'image_url')
    assert.match(img.image_url.url, /^data:image\/png;base64,/)
    assert.match(withImage[0].text, /120x90 at 100,50/)
    const decoded = await inspectPng(page, img.image_url.url.split(',')[1], [60, 45])
    assert.deepEqual(decoded, { width: 120, height: 90, rgb: [255, 0, 0] })
    assert.equal(typeof userOf(requests[2]), 'string', 'image replayed past the next step')
    assert.ok(!result.history.join('\n').includes('base64'), 'image leaked into history')
  } finally { await page.close() }
})

// ── stale_ref ───────────────────────────────────────────────────────────────

const LIST = `<!doctype html><body>
<p>Shipping details below.</p>
<input id="a" placeholder="Old field">
<input id="b" placeholder="Postcode">
</body>`

test('acting on a removed element returns stale_ref, and find then succeeds', async () => {
  const page = await pageWith(LIST)
  try {
    const dom = await extractDOM(page)
    assert.equal(dom.elements[0].placeholder, 'Old field')
    // The page changes between observing and acting.
    await page.evaluate(() => document.getElementById('a').remove())

    for (const action of [
      { type: 'form_input', element: '@1', value: 'x' },
      { type: 'click', element: '@1' },
      { type: 'type', element: '@1', text: 'x' },
    ]) {
      const r = await executeAction(page, action, dom)
      assert.equal(r.ok, false)
      assert.equal(r.error, 'stale_ref', `${action.type}: ${r.message}`)
      assert.equal(r.ref, '@1')
      assert.match(r.hint, /find/)
    }
    // Positional lookup would have put 'x' into the Postcode field — the wrong one, silently.
    assert.equal(await page.inputValue('#b'), '')

    const found = await executeAction(page, { type: 'find', text: 'Shipping' }, dom)
    assert.equal(found.ok, true)
    assert.match(found.message, /1 match/)

    // A fresh snapshot resolves again; an id that was never listed is unknown, not stale.
    const fresh = await extractDOM(page)
    assert.equal((await executeAction(page, { type: 'form_input', element: '@1', value: 'SW1A' }, fresh)).ok, true)
    assert.equal(await page.inputValue('#b'), 'SW1A')
    assert.equal((await executeAction(page, { type: 'click', element: '@9' }, fresh)).error, 'unknown_ref')
    // An older snapshot is stale once a newer one replaced it.
    assert.equal((await executeAction(page, { type: 'form_input', element: '@2', value: 'y' }, dom)).error, 'stale_ref')
  } finally { await page.close() }
})

test('in the loop, a stale_ref reaches the model with the hint, and the following find succeeds', async () => {
  const { result, page, requests } = await runLoop(LIST, [
    { type: 'form_input', element: '@1', value: 'x' },
    { type: 'find', text: 'Postcode' },
    { type: 'fail', reason: 'stop' },
  ], async (n, page) => {
    // While the model decides step 1, the page drops the field it is about to name.
    if (n === 1) await page.evaluate(() => document.getElementById('a').remove())
  })
  try {
    assert.match(result.history[0], /^form_input @1 = "x" → Element @1 no longer exists on the page \(stale_ref\).*call find to locate it again.*\[FAILED/)
    assert.match(result.history[1], /^find "Postcode" → find "Postcode" — 0 match/)
    assert.match(requests[1].messages[1].content, /stale_ref/)
    assert.equal(await page.inputValue('#b'), '', 'the stale ref was applied to the wrong field')
  } finally { await page.close() }
})
