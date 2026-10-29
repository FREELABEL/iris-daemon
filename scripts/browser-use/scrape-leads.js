#!/usr/bin/env node
// scrape-leads.js — the PLAYWRIGHT engine for scrape-leads.sh (#191700).
//
// WHY. The public-page lead scrape (`iris reachr scrape <board> <url>`) only ran through
// browser-use, which no Hive node installs. The field audit on 2026-10-29 (board 836, 17 Austin
// coffee shops) failed before reading a single URL with "browser-use not installed" — on a Mac
// whose bridge already ships playwright + @playwright/test and whose daemon provisions Chromium on
// boot (lib/playwright-setup.js). This drives THAT browser instead, so the scrape needs nothing
// the node does not already have.
//
// SAME BEHAVIOUR, SAME OUTPUT. It reads the same env (SL_URLS, SL_FOLLOW, SL_MAX_PAGES, SL_NEXT,
// SL_DELAY), runs the same extractor (scrape-leads.extract.js — one copy, shared with the
// browser-use engine), obeys robots.txt the same way, waits between pages, follows only same-site
// links, and prints exactly one `SL_RESULT=` line of the same shape. Pagination keeps
// click_text's refusals: a "Next" that matches no control, more than one, or one that is covered
// stops the crawl instead of paging the wrong list.
//
// If no Playwright or no Chromium can be found it prints `SL_RESULT=` with engine_unavailable and
// the exact install command, so scrape-leads.sh can fall back or say what to install.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const HERE = __dirname
const BRIDGE = path.resolve(HERE, '..', '..')
const UA = 'IRIS-ReachR/1.0 (+https://heyiris.io)'

const emit = (o) => { process.stdout.write('SL_RESULT=' + JSON.stringify(o) + '\n') }

function loadPlaywright () {
  const roots = [HERE, BRIDGE, path.join(os.homedir(), '.iris', 'bridge')]
  for (const mod of ['playwright', '@playwright/test', 'playwright-core']) {
    try {
      const p = require.resolve(mod, { paths: roots })
      const pw = require(p)
      if (pw && pw.chromium) return pw
    } catch { /* try the next */ }
  }
  return null
}

// ── robots.txt — the same rules urllib.robotparser applies in scrape-leads.py ──
// Unreachable robots.txt → allow (the web's convention); 401/403 → disallow everything; any other
// HTTP error → allow. Groups are matched on our product token, else "*"; first matching rule wins.
const robotsCache = new Map()
async function robotsAllows (url) {
  const u = new URL(url)
  const root = `${u.protocol}//${u.host}`
  if (!robotsCache.has(root)) {
    let rules = { all: true }
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 8000)
      const r = await fetch(root + '/robots.txt', { headers: { 'User-Agent': UA }, signal: ctl.signal, redirect: 'follow' })
      clearTimeout(t)
      if (r.status === 401 || r.status === 403) rules = { none: true }
      else if (r.ok) rules = parseRobots(await r.text())
    } catch { rules = { all: true } }
    robotsCache.set(root, rules)
  }
  const rules = robotsCache.get(root)
  if (rules.none) return false
  if (rules.all) return true
  const target = (u.pathname || '/') + (u.search || '')
  for (const [allow, p] of rules.lines) {
    if (p === '' ) { if (!allow) continue; return true }
    if (target.startsWith(p)) return allow
  }
  return true
}

function parseRobots (text) {
  const groups = []
  let cur = null
  let lastWasAgent = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const i = line.indexOf(':')
    if (i < 0) continue
    const k = line.slice(0, i).trim().toLowerCase()
    const v = line.slice(i + 1).trim()
    if (k === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], lines: [] }; groups.push(cur) }
      cur.agents.push(v.toLowerCase())
      lastWasAgent = true
    } else if ((k === 'disallow' || k === 'allow') && cur) {
      cur.lines.push([k === 'allow', decodeURIComponent(v)])
      lastWasAgent = false
    } else lastWasAgent = false
  }
  const token = UA.split('/')[0].toLowerCase()
  const mine = groups.find((g) => g.agents.some((a) => a !== '*' && token.includes(a)))
  const star = groups.find((g) => g.agents.includes('*'))
  const g = mine || star
  return g ? { lines: g.lines } : { all: true }
}

