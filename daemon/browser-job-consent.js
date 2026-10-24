// Browser jobs announce themselves, can wait for a yes, and never run from a stale backlog.
//
// On 2026-10-23 the cloud queue held 40 unassigned tasks for user 193: 33 hourly `discover` runs
// going back two days, plus som_batch and inbox_scan runs the stale-node sweep had put back. Nothing
// expires a pending task, so whichever machine heartbeats with a free slot inherits the backlog,
// and on the Mac that arrives as headed Chrome windows nobody asked for and nobody can name.
//
//   IRIS_BROWSER_JOBS=notify   (default on macOS) a notification names each browser job as it starts
//   IRIS_BROWSER_JOBS=ask      a Run / Skip dialog; no answer within IRIS_BROWSER_JOBS_ASK_SECONDS = Skip
//   IRIS_BROWSER_JOBS=off      neither (the default on Linux/Windows nodes)
//   IRIS_BROWSER_TASK_MAX_AGE_MIN=120   a browser job older than this is expired, not run (0 = never)

const LABELS = {
  som_batch: 'SOM outreach',
  som: 'SOM',
  inbox_scan: 'Inbox check',
  enrich_batch: 'Lead enrichment',
  venue_enrich: 'Venue enrichment',
  discover: 'Discover feed import',
  custom_playwright: 'Browser script',
  browser_agent: 'Browser agent',
  browser_use: 'Browser agent'
}

function consentMode (env = process.env, platform = process.platform) {
  const v = String(env.IRIS_BROWSER_JOBS || '').toLowerCase()
  if (['notify', 'ask', 'off'].includes(v)) return v
  return platform === 'darwin' ? 'notify' : 'off'
}

function maxAgeMinutes (env = process.env) {
  const n = parseInt(env.IRIS_BROWSER_TASK_MAX_AGE_MIN ?? '120', 10)
  return Number.isFinite(n) && n >= 0 ? n : 120
}

// Minutes the task has been waiting, or null when the cloud did not say when it was made.
function ageMinutes (task, now = Date.now()) {
  const t = Date.parse(task.created_at || '')
  return Number.isFinite(t) ? Math.max(0, (now - t) / 60000) : null
}

function isStale (task, now = Date.now(), maxAge = maxAgeMinutes()) {
  if (!maxAge) return false
  const age = ageMinutes(task, now)
  return age !== null && age > maxAge
}

// Where the job came from, in words a person recognises.
function sourceOf (task) {
  if (task._source === 'mesh') return 'another of your machines'
  if (task.title === 'hive_task_dispatch' || task.config?.scheduled) return 'a cloud schedule'
  if (task.config?.chained_from) return 'a job that just finished'
  return 'the cloud'
}

function describeJob (task, now = Date.now()) {
  const label = LABELS[task.type] || task.type
  const args = String(task.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  const age = ageMinutes(task, now)
  const waited = age !== null && age >= 2 ? `, queued ${age < 90 ? `${Math.round(age)} min` : `${Math.round(age / 60)} h`} ago` : ''
  return {
    title: `IRIS · ${label}`,
    message: `${args || 'no arguments'} — from ${sourceOf(task)}${waited}`
  }
}

// AppleScript string literal: backslashes and quotes escaped, no newlines.
function appleQuote (s) {
  return '"' + String(s).replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

function dialogScript ({ title, message }, timeoutSec) {
  return `display dialog ${appleQuote(message + '\n\nRun it on this Mac now?')} with title ${appleQuote(title)} ` +
    `buttons {"Skip", "Run"} default button "Run" cancel button "Skip" giving up after ${timeoutSec}`
}

// osascript prints `button returned:Run, gave up:false`; Skip (the cancel button) exits non-zero.
function parseDialog (stdout) {
  const s = String(stdout || '')
  if (/gave up:true/.test(s)) return 'timeout'
  return /button returned:Run/.test(s) ? 'run' : 'skip'
}

// Ask on this Mac. Async on purpose: the daemon's event loop keeps heartbeating while the dialog waits.
function askToRun (job, timeoutSec, execFile = require('child_process').execFile) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', dialogScript(job, timeoutSec)], { timeout: (timeoutSec + 10) * 1000 }, (err, stdout) => {
      resolve(err ? 'skip' : parseDialog(stdout))
    })
  })
}

module.exports = { consentMode, maxAgeMinutes, ageMinutes, isStale, sourceOf, describeJob, dialogScript, parseDialog, askToRun, LABELS }
