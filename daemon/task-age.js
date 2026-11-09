// No task runs from a stale backlog — not just browser jobs (#192109).
//
// On 2026-11-01 at 22:42 UTC an old cloud backlog was released and a weeks-old
// `railway redeploy -e production -s fl-api` ran and redeployed production. The only age guard was
// browser-job-consent.js, which checks browser jobs alone; a shell task had no limit at all.
//
//   not_after (the task's own deadline, #187568)  decides when the task carries one: past it is
//                                                 expired, before it runs however old it is
//   IRIS_TASK_MAX_AGE_MIN=1440   otherwise a task older than this is expired, not run (0 = never)
//   IRIS_BROWSER_TASK_MAX_AGE_MIN  browser jobs keep their stricter limit in browser-job-consent.js
//
// The clock is created_at. dispatched_at is not: releasing a backlog dispatches it NOW, and a
// retry or failover clears it, so it says how long the last hop took, not how long the order
// waited. Approving a held script run creates a NEW task, so an approval resets created_at.
// A fan-out join (metadata._join) is made when its children are, and waits for them by design;
// nothing tells this machine when it was released, so only its deadline applies to it.

const { deadlineMs } = require('./delivery-contract')
const { ageMinutes } = require('./browser-job-consent')

function maxAgeMinutes (env = process.env) {
  const n = parseInt(env.IRIS_TASK_MAX_AGE_MIN ?? '1440', 10)
  return Number.isFinite(n) && n >= 0 ? n : 1440
}

// Why this task must not run now, or null when it may. `browser` leaves the age to the browser check.
function expiry (task, { now = Date.now(), maxAge = maxAgeMinutes(), browser = false } = {}) {
  const deadline = deadlineMs(task)
  if (deadline !== null) {
    return now > deadline
      ? { reason: `Past its deadline (${task.not_after}) by this machine's clock when it was about to start, so it was not run.` }
      : null
  }
  if (browser || !maxAge || task?.metadata?._join) return null
  const age = ageMinutes(task || {}, now)
  if (age === null || age <= maxAge) return null
  return {
    age,
    reason: `Queued ${waited(age)} before it was about to start here (limit ${maxAge} min, IRIS_TASK_MAX_AGE_MIN). ` +
      'A task that old is backlog, not something to run now; send it again if it is still wanted.'
  }
}

function waited (min) {
  if (min < 90) return `${Math.round(min)} min`
  if (min < 48 * 60) return `${Math.round(min / 60)} h`
  return `${Math.round(min / 1440)} days`
}

module.exports = { maxAgeMinutes, expiry, waited }
