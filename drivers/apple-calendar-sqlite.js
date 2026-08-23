/**
 * Apple Calendar — direct read of the Calendar store.
 *
 * Same pattern the iMessage driver already uses for chat.db: the app's own SQLite file,
 * opened read-only, instead of driving the GUI app over AppleScript.
 *
 * WHY NOT APPLESCRIPT: `every event of cal whose start date >= X` is O(all events ever) per
 * calendar. Measured on this machine: 72 SECONDS for ONE calendar, ~4m37s across 28,
 * against a 30s execFile timeout — so it never returned an event through any surface
 * (#178745).
 *
 * WHY NOT EVENTKIT: fast (0.15s) and the documented API, but TCC is scoped to the CALLING
 * process. From the daemon it saw 1 of 28 calendars and returned ZERO events while
 * reporting authorizationStatus=4 (fullAccess). Silent, partial, and indistinguishable
 * from an empty calendar — the worst possible failure mode for a data source.
 *
 * COST OF THIS CHOICE, stated plainly: the schema is private to Apple and can change in a
 * macOS release. That is why the contract suite asserts SHAPE (title/start/end/calendar,
 * ordering, windowing) and not just row counts — a schema change should fail loudly in
 * tests rather than quietly return nulls. Reads need Full Disk Access, and a missing or
 * unreadable store throws a NAMED error rather than returning [].
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

/** Core Data stores dates as seconds since 2001-01-01, not the Unix epoch. */
const APPLE_EPOCH_OFFSET = 978307200

const DB_PATH = path.join(
  os.homedir(),
  'Library',
  'Group Containers',
  'group.com.apple.calendar',
  'Calendar.sqlitedb',
)

function storePath() {
  return process.env.IRIS_CALENDAR_DB || DB_PATH
}

/**
 * Run a query read-only.
 *
 * `immutable=1` matters: Calendar.app holds the db open with a WAL, and opening it
 * normally can block or attempt recovery on a live file. immutable promises we will not
 * write and lets sqlite skip locking entirely.
 */
function query(sql) {
  return new Promise((resolve, reject) => {
    const db = storePath()
    if (!fs.existsSync(db)) {
      return reject(new Error(`Calendar store not found at ${path.basename(db)} — is this macOS with Calendar configured?`))
    }
    try {
      fs.accessSync(db, fs.constants.R_OK)
    } catch {
      return reject(new Error('No permission to read the Calendar store — grant Full Disk Access in System Settings › Privacy'))
    }

    execFile(
      '/usr/bin/sqlite3',
      ['-json', `file:${db}?immutable=1`, sql],
      { timeout: 15000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message).trim().split('\n').pop()
          return reject(new Error(`Calendar store query failed: ${msg}`))
        }
        try {
          resolve(stdout.trim() ? JSON.parse(stdout) : [])
        } catch (e) {
          reject(new Error(`Calendar store returned unparseable output: ${e.message}`))
        }
      },
    )
  })
}

/**
 * Upcoming events across ALL calendars.
 *
 * @param {number} days        window size
 * @param {number} limit       max rows
 * @param {number} offsetDays  shift the window (used by tests to reach an empty range)
 */
async function getEvents({ days = 7, limit = 20, offsetDays = 0 } = {}) {
  const d = Math.max(1, Math.min(365, Math.floor(Number(days) || 7)))
  const lim = Math.max(1, Math.min(500, Math.floor(Number(limit) || 20)))
  const off = Math.floor(Number(offsetDays) || 0)

  const startExpr = `(strftime('%s','now') - ${APPLE_EPOCH_OFFSET} + ${off} * 86400)`
  const endExpr = `${startExpr} + ${d} * 86400`

  // status: 0 none, 1 confirmed, 2 tentative, 3 CANCELLED — a cancelled meeting is not on
  // your calendar in any sense the caller cares about, so it must not be returned.
  const rows = await query(`
    SELECT ci.summary        AS title,
           ci.start_date     AS start_date,
           ci.end_date       AS end_date,
           ci.all_day        AS all_day,
           ci.description    AS notes,
           c.title           AS calendar
      FROM CalendarItem ci
      JOIN Calendar c ON c.ROWID = ci.calendar_id
     WHERE ci.start_date >= ${startExpr}
       AND ci.start_date <  ${endExpr}
       AND (ci.status IS NULL OR ci.status != 3)
     ORDER BY ci.start_date ASC
     LIMIT ${lim};
  `)

  return rows.map((r) => ({
    title: r.title == null ? '' : String(r.title),
    start: new Date((Number(r.start_date) + APPLE_EPOCH_OFFSET) * 1000),
    end: new Date((Number(r.end_date ?? r.start_date) + APPLE_EPOCH_OFFSET) * 1000),
    allDay: !!Number(r.all_day),
    notes: r.notes == null ? '' : String(r.notes).slice(0, 500),
    calendar: r.calendar == null ? '(unknown)' : String(r.calendar),
  }))
}

/**
 * Used by the contract suite to prove that an unreachable store produces a NAMED error
 * rather than an empty array. Exists because the EventKit path failed this exact test.
 */
async function probeUnavailable() {
  const saved = process.env.IRIS_CALENDAR_DB
  process.env.IRIS_CALENDAR_DB = '/nonexistent/Calendar.sqlitedb'
  try {
    await getEvents({ days: 1, limit: 1 })
    return { threw: false, message: 'returned normally — an unreachable store looked like an empty calendar' }
  } catch (e) {
    return { threw: true, message: e.message }
  } finally {
    if (saved === undefined) delete process.env.IRIS_CALENDAR_DB
    else process.env.IRIS_CALENDAR_DB = saved
  }
}

module.exports = { getEvents, probeUnavailable, storePath, APPLE_EPOCH_OFFSET }
