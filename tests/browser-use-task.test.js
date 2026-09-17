/**
 * browser_use — the structured browser-check lane.
 *
 * The unit tests pin parsing and the refusals. The end-to-end test runs the REAL module and the
 * REAL render-check.sh against a local page, because every bug found while building this was
 * invisible to reading the code: an unreachable url reported as a pass, a page with no viewport
 * meta passing the overflow check, and a thrown page error reported as no errors at all.
 */
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const http = require('http')
const { execFileSync } = require('child_process')
const { runBrowserUseTask, parsePrompt, validate } = require('../daemon/browser-use-task')

const ROOT = path.resolve(__dirname, '..')

describe('browser_use: parsing', () => {
  it('reads the V6 prompt shape and keeps = inside a url', () => {
    const { fn, args } = parsePrompt('render_check url=https://x.test/p?a=1&b=2 schemes=light,dark')
    assert.equal(fn, 'render_check')
    assert.equal(args.url, 'https://x.test/p?a=1&b=2')
    assert.equal(args.schemes, 'light,dark')
  })
})

describe('browser_use: refusals explain themselves', () => {
  it('rejects an unknown function by naming the ones that exist', () => {
    assert.throws(() => validate('run_python', { url: 'https://x.test' }), /Available: render_check/)
  })
  it('rejects non-http urls', () => {
    assert.throws(() => validate('render_check', { url: 'file:///etc/passwd' }), /http\(s\)/)
  })
  it('refuses a url carrying a gate-opening credential, because shots go to a public CDN', () => {
    assert.throws(() => validate('render_check', { url: 'https://heyiris.io/p/x?atlas_token=abc' }), /atlas_token/)
    assert.throws(() => validate('render_check', { url: 'https://u:p@heyiris.io/p/x' }), /embedded credentials/)
  })
  it('refuses malformed viewports and schemes rather than passing them to a shell', () => {
    assert.throws(() => validate('render_check', { url: 'https://x.test', viewports: 'desktop:1280x900;rm -rf' }), /viewports/)
    assert.throws(() => validate('render_check', { url: 'https://x.test', schemes: 'sepia' }), /schemes/)
  })
})

describe('browser_use: wiring', () => {
  const executor = fs.readFileSync(path.join(ROOT, 'daemon/task-executor.js'), 'utf8')
  const gate = fs.readFileSync(path.join(ROOT, 'daemon/admission-gate.js'), 'utf8')
  it('the executor short-circuits browser_use through the shared module', () => {
    assert.ok(executor.includes("task.type === 'browser_use'"))
    assert.ok(executor.includes("require('./browser-use-task')"))
  })
  it('is a KNOWN structured type, so an old prompt never runs as a shell command', () => {
    assert.match(executor, /KNOWN_STRUCTURED_TYPES = new Set\(\[[^\]]*'browser_use'/)
  })
  it('takes the browser slot in both declarations', () => {
    assert.match(gate.split('\n').find(l => l.includes('const BROWSER_TYPES')), /'browser_use'/)
    assert.match(executor.split('\n').find(l => l.includes('static BROWSER_TYPES')), /'browser_use'/)
  })
  it('ships the script it calls', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts/browser-use/render-check.sh')))
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts/browser-use/render-check.py')))
  })
})

function canRunBrowser () {
  if (process.platform === 'win32' || process.env.SKIP_BROWSER_E2E) return false
  const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` }
  try { execFileSync('bash', ['-c', 'command -v browser-use || command -v uvx'], { env, stdio: 'ignore' }) } catch { return false }
  return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']
    .some(p => fs.existsSync(p))
}

describe('browser_use: end to end (real Chrome)', { skip: !canRunBrowser() && 'no Chrome or browser-use on this machine' }, () => {
  let server; let base
  const pages = {
    '/good.html': '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Good</title></head><body style="font-family:Georgia,serif"><h1>Good</h1></body></html>',
    '/broken.html': '<!doctype html><html><head><title>Broken</title><style>body{font-family:"Nonexistent Grotesk",sans-serif}</style></head><body><p>no heading</p><div id="slab" style="width:900px;height:20px"></div><script>throw new Error("boom from page")</script></body></html>',
    '/wide.html': '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wide</title></head><body style="margin:0;font-family:Georgia,serif"><h1>Wide</h1><div id="slab" style="width:600px;height:20px"></div></body></html>'
  }
  before(async () => {
    server = http.createServer((req, res) => {
      const body = pages[req.url]
      res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html' }); res.end(body || 'not found')
    })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${server.address().port}`
  })
  after(() => server.close())

  const uploaded = []
  const upload = async (files) => { uploaded.push(...files); return files.map(f => ({ filename: f.filename, url: `https://cdn.test/${f.filename}` })) }
  const run = (prompt) => runBrowserUseTask({ prompt }, { upload })

  it('a good page completes ok, with uploaded screenshot urls', { timeout: 120000 }, async () => {
    const r = await run(`render_check url=${base}/good.html`)
    assert.equal(r.status, 'completed', r.error)
    assert.equal(r.data.ok, true, JSON.stringify(r.data.failures))
    assert.equal(r.data.screenshots.length, 2)
    assert.ok(r.data.screenshots.every(s => s.url && s.url.startsWith('https://cdn.test/')))
    assert.ok(uploaded.every(f => Buffer.from(f.content_base64, 'base64').subarray(1, 4).toString() === 'PNG'))
  })

  it('a broken page COMPLETES with ok:false and names every problem, including the thrown error', { timeout: 120000 }, async () => {
    const r = await run(`render_check url=${base}/broken.html`)
    assert.equal(r.status, 'completed')
    assert.equal(r.data.ok, false)
    const f = r.data.failures.join(' | ')
    assert.match(f, /no h1/)
    assert.match(f, /Nonexistent Grotesk/)
    assert.match(f, /no responsive viewport meta/)
    assert.ok(r.data.console_errors.some(e => e.includes('boom from page')), JSON.stringify(r.data.console_errors))
  })

  it('names the element that overflows on a phone', { timeout: 120000 }, async () => {
    const r = await run(`render_check url=${base}/wide.html`)
    assert.equal(r.data.ok, false)
    assert.deepEqual(r.data.viewports.mobile.offenders, ['div#slab'])
  })

  it('an unreachable page FAILS the task as unmeasured — never a pass', { timeout: 120000 }, async () => {
    const r = await run('render_check url=http://127.0.0.1:1/nothing')
    assert.equal(r.status, 'failed')
    assert.match(r.error, /could not measure/)
    assert.equal(r.data.measured, false)
  })
})
