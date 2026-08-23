#!/usr/bin/env node
/**
 * Local data sources — implementation matrix across every provider.
 *
 * Generalises the calendar A/B (test/apple-calendar.matrix.js) to Mail and iMessage, which
 * turned out to have the SAME pathology: an AppleScript `whose` clause, or a dependency on
 * a long-running GUI/channel process, where the app's own SQLite store answers the same
 * question in milliseconds.
 *
 * Obsidian is included as the CONTROL. It is already the fastest option available, so the
 * honest result there is "change nothing" — and a matrix that can only ever recommend a
 * rewrite is not measuring, it is rationalising.
 */

const { execFile } = require('child_process')

const TOK = (() => {
  try { return require('fs').readFileSync(require('path').join(require('os').homedir(), '.iris', 'bridge-token'), 'utf-8').trim() } catch { return '' }
})()

const httpGet = (p) => new Promise((resolve) => {
  const t0 = Date.now()
  execFile('/usr/bin/curl', ['-s', '--max-time', '120', '-H', `x-bridge-key: ${TOK}`, `http://127.0.0.1:3200${p}`],
    { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      const ms = Date.now() - t0
      let body = null
      try { body = JSON.parse(stdout) } catch {}
      resolve({ ms, body, ok: !!body && !body.error })
    })
})

const CASES = [
  {
    layer: 'Calendar',
    a: { label: 'AppleScript whose-clause', knownMs: 277000, note: 'measured: 72s per calendar, 4m37s for 28 — never returned an event' },
    b: { label: 'Calendar.sqlitedb', run: async () => { const d = require('../drivers/apple-calendar-sqlite'); const t = Date.now(); const r = await d.getEvents({ days: 7, limit: 20 }); return { ms: Date.now() - t, n: r.length, probe: await d.probeUnavailable() } } },
  },
  {
    layer: 'Apple Mail',
    a: { label: 'AppleScript whose-clause', run: async () => { const r = await httpGet('/api/mail/search?from=twitch&days=14&limit=5'); return { ms: r.ms, n: r.ok ? (r.body.count ?? 0) : null, failed: !r.ok } } },
    b: { label: 'Envelope Index (sqlite)', run: async () => { const d = require('../drivers/apple-mail-store'); const t = Date.now(); const r = await d.searchEmails({ from: 'twitch', days: 14, limit: 5 }); return { ms: Date.now() - t, n: r.length, probe: await d.probeUnavailable() } } },
  },
  {
    layer: 'iMessage',
    a: { label: 'live channel (in-memory map)', knownMs: null, note: 'requires the always-on channel that auto-replies to real contacts (#137256) — a READ coupled to a dangerous WRITE process' },
    b: { label: 'chat.db (sqlite)', run: async () => { const d = require('../drivers/imessage-store'); const t = Date.now(); const r = await d.listConversations({ limit: 20 }); return { ms: Date.now() - t, n: r.length, probe: await d.probeUnavailable() } } },
  },
  {
    layer: 'Obsidian  (control)',
    a: { label: 'mdfind / ripgrep / grep', knownMs: 35, note: 'best alternative measured — 35ms grep, 44-750ms rg, 130-196ms mdfind' },
    b: { label: 'readFileSync (current)', run: async () => { const d = require('../drivers/obsidian'); const t = Date.now(); const r = d.searchNotes('/Users/mayoalexander/Documents/Obsidian Vault', 'IRIS', { limit: 25, includeBody: true }); return { ms: Date.now() - t, n: r.length, probe: { threw: true, message: 'throws Path escapes the vault / Not an Obsidian vault' } } } },
  },
]

;(async () => {
  console.log('\n  Local data sources — A/B matrix   (measured on this machine)\n')
  console.log(`  ${'layer'.padEnd(20)}${'A (current/alt)'.padEnd(30)}${'A time'.padStart(9)}   ${'B (store read)'.padEnd(26)}${'B time'.padStart(8)}  ${'speedup'.padStart(9)}`)
  console.log('  ' + '─'.repeat(108))

  const verdicts = []
  for (const c of CASES) {
    const aRes = c.a.run ? await c.a.run() : { ms: c.a.knownMs, n: null }
    const bRes = await c.b.run()
    const fmt = (ms) => ms == null ? '—' : ms >= 10000 ? `${(ms / 1000).toFixed(0)}s` : `${ms}ms`
    const speed = (aRes.ms && bRes.ms) ? `${(aRes.ms / bRes.ms).toFixed(0)}x` : '—'
    console.log(`  ${c.layer.padEnd(20)}${c.a.label.padEnd(30)}${fmt(aRes.ms).padStart(9)}   ${c.b.label.padEnd(26)}${fmt(bRes.ms).padStart(8)}  ${speed.padStart(9)}`)
    if (c.a.note) console.log(`  ${''.padEnd(20)}${c.a.note}`)
    verdicts.push({ layer: c.layer, aMs: aRes.ms, bMs: bRes.ms, n: bRes.n, honest: bRes.probe?.threw, aFailed: aRes.failed })
  }

  console.log('\n  Verdicts\n')
  for (const v of verdicts) {
    const control = v.layer.includes('control')
    let verdict
    if (control) verdict = v.bMs <= (v.aMs ?? Infinity) ? 'KEEP CURRENT — already fastest, a rewrite would be slower' : 'switch'
    else if (v.aMs == null) verdict = 'SWITCH — A is not merely slow, it is unsafe/unavailable'
    else if (v.bMs && v.aMs / v.bMs > 5) verdict = `SWITCH — ${(v.aMs / v.bMs).toFixed(0)}x faster${v.aFailed ? ', and A currently FAILS outright' : ''}`
    else verdict = 'marginal — not worth the schema risk'
    console.log(`   ${v.layer.padEnd(22)} ${verdict}`)
    console.log(`   ${''.padEnd(22)} B returned ${v.n} rows · fails honestly: ${v.honest ? 'yes' : 'NO'}`)
  }
  console.log()
})()
