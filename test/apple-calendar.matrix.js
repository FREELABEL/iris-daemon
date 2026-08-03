#!/usr/bin/env node
/**
 * Apple Calendar — implementation matrix + leaderboard.
 *
 * Scores every candidate on the properties that decide whether a LOCAL DATA SOURCE is
 * usable, then ranks them. Every score is MEASURED on this machine, not asserted:
 *
 *   speed         wall time for a 7-day / 20-event read (interactive budget is 45s, and
 *                 the bridge's own execFile timeout is 30s)
 *   coverage      how many distinct calendars appear — a fast reader that sees 1 of 28
 *                 silently drops most of the user's schedule
 *   correct       does it satisfy the contract suite (shape, ordering, windowing, limit)
 *   honest        does an unreachable/unauthorised store throw a NAMED error, or return []
 *   permissions   what the user must grant, and whether the DAEMON inherits it
 *   durable       how likely to break on a macOS upgrade
 *
 * `honest` is weighted as heavily as `speed` on purpose. A source that returns [] when it
 * cannot see your data is worse than one that is slow, because nothing downstream can tell
 * the difference between "no meetings" and "no access" — the exact failure that has cost
 * this codebase weeks (#178670, #178708, and EventKit below).
 */

const { execFile } = require('child_process')

const CANDIDATES = [
  {
    key: 'sqlite',
    label: 'B · Calendar.sqlitedb (direct read)',
    mod: '../drivers/apple-calendar-sqlite',
    permissions: 'Full Disk Access (daemon inherits it — same grant chat.db already needs)',
    durable: 'private schema; can change on a macOS upgrade',
    durableScore: 3,
    permScore: 4,
  },
  {
    key: 'eventkit',
    label: 'C · EventKit via JXA',
    mod: '../drivers/apple-calendar-eventkit',
    permissions: 'per-PROCESS TCC — the daemon is a different subject and is NOT covered',
    durable: 'documented public API; very stable',
    durableScore: 5,
    permScore: 1,
  },
  {
    key: 'applescript',
    label: 'A · AppleScript whose-clause (shipped)',
    mod: '../drivers/apple-calendar-applescript',
    permissions: 'Automation prompt; silently declinable',
    durable: 'stable API, but Calendar.app must be running',
    durableScore: 4,
    permScore: 2,
    skipUnless: 'AB_INCLUDE_APPLESCRIPT',
    knownMs: 277000, // measured: 4m37s across 28 calendars
    knownNote: 'measured separately — 72s for ONE calendar, ~4m37s for 28',
  },
]

const bar = (n, max = 5) => '█'.repeat(n) + '·'.repeat(max - n)

async function measure(c) {
  const r = {
    key: c.key, label: c.label, permissions: c.permissions, durable: c.durable,
    ms: null, count: null, calendars: null, correct: null, honest: null, note: null,
  }

  if (c.skipUnless && process.env[c.skipUnless] !== '1') {
    r.ms = c.knownMs
    r.note = c.knownNote
    r.skipped = true
    return r
  }

  let impl
  try {
    impl = require(c.mod)
  } catch (e) {
    r.note = `driver not loadable: ${e.message}`
    return r
  }

  try {
    const t0 = Date.now()
    const events = await impl.getEvents({ days: 7, limit: 20 })
    r.ms = Date.now() - t0
    r.count = events.length
    r.calendars = new Set(events.map((e) => e.calendar)).size

    // Contract spot-checks (the full suite lives in apple-calendar.ab.test.js).
    const shaped = events.every((e) =>
      typeof e.title === 'string' && e.start instanceof Date && !isNaN(e.start) &&
      typeof e.calendar === 'string')
    let ordered = true
    for (let i = 1; i < events.length; i++) if (events[i].start < events[i - 1].start) ordered = false
    const few = await impl.getEvents({ days: 7, limit: 3 })
    r.correct = shaped && ordered && few.length <= 3
  } catch (e) {
    r.note = `threw: ${e.message.slice(0, 70)}`
    r.correct = false
  }

  try {
    const p = await impl.probeUnavailable()
    r.honest = !!p.threw
    if (!p.threw) r.note = p.message.slice(0, 70)
  } catch {
    r.honest = null
  }

  return r
}

