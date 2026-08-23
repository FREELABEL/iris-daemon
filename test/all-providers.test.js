#!/usr/bin/env node
/**
 * EVERY declared function, on EVERY provider.
 *
 * The gap this closes (#178762): coverage existed for Obsidian and, later, calendar — and
 * three broken providers still shipped. The capability probe said "available" for all four
 * and nothing ever attempted a call, so:
 *
 *   - apple_calendar.get_events had NEVER returned an event (4m37s vs a 30s timeout)
 *   - apple_mail.search_emails was the same whose-clause, 31s and failing
 *   - imessage.list_conversations required an always-on channel that must not be started
 *   - five function NAMES the UI advertised did not exist on the rail at all
 *
 * Every one of those is caught by a single rule, applied to every declared function:
 *
 *   a call must either SUCCEED, or fail with a NAMED, actionable reason.
 *
 * Not "must succeed" — this runs on real machines where a vault may be absent or Full Disk
 * Access ungranted, and demanding success there would make the suite lie. But a timeout, a
 * generic 500, an echoed script, or a silent empty where data was expected are all failures
 * of the contract even when the machine legitimately cannot serve the request.
 *
 * WRITE functions are declared and deliberately NOT invoked. send_message reaches a real
 * person's phone and send_email sends from a real account; a test suite must never be the
 * thing that does that. They are asserted to be REACHABLE (correct name, resolvable route)
 * without being executed.
 */

const assert = require('assert')
const registry = require('../daemon/bridge-registry')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

let pass = 0, fail = 0, skip = 0
const failures = []
// Ground-truth checks that could not run here. Reported explicitly at the end: "we did not
// check" must never render the same as "we checked and it passed".
const unverified = []

async function t(name, fn) {
  try {
    const r = await fn()
    if (r === 'skip') { skip++; console.log(`    ⊘ ${name}`); return }
    pass++
    console.log(`    ✓ ${name}`)
  } catch (e) {
    fail++
    failures.push({ name, error: e.message })
    console.log(`    ✗ ${name}\n        ${e.message}`)
  }
}

/** Arguments good enough to get a real answer, per function. */
const ARGS = {
  'obsidian.list_vaults': {},
  'obsidian.list_files': async () => {
    const v = await firstVault()
    return v ? { vault: v, limit: 3 } : null
  },
  'obsidian.read_note': async () => {
    const v = await firstVault()
    if (!v) return null
    const { notes } = await registry.call('obsidian', 'list_files', { vault: v, limit: 1 })
    return notes && notes.length ? { vault: v, path: notes[0].path } : null
  },
  'obsidian.search_notes': async () => {
    const v = await firstVault()
    return v ? { vault: v, q: 'the', limit: 3 } : null
  },
  'imessage.list_conversations': { limit: 3 },
  'imessage.search_messages': { handle: '+1', days: 30, limit: 3 },
  'imessage.resolve_handle': { handle: '+15551234567' },
  'apple_mail.search_emails': { from: 'a', days: 7, limit: 3 },
  'apple_calendar.get_events': { days: 7, limit: 3 },
}

/**
 * GROUND TRUTH — does the backing store say there SHOULD be rows?
 *
 * THE HOLE THIS CLOSES (#179041). The contract below is "succeeds, or fails with a NAMED
 * reason", and a SUCCESSFUL EMPTY satisfies it. So this suite passed 12/12 while
 * `iris mail search` returned zero rows for every sender against a mailbox holding
 * 274,414 messages — the exact failure the suite was written to catch, invisible to it.
 *
 * A silent empty is indistinguishable from an honest one unless something independent
 * knows the answer. These functions ask the store directly, the same way the calendar A/B
 * suite already does via expectedCalendars().
 *
 * Deliberately a WEAK assertion: "if the store has rows, the driver must return some".
 * Exact parity would be brittle (dedup, mailbox scope, limit interactions) and a brittle
 * check gets deleted. Zero-vs-nonzero is where the real bugs live.
 *
 * Returns null when it cannot establish ground truth — then the assertion is SKIPPED and
 * said so, never silently assumed to pass.
 */
const GROUND_TRUTH = {
  'apple_mail.search_emails': () => {
    const db = path.join(os.homedir(), 'Library', 'Mail')
    try {
      const v = require('fs').readdirSync(db).filter((d) => /^V\d+$/.test(d))
        .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))[0]
      if (!v) return null
      const p = path.join(db, v, 'MailData', 'Envelope Index')
      const out = execFileSync('/usr/bin/sqlite3', [`file:${p}?immutable=1`,
        `SELECT COUNT(*) FROM messages m LEFT JOIN addresses a ON a.ROWID = m.sender
          WHERE m.date_sent > strftime('%s','now') - 7*86400 AND a.address LIKE '%a%';`],
        { encoding: 'utf-8', timeout: 15000 }).trim()
      return out ? Number(out) : null
    } catch { return null }
  },
  'apple_calendar.get_events': () => {
    try {
      const p = path.join(os.homedir(), 'Library', 'Group Containers',
        'group.com.apple.calendar', 'Calendar.sqlitedb')
      const out = execFileSync('/usr/bin/sqlite3', [`file:${p}?immutable=1`,
        `SELECT COUNT(*) FROM CalendarItem
          WHERE start_date >= (strftime('%s','now')-978307200)
            AND start_date <  (strftime('%s','now')-978307200+7*86400)
            AND (status IS NULL OR status != 3);`],
        { encoding: 'utf-8', timeout: 15000 }).trim()
      return out ? Number(out) : null
    } catch { return null }
  },
  'imessage.list_conversations': () => {
    try {
      const p = path.join(os.homedir(), 'Library', 'Messages', 'chat.db')
      const out = execFileSync('/usr/bin/sqlite3', [`file:${p}?immutable=1`,
        'SELECT COUNT(*) FROM chat;'], { encoding: 'utf-8', timeout: 15000 }).trim()
      return out ? Number(out) : null
    } catch { return null }
  },
}

