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
  it('refuses a private, loopback or link-local host — the agent path is not an SSRF with a picture', () => {
    for (const u of ['http://127.0.0.1:8765/x', 'http://localhost:3000', 'http://192.168.1.50/admin',
      'http://10.0.0.5/', 'http://172.16.4.4/', 'http://169.254.169.254/latest/meta-data/', 'http://printer.local/']) {
      assert.throws(() => validate('render_check', { url: u }), /private network|on this machine/, u)
    }
    // a local caller that means it still can
    assert.ok(validate('render_check', { url: 'http://127.0.0.1:8765/x', allow_private: true }).url)
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
    // A webfont whose file 404s. The check must catch this: the computed font-family still names
    // the font, and Chrome loads fonts lazily, so an earlier version called heyiris.io's working
    // Instrument Sans "falling back" in one run and fine in the next.
    '/webfont.html': '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Webfont</title><style>@font-face{font-family:"Ghost Sans";src:url(/nope.woff2) format("woff2")} h1,p{font-family:"Ghost Sans",sans-serif}</style></head><body><h1>Blocked webfont</h1><p>Reported as falling back.</p></body></html>',
    // Left: a nav clipped by 24px inside overflow:hidden — invisible to the scrollWidth test,
    // because a clipping ancestor absorbs it (found on /p/fleet-layer, where a "Get Started"
    // button was sliced and the page reported no overflow). Right: a marquee track 6x wider
    // than its box, which is intentional and must NOT be reported.
    '/clipped.html': '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Clipped</title></head>' +
      '<body style="margin:0;font-family:Georgia,serif"><h1>Clipped</h1>' +
      '<div style="overflow:hidden;white-space:nowrap"><button style="margin-left:300px;width:104px">Get Started</button></div>' +
      '<div style="overflow:hidden"><div style="display:flex;width:1800px"><span style="width:600px">MB logo</span><span style="width:600px">FL logo</span><span style="width:600px">CD logo</span></div></div>' +
      '</body></html>',
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
  const run = (prompt) => runBrowserUseTask({ prompt, config: { allow_private: true } }, { upload })
  const expect_fail = (r) => { assert.equal(r.status, 'completed', r.error); assert.equal(r.data.ok, false) }

  it('a dispatched task may opt into a private host only through config.allow_private', async () => {
    const denied = await runBrowserUseTask({ prompt: `render_check url=${base}/good.html` }, { upload })
    assert.equal(denied.status, 'failed')
    assert.match(denied.error, /private network|on this machine/)
  })

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

  it('catches a webfont that never arrives, and clears a working one', { timeout: 120000 }, async () => {
    const bad = await run(`render_check url=${base}/webfont.html`)
    expect_fail(bad)
    assert.match(bad.data.failures.join(' | '), /Ghost Sans/)
    assert.equal(bad.data.fonts['Ghost Sans'], false)

    const good = await run(`render_check url=${base}/good.html`)
    assert.equal(good.data.ok, true, JSON.stringify(good.data.failures))
  })

  it('reports content CUT OFF inside a clipping ancestor, but not a marquee track', { timeout: 120000 }, async () => {
    const r = await run(`render_check url=${base}/clipped.html viewports=narrow:360x800`)
    expect_fail(r)
    const cut = r.data.failures.filter(f => /cut off/.test(f))
    assert.equal(cut.length, 1, r.data.failures.join(' | '))
    assert.match(cut[0], /Get Started/)
    assert.equal(r.data.viewports.narrow.overflow_x, false, 'the scrollWidth test alone would pass this page')
  })

  it('an unreachable page FAILS the task as unmeasured — never a pass', { timeout: 120000 }, async () => {
    const r = await run('render_check url=http://127.0.0.1:1/nothing')
    assert.equal(r.status, 'failed')
    assert.match(r.error, /could not measure/)
    assert.equal(r.data.measured, false)
  })
})

describe('browser_use: routing capability', () => {
  const index = fs.readFileSync(path.join(ROOT, 'daemon/index.js'), 'utf8')
  it('the heartbeat advertises task_capabilities.browser_use from the real probe', () => {
    assert.match(index, /task_capabilities:[\s\S]{0,200}browserUseCapability\(\)/)
  })
  it('the probe answers a boolean and never throws', () => {
    const { browserUseCapability } = require('../daemon/browser-use-task')
    assert.equal(typeof browserUseCapability(), 'boolean')
  })
})