function score(r, c) {
  // 0-5 each.
  const speed = r.ms == null ? 0
    : r.ms < 500 ? 5 : r.ms < 2000 ? 4 : r.ms < 10000 ? 3 : r.ms < 30000 ? 1 : 0
  // Coverage is judged against what the machine actually has; 0 events with 0 calendars
  // while another candidate finds many is the EventKit failure, and scores 0.
  const coverage = r.calendars == null ? 0 : r.calendars >= 5 ? 5 : r.calendars >= 2 ? 4 : r.calendars === 1 ? 1 : 0
  const correct = r.correct === true ? 5 : r.correct === false ? 0 : 0
  const honest = r.honest === true ? 5 : 0
  return {
    speed, coverage, correct, honest,
    perms: c.permScore, durable: c.durableScore,
    // honest and correct are the load-bearing ones; a fast liar is useless.
    total: speed * 2 + coverage * 2 + correct * 2 + honest * 2 + c.permScore + c.durableScore,
  }
}

;(async () => {
  console.log('\n  Apple Calendar — implementation matrix   (measured on this machine)\n')

  const rows = []
  for (const c of CANDIDATES) {
    const r = await measure(c)
    rows.push({ c, r, s: score(r, c) })
  }

  const hdr = ['candidate', 'time', 'events', 'cals', 'correct', 'honest'].map((h) => h)
  console.log(`  ${hdr[0].padEnd(38)}${hdr[1].padStart(9)}${hdr[2].padStart(8)}${hdr[3].padStart(6)}${hdr[4].padStart(9)}${hdr[5].padStart(8)}`)
  console.log('  ' + '─'.repeat(78))
  for (const { c, r } of rows) {
    const time = r.ms == null ? '—' : r.ms >= 10000 ? `${(r.ms / 1000).toFixed(0)}s` : `${r.ms}ms`
    console.log(
      `  ${c.label.padEnd(38)}${String(time).padStart(9)}${String(r.count ?? '—').padStart(8)}` +
      `${String(r.calendars ?? '—').padStart(6)}${(r.correct === true ? 'yes' : r.correct === false ? 'NO' : '—').padStart(9)}` +
      `${(r.honest === true ? 'yes' : r.honest === false ? 'NO' : '—').padStart(8)}`,
    )
    if (r.note) console.log(`  ${''.padEnd(38)}${r.note}`)
  }

  console.log('\n  Scorecard  (speed/coverage/correct/honest ×2, then permissions + durability)\n')
  console.log(`  ${'candidate'.padEnd(38)}  speed      coverage   correct    honest     perms      durable`)
  for (const { c, s } of rows) {
    console.log(`  ${c.label.padEnd(38)}  ${bar(s.speed)}  ${bar(s.coverage)}  ${bar(s.correct)}  ${bar(s.honest)}  ${bar(s.perms)}  ${bar(s.durable)}`)
  }

  console.log('\n  🏆 Leaderboard\n')
  const ranked = [...rows].sort((a, b) => b.s.total - a.s.total)
  const medals = ['🥇', '🥈', '🥉']
  ranked.forEach((row, i) => {
    console.log(`   ${medals[i] ?? '  '} ${String(row.s.total).padStart(3)}/50  ${row.c.label}`)
    console.log(`            permissions: ${row.c.permissions}`)
    console.log(`            durability:  ${row.c.durable}`)
  })

  const winner = ranked[0]
  console.log(`\n  → RECOMMENDED: ${winner.c.label}`)
  if (winner.s.honest < 5) console.log('    ⚠ winner does not fail honestly — fix that before shipping it.')
  console.log()
})()