// ── click_text, with safe_click's refusals ──
const CLICK_JS = `(needle) => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' };
  const nameOf = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || el.title || '').replace(/\\s+/g, ' ').trim();
  const els = [...document.querySelectorAll('a[href],button,[role=button],[role=link],input[type=submit],input[type=button]')].filter(vis);
  const hits = els.filter((e) => nameOf(e).toLowerCase() === needle);
  if (!hits.length) return { error: 'no visible control matching "' + needle + '" (searched ' + els.length + ')' };
  if (hits.length > 1) return { error: '"' + needle + '" matches ' + hits.length + ' controls — refusing to guess' };
  const el = hits[0];
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  if (!hit || !(hit === el || el.contains(hit))) return { error: 'the control is covered by ' + (hit ? hit.tagName.toLowerCase() : 'nothing') + ' — refusing to click the element on top' };
  return { x, y };
}`
const fingerprint = (page) => page.evaluate(() => location.href + '|' + document.title + '|' + document.body.innerText.length)

async function main () {
  const starts = (process.env.SL_URLS || '').split('\n').map((s) => s.trim()).filter(Boolean)
  const follow = (process.env.SL_FOLLOW || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  const maxPages = parseInt(process.env.SL_MAX_PAGES || '6', 10) || 6
  const nextText = (process.env.SL_NEXT || '').trim()
  const delay = parseFloat(process.env.SL_DELAY || '1.5') || 1.5
  const extractFile = process.env.SL_EXTRACT_FILE || path.join(HERE, 'scrape-leads.extract.js')
  const EXTRACT_JS = fs.readFileSync(extractFile, 'utf8')

  const pw = loadPlaywright()
  if (!pw) {
    return emit({ ok: false, measured: false, engine_unavailable: true, engine: 'playwright',
      error: `Playwright not found (looked under ${BRIDGE}/node_modules) — run \`iris daemon update\`, which installs the bridge's Playwright` })
  }

  let browser
  try {
    browser = await pw.chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN || undefined })
  } catch (e) {
    const msg = String(e && e.message || e).split('\n')[0].slice(0, 200)
    return emit({ ok: false, measured: false, engine_unavailable: true, engine: 'playwright',
      error: `Playwright is installed but could not start Chromium (${msg}) — run: cd ${BRIDGE} && npx playwright install chromium` })
  }

  const result = { measured: false, engine: 'playwright', pages: [], leads: [], contacts: [], skipped: [] }
  const queue = [...starts]
  const visited = new Set()
  const leadKeys = new Set()
  let read = 0
  const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000))

  const take = (page) => {
    for (const p of page.people) {
      const key = ((p.email && p.email.v) || p.name.v).toLowerCase()
      if (leadKeys.has(key)) continue
      leadKeys.add(key)
      const own = p.company
      p.company = own || page.company
      p.company_how = !own || own === page.company ? page.company_how : 'json-ld'
      p.source_url = page.url
      result.leads.push(p)
    }
    for (const c of page.contacts) {
      if (result.contacts.some((x) => x.value === c.value)) continue
      c.company = page.company
      c.source_url = page.url
      result.contacts.push(c)
    }
  }

  try {
    const ctx = await browser.newContext()
    const tab = await ctx.newPage()

    const readPage = async (url, how) => {
      if (!(await robotsAllows(url))) { result.skipped.push({ url, reason: 'robots.txt disallows it' }); return null }
      if (read > 0) await sleep(delay)
      read++
      let resp
      try {
        resp = await tab.goto(url, { waitUntil: 'load', timeout: 30000 })
      } catch (e) {
        const net = /net::ERR_|ECONNREFUSED|ENOTFOUND|NS_ERROR/.test(String(e && e.message))
        result.pages.push({ url, how, error: net ? 'did not load (unreachable, DNS, TLS or refused)' : `did not load (${(e && e.name) || 'Error'})` })
        return null
      }
      const page = await tab.evaluate(EXTRACT_JS)
      page.status = page.status || (resp ? resp.status() : null)
      if (!page.status) { result.pages.push({ url, how, error: 'did not load (unreachable, DNS, TLS or refused)' }); return null }
      result.pages.push({ url: page.url, how, status: page.status, people: page.people.length, contacts: page.contacts.length })
      take(page)
      return page
    }

    while (queue.length && read < maxPages) {
      const url = queue.shift()
      const norm = url.split('#')[0].replace(/\/+$/, '')
      if (visited.has(norm)) continue
      visited.add(norm)
      let page = await readPage(url, starts.includes(url) ? 'start' : 'follow')
      if (!page) continue

      while (nextText && read < maxPages) {
        const at = await tab.evaluate(`(${CLICK_JS})(${JSON.stringify(nextText.toLowerCase())})`)
        if (at.error) { result.pages[result.pages.length - 1].pagination_stopped = at.error.slice(0, 120); break }
        const before = await fingerprint(tab)
        await tab.mouse.click(at.x, at.y)
        await sleep(1)
        try { await tab.waitForLoadState('load', { timeout: 10000 }) } catch { /* a click that does not navigate has no load */ }
        if ((await fingerprint(tab)) === before) { result.pages[result.pages.length - 1].pagination_stopped = 'Next did not change the page'; break }
        read++
        await sleep(delay)
        page = await tab.evaluate(EXTRACT_JS)
        visited.add(page.url.split('#')[0].replace(/\/+$/, ''))
        result.pages.push({ url: page.url, how: 'next', status: page.status, people: page.people.length, contacts: page.contacts.length })
        take(page)
      }

      if (follow.length) {
        for (const l of page.links) {
          let p = ''
          try { p = new URL(l.href).pathname } catch { /* not a url */ }
          const hay = (l.text + ' ' + p).toLowerCase()
          if (follow.some((k) => hay.includes(k)) && !visited.has(l.href.split('#')[0].replace(/\/+$/, ''))) queue.push(l.href)
        }
      }
    }
  } finally {
    await browser.close().catch(() => {})
  }

  const loaded = result.pages.filter((p) => !p.error)
  result.measured = loaded.length > 0
  if (!loaded.length) {
    const reasons = [...new Set([...result.pages.map((p) => p.error), ...result.skipped.map((s) => s.reason)].filter(Boolean))].sort()
    result.error = reasons.join('; ') || 'no page could be read'
  }
  result.counts = {
    pages: loaded.length,
    leads: result.leads.length,
    with_email: result.leads.filter((p) => p.email).length,
    with_phone: result.leads.filter((p) => p.phone).length,
    with_social: result.leads.filter((p) => p.socials && Object.keys(p.socials).length).length,
    company_contacts: result.contacts.length,
  }
  result.ok = result.measured && Boolean(result.leads.length || result.contacts.length)
  emit(result)
}

if (require.main === module && process.argv[2] === '--probe') {
  // exit 0 only when this engine can actually start a browser here (used by the tests' skip gate)
  const pw = loadPlaywright()
  if (!pw) process.exit(1)
  pw.chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN || undefined })
    .then((b) => b.close()).then(() => process.exit(0), () => process.exit(1))
} else if (require.main === module) {
  main().catch((e) => emit({ ok: false, measured: false, engine: 'playwright', error: `scrape crashed: ${String(e && e.message || e).slice(0, 300)}` }))
}

module.exports = { parseRobots }
