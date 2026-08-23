/**
 * Apple Calendar via EventKit (JXA) — CANDIDATE C, kept for the A/B matrix.
 *
 * The documented API and genuinely fast, but MEASURED here it saw 1 of 28 calendars and
 * returned zero events while reporting authorizationStatus=4 (fullAccess). TCC is scoped
 * to the calling process, and the daemon is a different subject from the shell that was
 * granted access — so the failure is silent, partial, and identical to an empty calendar.
 *
 * Retained so the matrix can show WHY it was rejected rather than asserting it.
 */

const { execFile } = require('child_process')

const SCRIPT = (days, limit, offsetDays) => `
ObjC.import('EventKit')
const store = $.EKEventStore.alloc.init
const cals = store.calendarsForEntityType($.EKEntityTypeEvent)
const start = $.NSDate.dateWithTimeIntervalSinceNow(${offsetDays} * 86400)
const end = $.NSDate.dateWithTimeIntervalSinceNow((${offsetDays} + ${days}) * 86400)
const pred = store.predicateForEventsWithStartDateEndDateCalendars(start, end, cals)
const evs = store.eventsMatchingPredicate(pred)
const out = []
const n = Math.min(Number(evs.count), ${limit})
for (let i = 0; i < n; i++) {
  const e = evs.objectAtIndex(i)
  out.push({
    title: ObjC.unwrap(e.title) || '',
    start: ObjC.unwrap(e.startDate.description),
    end: ObjC.unwrap(e.endDate.description),
    allDay: !!e.isAllDay,
    calendar: ObjC.unwrap(e.calendar.title) || '',
  })
}
JSON.stringify({ authStatus: Number($.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent)), calendars: Number(cals.count), events: out })
`

function getEvents({ days = 7, limit = 20, offsetDays = 0 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT(days, limit, offsetDays)],
      { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`EventKit failed: ${String(stderr || err.message).slice(-200)}`))
        let d
        try { d = JSON.parse(stdout) } catch (e) { return reject(new Error('EventKit returned unparseable output')) }
        resolve((d.events || []).map((e) => ({
          title: e.title, start: new Date(e.start), end: new Date(e.end),
          allDay: e.allDay, notes: '', calendar: e.calendar || '(unknown)',
        })))
      })
  })
}

/** EventKit FAILS this: an unauthorised store returns [] with no error. */
async function probeUnavailable() {
  try {
    await getEvents({ days: 1, limit: 1, offsetDays: 3650 })
    return { threw: false, message: 'returned [] — an unauthorised/empty store are indistinguishable' }
  } catch (e) {
    return { threw: true, message: e.message }
  }
}

module.exports = { getEvents, probeUnavailable }