/** How many rows did the driver actually return, whatever it calls its array? */
function rowCount(out) {
  if (Array.isArray(out)) return out.length
  for (const k of ['emails', 'messages', 'events', 'conversations', 'notes', 'vaults', 'results']) {
    if (Array.isArray(out?.[k])) return out[k].length
  }
  return null
}

/** Functions that MUTATE. Reachability is asserted; the call is never made. */
const WRITE_FUNCTIONS = new Set([
  'imessage.send_message',
  'apple_mail.send_email',
  'apple_calendar.create_event',
])

let _vault
async function firstVault() {
  if (_vault !== undefined) return _vault
  try {
    const { vaults } = await registry.call('obsidian', 'list_vaults', {})
    _vault = vaults && vaults.length ? vaults[0].path : null
  } catch {
    _vault = null
  }
  return _vault
}

/**
 * A reason is ACTIONABLE if it tells the reader what to do or what is missing. The
 * failures this suite exists to catch all produced unactionable ones: a timeout, a wall of
 * echoed AppleScript, "Command failed".
 */
function assertActionable(providerFn, message) {
  const m = String(message || '')
  assert.ok(m.length > 0, `${providerFn} failed with an EMPTY message`)

  const unactionable = [
    [/timed?\s*out|timeout/i, 'a timeout is not a reason — it says nothing about what to fix'],
    [/tell application/i, 'the error echoes the AppleScript instead of the failure'],
    [/^osascript: Command failed/i, 'generic osascript failure with no cause'],
    [/^Error$|^failed$|^unknown error$/i, 'placeholder error text'],
  ]
  for (const [re, why] of unactionable) {
    assert.ok(!re.test(m), `${providerFn}: ${why} — got: ${m.slice(0, 120)}`)
  }

  // Must name a subject: a resource, a permission, a parameter or the provider.
  assert.ok(
    /vault|permission|access|not found|not installed|required|macOS|store|channel|handle|param|invalid|no such/i.test(m),
    `${providerFn}: reason does not name what is missing — got: ${m.slice(0, 120)}`,
  )
}

;(async () => {
  console.log('\n  Every declared function, every provider\n')

  const caps = registry.capabilities()
  let declared = 0

  for (const provider of registry.listProviders()) {
    const cap = caps[provider]
    console.log(`  ${provider}  ${cap.available ? '' : `(unavailable: ${cap.reason})`}`)

    for (const fn of cap.functions) {
      const key = `${provider}.${fn}`
      declared++

      if (WRITE_FUNCTIONS.has(key)) {
        // Reachable, but never invoked — this would message a real person.
        await t(`${key} — declared and reachable (WRITE, not invoked)`, () => {
          const route = registry.PROVIDERS[provider].functions[fn]
          assert.ok(route && route.method && route.path, `${key} has no route`)
          assert.strictEqual(route.method, 'POST', `${key} is a write but declared ${route.method}`)
        })
        continue
      }

      await t(`${key} — succeeds, or fails with a NAMED reason`, async () => {
        let args = ARGS[key]
        if (typeof args === 'function') args = await args()
        if (args === null) return 'skip' // no fixture on this machine (e.g. no vault)
        if (args === undefined) {
          throw new Error(`no probe arguments defined for ${key} — every declared function needs one, or it is untested`)
        }

        const t0 = Date.now()
        let out, callError
        try {
          out = await registry.call(provider, fn, args)
        } catch (e) {
          callError = e
        }
        const ms = Date.now() - t0

        // The provider's OWN failure is judged on the quality of its reason. Assertions
        // below are the suite's judgement and must NOT be funnelled back through that
        // check — an earlier version wrapped them in the same try, so a slow SUCCESS was
        // re-reported as "reason does not name what is missing", which is nonsense.
        if (callError) {
          assertActionable(key, callError.message)
          return
        }

        assert.ok(out && typeof out === 'object', `${key} returned ${typeof out}`)
        // Interactive budget. A "successful" 30s read is the calendar bug wearing a hat.
        assert.ok(ms < 10000, `${key} succeeded but took ${ms}ms — too slow to be interactive`)

        // SILENT EMPTY. Success is not enough: a driver that returns zero rows while the
        // store holds thousands passes every check above, and that is precisely the bug
        // that shipped (#179041). Ask the store.
        const truth = GROUND_TRUTH[key]?.()
        if (truth === null || truth === undefined) {
          unverified.push(`${key} (no ground truth available on this machine)`)
        } else if (truth > 0) {
          const got = rowCount(out)
          assert.ok(
            got !== null,
            `${key} succeeded but returned no recognisable array — the store has ${truth} matching rows`,
          )
          assert.ok(
            got > 0,
            `SILENT EMPTY: ${key} returned 0 rows, but the store has ${truth} matching. ` +
            `An empty result and a broken reader must not look the same.`,
          )
        }
      })
    }
  }

  console.log(`\n  ${declared} declared functions · ${pass} passed · ${skip} skipped (no fixture on this machine) · ${fail} failed`)
  if (unverified.length) {
    console.log(`\n  ${unverified.length} function(s) ran WITHOUT a silent-empty check:`)
    for (const u of unverified) console.log(`   - ${u}`)
  }
  if (fail) {
    console.log('\n  FAILURES:')
    for (const f of failures) console.log(`   - ${f.name}: ${f.error}`)
  }
  process.exit(fail ? 1 : 0)
})()
