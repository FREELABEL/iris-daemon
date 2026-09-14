/**
 * XSS probe for the phone Hive inbox page (#184810).
 *
 * NOT a *.test.js — needs a running daemon and a real browser. Run deliberately:
 *     node tests/browser/hive-ui-xss.browser.js
 *
 * Why this page specifically: it renders content written by OTHER NODES. A peer
 * chooses the message body and the node name. The page also holds the bridge key
 * in localStorage, so script execution here is not a defacement — it is key
 * disclosure, and the key opens every authenticated route on this daemon.
 *
 * Currently PASSES: every payload renders as text. The point of keeping it is the
 * next edit, not this one. Swapping one esc() for a template literal is a one-line
 * change that looks harmless in review and would fail here loudly.
 */
// The Hive inbox page renders content written by OTHER NODES. A peer can put
// anything in a message body or a node name. If either reaches innerHTML
// unescaped, any peer that can send this operator a message can run script in
// the page — and the page holds the bridge key in localStorage.
const { chromium } = require('/Users/mayoalexander/.iris/bridge/node_modules/playwright')
const fs = require('fs')
const KEY = fs.readFileSync(process.env.HOME + '/.iris/bridge-token', 'utf8').trim()

const PAYLOADS = [
  { id: 'p1', from_node: 'peer', message: '<img src=x onerror="window.__XSS_MSG=1">' },
  { id: 'p2', from_node: '<img src=x onerror="window.__XSS_NODE=1">', message: 'hello' },
  { id: 'p3', from_node: 'peer', message: '<script>window.__XSS_SCRIPT=1<\/script>' },
  { id: 'p4', from_node: 'peer', message: '"><svg onload="window.__XSS_ATTR=1">' }
]

;(async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await ctx.newPage()
  await page.addInitScript(k => localStorage.setItem('iris.bridgeKey', k), KEY)

  // Serve hostile inbox data from the daemon's own origin so the page's fetch
  // sees it exactly as it would see a real peer message.
  await page.route('**/hive/inbox*', route => {
    if (/\/hive\/inbox\/[^/?]+$/.test(new URL(route.request().url()).pathname)) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ id: 'p1', body: '<img src=x onerror="window.__XSS_BODY=1">' }) })
    }
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: PAYLOADS.map(p => ({ ...p, received_at: new Date().toISOString(), read: false })), count: 4, unread: 4, node: 'test' }) })
  })

  await page.goto('http://localhost:3200/hive/ui', { waitUntil: 'networkidle' })
  await page.waitForSelector('ul li', { timeout: 8000 })
  await page.locator('ul li').first().click()
  await page.waitForTimeout(900)

  const fired = await page.evaluate(() => ({
    msg: !!window.__XSS_MSG, node: !!window.__XSS_NODE, script: !!window.__XSS_SCRIPT,
    attr: !!window.__XSS_ATTR, body: !!window.__XSS_BODY,
    imgs: document.querySelectorAll('ul img, ul svg, ul script').length,
    shown: document.querySelector('ul li .msg').textContent.slice(0, 60)
  }))
  console.log(JSON.stringify(fired, null, 2))
  const bad = Object.entries(fired).filter(([k, v]) => k.startsWith('__') || (typeof v === 'boolean' && v))
  console.log(bad.length ? 'XSS FIRED: ' + JSON.stringify(bad) : 'NO XSS — all payloads rendered as text')
  console.log(fired.imgs === 0 ? 'no injected elements' : `INJECTED ${fired.imgs} element(s)`)
  await browser.close()
  // Exit non-zero on a finding so this can gate a change rather than merely
  // narrate one into a log nobody reads.
  const failed = fired.msg || fired.node || fired.script || fired.attr || fired.body || fired.imgs > 0
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('HARNESS', e.message); process.exit(2) })
