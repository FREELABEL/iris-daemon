/**
 * Browser check for the phone Hive inbox page (#184810).
 *
 * NOT a *.test.js — it needs a RUNNING daemon on :3200 and a real browser, so it
 * must not be swept into `node --test tests/*.test.js`, which would fail on any
 * machine without one. Run it deliberately:
 *
 *     node tests/browser/hive-ui.browser.js /tmp/shots
 *
 * It exists because reading this page's source was not enough twice over. The
 * first run caught expand() calling load(), which rebuilt the list and collapsed
 * the item the user had just tapped open — the code reads perfectly fine. The
 * second run caught two flaws in the CHECK rather than the page: an assertion on
 * a fixed 900ms sleep (a race that had been passing), and counting the browser's
 * automatic "Failed to load resource" log for a 401 the page deliberately
 * provokes and handles. A check that cannot tell those apart reports noise as
 * failure and, on a slower day, failure as success.
 */
const { chromium } = require('/Users/mayoalexander/.iris/bridge/node_modules/playwright')
const fs = require('fs')
const KEY = fs.readFileSync(process.env.HOME + '/.iris/bridge-token', 'utf8').trim()
const OUT = process.argv[2]

;(async () => {
  const browser = await chromium.launch()
  const fail = []
  const ok = (cond, label) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + label); if (!cond) fail.push(label) }

  // iPhone-ish viewport — this page's whole point is a phone.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', e => errs.push(String(e)))
  page.on('console', m => {
    if (m.type() !== 'error') return
    if (/Failed to load resource/.test(m.text())) return // handled 401s, see below
    errs.push('console: ' + m.text())
  })

  await page.goto('http://localhost:3200/hive/ui', { waitUntil: 'networkidle' })

  console.log('\n-- no key saved --')
  ok(await page.locator('#k').isVisible(), 'prompts for the bridge key')
  ok((await page.locator('body').innerText()).includes('cat ~/.iris/bridge-token'), 'names the token file')
  await page.screenshot({ path: OUT + '/ui-1-locked.png' })

  console.log('\n-- wrong key --')
  await page.fill('#k', 'definitely-not-the-token')
  await page.click('#save')
  let rejected = true
  try { await page.waitForFunction(() => /rejected that key/i.test(document.body.innerText), null, { timeout: 6000 }) }
  catch { rejected = false }
  ok(rejected, 'a wrong key says REJECTED, not "unreachable"')
  await page.screenshot({ path: OUT + '/ui-2-rejected.png' })

  // The 401 above is the point of that step; stop counting it as a page fault.
  errs.length = 0
  console.log('\n-- correct key --')
  await page.fill('#k', KEY)
  await page.click('#save')
  await page.waitForSelector('ul li', { timeout: 8000 })
  const n = await page.locator('ul li').count()
  ok(n > 0, `renders ${n} inbox item(s)`)
  ok(/unread/.test(await page.locator('#counts').innerText()), 'shows the unread count')
  await page.screenshot({ path: OUT + '/ui-3-inbox.png' })

  console.log('\n-- tap to expand --')
  const before = await page.locator('ul li').first().innerText()
  await page.locator('ul li').first().click()
  await page.waitForTimeout(1200)
  const after = await page.locator('ul li').first().innerText()
  ok(await page.locator('ul li').first().getAttribute('aria-expanded') === 'true', 'expands on tap')
  ok(after.length >= before.length, 'body text did not shrink or blank on expand')
  await page.screenshot({ path: OUT + '/ui-4-expanded.png' })

  console.log('\n-- layout --')
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  ok(overflow <= 0, `no horizontal scroll at 390px (overflow ${overflow}px)`)

  console.log('\n-- dark mode --')
  const dark = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', deviceScaleFactor: 2 })
  const dp = await dark.newPage()
  await dp.addInitScript(k => localStorage.setItem('iris.bridgeKey', k), KEY)
  await dp.goto('http://localhost:3200/hive/ui', { waitUntil: 'networkidle' })
  await dp.waitForSelector('ul li', { timeout: 8000 })
  const bg = await dp.evaluate(() => getComputedStyle(document.body).backgroundColor)
  ok(bg !== 'rgba(0, 0, 0, 0)' && bg !== 'rgb(250, 249, 247)', `dark background actually applies (${bg})`)
  await dp.screenshot({ path: OUT + '/ui-5-dark.png' })

  console.log('\n-- js errors --')
  ok(errs.length === 0, errs.length ? 'page errors: ' + errs.join(' | ') : 'no page/console errors')

  await browser.close()
  console.log(fail.length ? `\nFAILED ${fail.length}` : '\nALL PASS')
  process.exit(fail.length ? 1 : 0)
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2) })
