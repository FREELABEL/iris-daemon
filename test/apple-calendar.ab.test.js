#!/usr/bin/env node
/**
 * Apple Calendar — A/B contract suite.
 *
 * ONE set of contract tests, run against BOTH implementations:
 *
 *   A  applescript  the shipped one. `every event of cal whose start date >= X` —
 *                   MEASURED at 72s for a SINGLE calendar, 4m37s across 28, against a
 *                   30s execFile timeout. It has therefore never returned an event
 *                   through any surface (#178745).
 *
 *   B  sqlite       reads ~/Library/Group Containers/group.com.apple.calendar/
 *                   Calendar.sqlitedb directly — the same pattern the iMessage driver
 *                   already uses for chat.db. MEASURED at 0.036s for the same window.
 *
 * Written BEFORE B existed, so the contract is defined by what a caller needs rather
 * than by what the implementation happens to produce.
 *
 * A third option was measured and REJECTED — EventKit via JXA. It is fast (0.15s) and
 * uses the documented API, but under this process it saw 1 of 28 calendars and returned
 * ZERO events while reporting authorizationStatus=4 (fullAccess). It fails SILENTLY and
 * partially, which is the single worst property a data source can have here: an empty
 * calendar and an unauthorised one look identical. TCC is scoped to the calling process,
 * and the daemon is a different subject from the shell that granted access.
 */

const assert = require('assert')

let pass = 0, fail = 0
const failures = []

async function t(name, fn) {
  try {
    await fn()
    pass++
    console.log(`    ✓ ${name}`)
  } catch (e) {
    fail++
    failures.push({ name, error: e.message })
    console.log(`    ✗ ${name}\n        ${e.message}`)
  }
}

/**
 * The contract. Every implementation must satisfy all of it.
 *
 * `budgetMs` is part of the contract, not a nice-to-have: this is an INTERACTIVE data
 * source behind a 45s sync timeout, and the whole reason A is broken is that it ignores
 * the clock. A correct-but-slow answer is a wrong answer here.
 */
async function runContract(label, impl, { budgetMs }) {
  console.log(`\n  ${label}`)

  let events = null
  let elapsed = null

  await t(`returns within the ${budgetMs}ms budget`, async () => {
    const t0 = Date.now()
    events = await impl.getEvents({ days: 7, limit: 20 })
    elapsed = Date.now() - t0
    assert.ok(elapsed < budgetMs, `took ${elapsed}ms (budget ${budgetMs}ms)`)
  })

  if (!Array.isArray(events)) {
    console.log(`    ⚠ no result — remaining contract tests cannot run for ${label}`)
    return { label, elapsed, count: null }
  }

  await t('returns an array of events', () => {
    assert.ok(Array.isArray(events))
  })

  await t('every event has title, start, end and calendar', () => {
    for (const e of events) {
      assert.ok(typeof e.title === 'string', `title: ${JSON.stringify(e)}`)
      assert.ok(e.start instanceof Date && !isNaN(e.start), `start: ${JSON.stringify(e)}`)
      assert.ok(e.end instanceof Date && !isNaN(e.end), `end: ${JSON.stringify(e)}`)
      assert.ok(typeof e.calendar === 'string' && e.calendar.length, `calendar: ${JSON.stringify(e)}`)
    }
  })

  await t('no event starts outside the requested window', () => {
    const now = Date.now()
    const end = now + 7 * 86400000
    for (const e of events) {
      // A day of slack at the lower bound: implementations may anchor to midnight.
      assert.ok(e.start.getTime() >= now - 86400000, `${e.title} starts before the window`)
      assert.ok(e.start.getTime() <= end + 1000, `${e.title} starts after the window`)
    }
  })

  await t('honours limit', async () => {
    const few = await impl.getEvents({ days: 7, limit: 3 })
    assert.ok(few.length <= 3, `got ${few.length}`)
  })

  await t('events are ordered by start time', () => {
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].start >= events[i - 1].start, 'out of order')
    }
  })

  await t('a zero-result window returns [] and does NOT throw', async () => {
    // Ten years out. Empty is a legitimate answer and must not look like a failure.
    const none = await impl.getEvents({ days: 1, limit: 5, offsetDays: 3650 })
    assert.ok(Array.isArray(none), 'expected an array')
  })

  await t('spans MULTIPLE calendars (the 28-calendar case)', () => {
    // A sees one calendar per 72s, so a naive fix that caps calendars would pass timing
    // and silently drop most of the user's schedule. Pin the property that matters.
    const cals = new Set(events.map((e) => e.calendar))
    assert.ok(cals.size >= 1, 'no calendars represented')
    if (events.length >= 5) {
      assert.ok(cals.size >= 2, `only ${cals.size} calendar(s) across ${events.length} events — suspicious`)
    }
  })

  await t('unavailability is a NAMED error, never a silent empty', async () => {
    // The EventKit trap: authorised-looking, zero rows, no error. If the backing store is
    // missing, the caller must be able to tell that apart from "you have no meetings".
    if (typeof impl.probeUnavailable !== 'function') {
      throw new Error('implementation does not expose probeUnavailable — cannot verify')
    }
    const r = await impl.probeUnavailable()
    assert.ok(r && r.threw, 'expected a thrown, named error when the store is unreachable')
    assert.ok(/not found|unavailable|permission|access/i.test(r.message), `unhelpful message: ${r.message}`)
  })

  return { label, elapsed, count: events.length }
}

;(async () => {
  console.log('Apple Calendar — A/B contract suite')

  const results = []

  // ── B: sqlite ──
  const sqliteImpl = require('../drivers/apple-calendar-sqlite')
  results.push(await runContract('B · sqlite (Calendar.sqlitedb)', sqliteImpl, { budgetMs: 5000 }))

  // ── A: applescript ──
  // Run LAST and behind a flag: a full run costs ~4m37s of real CPU and measurably starves
  // every other bridge request while it burns (#178750). Skipping is REPORTED, never silent.
  if (process.env.AB_INCLUDE_APPLESCRIPT === '1') {
    const asImpl = require('../drivers/apple-calendar-applescript')
    results.push(await runContract('A · applescript (shipped)', asImpl, { budgetMs: 30000 }))
  } else {
    console.log('\n  A · applescript (shipped)')
    console.log('    ⚠ SKIPPED — set AB_INCLUDE_APPLESCRIPT=1 to run it.')
    console.log('      Measured separately: 72s for ONE calendar, ~4m37s for 28, against a')
    console.log('      30s timeout. It cannot pass the budget test; running it just burns CPU')
    console.log('      and starves concurrent bridge requests.')
  }

  console.log('\n  ── A/B summary ──')
  for (const r of results) {
    console.log(`    ${r.label.padEnd(34)} ${String(r.elapsed ?? '—').padStart(7)}ms   ${r.count ?? '—'} events`)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) for (const f of failures) console.log(`  - ${f.name}: ${f.error}`)
  process.exit(fail ? 1 : 0)
})()
