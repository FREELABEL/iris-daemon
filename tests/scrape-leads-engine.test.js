/**
 * scrape-leads.sh — the engine choice (#191700).
 *
 * Field audit 2026-10-29: `iris reachr scrape <board> <url>` died with "browser-use not installed"
 * before reading a URL, on a node whose bridge already ships Playwright and its Chromium. The
 * script now drives that Playwright Chromium first and falls back to browser-use. These tests pin:
 *  - with Playwright present, it is used and browser-use is NOT needed (no browser-use on PATH);
 *  - with neither engine, it is exit 2 ("could not measure") and the error names the fix;
 *  - pagination keeps click_text's refusals (an ambiguous "Next" stops the crawl).
 * The extraction results themselves are pinned by browser-use-task.test.js, which now runs on
 * either engine.
 */
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { execFile, execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'scripts/browser-use')

// A copy of the scripts OUTSIDE the repo, so Playwright cannot be resolved from a node_modules
// next to them — the shape of a machine that has neither engine.
function isolatedCopy () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-engine-'))
  const bin = path.join(dir, 'scripts', 'browser-use')
  fs.mkdirSync(bin, { recursive: true })
  for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(bin, f))
  return { home: dir, script: path.join(bin, 'scrape-leads.sh') }
}

// PATH with only what the script itself needs — no browser-use, no uvx, no Chrome.
function barePath () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-path-'))
  for (const b of ['bash', 'node', 'python3', 'grep', 'tail', 'tr', 'mktemp', 'rm', 'cat', 'dirname', 'sed', 'head', 'curl']) {
    try { fs.symlinkSync(execFileSync('bash', ['-c', `command -v ${b}`], { encoding: 'utf8' }).trim(), path.join(dir, b)) } catch { /* optional */ }
  }
  return dir
}

const run = (script, args, env) => new Promise(resolve => {
  execFile('bash', [script, ...args, '--delay', '0.1'], { timeout: 120000, env }, (err, stdout) => {
    const line = String(stdout).trim().split('\n').filter(l => l.startsWith('{')).pop()
    resolve({ code: err ? err.code : 0, data: line ? JSON.parse(line) : null, raw: String(stdout) })
  })
})

const playwrightHere = (() => {
  try { execFileSync('node', [path.join(SRC, 'scrape-leads.js'), '--probe'], { stdio: 'ignore' }); return true } catch { return false }
})()

describe('scrape-leads.sh engine: neither engine installed', () => {
  it('is exit 2 (not "no leads") and names how to install either engine', async () => {
    const { home, script } = isolatedCopy()
    const { code, data } = await run(script, ['https://example.test/', '--no-follow'],
      { PATH: barePath(), HOME: home, TMPDIR: os.tmpdir() })
    assert.equal(code, 2)
    assert.equal(data.measured, false)
    assert.match(data.error, /no browser engine/)
    assert.match(data.error, /Playwright not found/)
    assert.match(data.error, /iris daemon update/)
    assert.match(data.error, /npx playwright install chromium/)
    assert.match(data.error, /uv tool install browser-use/)
  })

  it('SL_ENGINE=playwright with no Playwright says exactly that', async () => {
    const { home, script } = isolatedCopy()
    const { code, data } = await run(script, ['https://example.test/'],
      { PATH: barePath(), HOME: home, TMPDIR: os.tmpdir(), SL_ENGINE: 'playwright' })
    assert.equal(code, 2)
    assert.match(data.error, /no browser engine: Playwright not found.*iris daemon update/)
  })
})

describe('scrape-leads.sh engine: Playwright', { skip: !playwrightHere && 'no Playwright Chromium on this machine' }, () => {
  let server, base
  const card = (n, t) => `<div class="team-member"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="60" height="60"><h3>${n}</h3><p class="role">${t}</p></div>`
  const site = {
    '/robots.txt': 'User-agent: *\nDisallow:\n',
    '/team': '<html><head><title>Team | Bean Co</title></head><body>' + card('Maria Gonzalez', 'Owner') +
      '<a href="/team2">Next</a></body></html>',
    '/team2': '<html><head><title>Team 2 | Bean Co</title></head><body>' + card('James Walker', 'Head Roaster') + '</body></html>',
    '/two-nexts': '<html><head><title>Dir</title></head><body>' + card('Ana Lima', 'Manager') +
      '<a href="/team2">Next</a><a href="/team2?b">Next</a></body></html>',
  }
  before(async () => {
    server = http.createServer((q, r) => {
      const body = site[q.url.split('?')[0]]
      r.writeHead(body ? 200 : 404, { 'Content-Type': q.url === '/robots.txt' ? 'text/plain' : 'text/html; charset=utf-8' })
      r.end(body || 'not found')
    })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${server.address().port}`
  })
  after(() => server.close())

  // HOME is kept so the bridge's Playwright and its Chromium resolve; PATH has no browser-use.
  const env = () => ({ PATH: barePath(), HOME: os.homedir(), TMPDIR: os.tmpdir() })

  it('reads pages with Playwright and needs no browser-use', { timeout: 120000 }, async () => {
    const { code, data } = await run(path.join(SRC, 'scrape-leads.sh'), [`${base}/team`, '--no-follow', '--max-pages', '1'], env())
    assert.equal(code, 0, JSON.stringify(data))
    assert.equal(data.engine, 'playwright')
    assert.deepEqual(data.leads.map(l => l.name.v), ['Maria Gonzalez'])
  })

  it('pages with --next, and stops when "Next" is ambiguous instead of guessing', { timeout: 120000 }, async () => {
    const paged = await run(path.join(SRC, 'scrape-leads.sh'), [`${base}/team`, '--no-follow', '--next', 'Next', '--max-pages', '3'], env())
    assert.deepEqual(paged.data.leads.map(l => l.name.v).sort(), ['James Walker', 'Maria Gonzalez'])
    assert.equal(paged.data.pages[1].how, 'next')

    const amb = await run(path.join(SRC, 'scrape-leads.sh'), [`${base}/two-nexts`, '--no-follow', '--next', 'Next', '--max-pages', '3'], env())
    assert.deepEqual(amb.data.leads.map(l => l.name.v), ['Ana Lima'])
    assert.match(amb.data.pages[0].pagination_stopped, /matches 2 controls/)
  })
})