// ── safe_click: the click-validation helpers (ported from browser-use/jev-ultrafast, MIT) ──
// Both tools we measured reported success for a click that did nothing. These pin the four
// refusals and the one success that matter, through the REAL browser-harness loader.
describe('agent_helpers: safe_click', { skip: !canRunBrowser() && 'no Chrome or browser-use on this machine' }, () => {
  const { spawn, execFileSync: run } = require('child_process')
  const os = require('os')
  let server, base, profile, chrome, port
  const page = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Clicks</title></head>' +
    '<body style="font-family:Georgia,serif;margin:20px;width:300px"><h1>Clicks</h1>' +
    '<p>Text <a id="wrap" href="#wrapped">this link text is long enough to wrap onto a second line here</a> after.</p>' +
    '<div style="position:relative;height:60px"><button id="under" onclick="document.title=\'UNDER CLICKED\'">Covered Button</button>' +
    '<div style="position:absolute;inset:0;background:rgba(0,0,0,.3)">Cookie banner</div></div>' +
    '<button>Next</button> <button>Next</button></body></html>'
  const env = () => ({ ...process.env, BU_NAME: `t${process.pid}`, BU_CDP_URL: `http://127.0.0.1:${port}`,
    BH_TELEMETRY: '0', BH_TAB_MARKER: '0',
    BH_AGENT_WORKSPACE: path.join(profile, 'ws'),   // load THIS checkout's helpers, not whatever is installed
    PATH: `${os.homedir()}/.local/bin:/opt/homebrew/bin:${process.env.PATH}` })

  before(async () => {
    server = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(page) })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${server.address().port}`
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'safeclick-'))
    fs.mkdirSync(path.join(profile, 'ws'))
    fs.copyFileSync(path.join(ROOT, 'scripts/browser-use/agent_helpers.py'), path.join(profile, 'ws', 'agent_helpers.py'))
    port = 9400 + (process.pid % 500)
    chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ['--headless=new', `--user-data-dir=${path.join(profile, 'chrome')}`, `--remote-debugging-port=${port}`, '--no-first-run', 'about:blank'],
      { stdio: 'ignore' })
    for (let i = 0; i < 40; i++) { try { run('curl', ['-sf', `http://127.0.0.1:${port}/json/version`]); break } catch { await new Promise(r => setTimeout(r, 250)) } }
  })
  after(() => {
    try { run('browser-use', ['--reload'], { env: env(), stdio: 'ignore' }) } catch {}
    chrome.kill('SIGKILL'); server.close()
    try { run('chmod', ['-R', 'u+rwX', profile]); fs.rmSync(profile, { recursive: true, force: true }) } catch {}
  })

  it('clicks a wrapped link, refuses a covered, ambiguous or stale target', { timeout: 120000 }, async () => {
    const script = `
import json
new_tab("${base}/"); wait_for_load()
out = {}
def attempt(k, fn):
    try: out[k] = {"ok": True, **fn()}
    except ClickBlocked as e: out[k] = {"ok": False, "why": str(e)}
els = elements(); w = [e for e in els if e["href"] == "#wrapped"][0]
out["lines"] = w["lines"]
attempt("wrapped", lambda: safe_click(w["i"]))
attempt("covered", lambda: click_text("Covered Button"))
out["title"] = page_info()["title"]
attempt("ambiguous", lambda: click_text("Next"))
elements(); js("window.__irisGen++")
attempt("stale", lambda: safe_click(1))
out["harness_js"] = js("1+1")
print("RESULT=" + json.dumps(out))
`
    // ASYNC, never execFileSync: the page server above lives in THIS process, and a sync exec
    // blocks the event loop, so Chrome's request for the page never gets an answer and the test
    // times out looking like a browser failure (execfilesync-starves-an-in-process-server).
    const res = await new Promise((resolve, reject) => {
      const child = spawn('browser-use', [], { env: env() })
      let out = '', err = ''
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('browser-use timed out: ' + err.slice(-300))) }, 90000)
      child.stdout.on('data', d => { out += d }); child.stderr.on('data', d => { err += d })
      child.on('close', () => { clearTimeout(timer); resolve(out + '\n' + err) })
      child.stdin.end(script)
    })
    const r = JSON.parse(res.split('\n').find(l => l.startsWith('RESULT=')).slice(7))
    assert.ok(r.lines >= 2, 'fixture link must actually wrap')
    assert.equal(r.wrapped.ok, true); assert.equal(r.wrapped.changed, true)
    assert.match(r.wrapped.url_after, /#wrapped$/)
    assert.equal(r.covered.ok, false); assert.match(r.covered.why, /covered by .*Cookie banner/)
    assert.notEqual(r.title, 'UNDER CLICKED', 'the covered button must never receive the click')
    assert.equal(r.ambiguous.ok, false); assert.match(r.ambiguous.why, /matches 2 controls/)
    assert.equal(r.stale.ok, false); assert.match(r.stale.why, /stale/)
    assert.equal(r.harness_js, 2, "loading the helpers must not replace the harness's own js()")
  })
})
