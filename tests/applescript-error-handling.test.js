const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Regression guard for bug #177253.
//
// A bare `try` / `end try` wrapped the inbox fetch in /api/mail/search. Any failure
// inside it was discarded, the AppleScript returned an empty string, osascript exited
// 0, and the bridge answered {messages: [], count: 0} — so a hard failure was
// indistinguishable from a genuine zero-match search. /api/calendar/events had the
// same shape per-calendar, which was worse: it dropped one calendar's events while
// others still returned theirs, producing a plausible PARTIAL result.
//
// These are structural assertions on the AppleScript source rather than end-to-end
// tests: reproducing the real failure requires quitting Mail.app / Calendar.app,
// which is not safe to automate in CI. The structure IS what regressed, so guarding
// it is the meaningful check.

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')

// Pull out an AppleScript template literal by a unique anchor inside it.
function scriptContaining (anchor) {
  const idx = SRC.indexOf(anchor)
  assert.notEqual(idx, -1, `anchor not found in index.js: ${anchor}`)
  const start = SRC.lastIndexOf('tell application', idx)
  const end = SRC.indexOf('end tell', idx)
  assert.ok(start !== -1 && end !== -1, `could not bound script around: ${anchor}`)
  return SRC.slice(start, end + 'end tell'.length)
}

describe('AppleScript error handling (bug #177253)', () => {
  describe('/api/mail/search', () => {
    const script = scriptContaining('messages of inbox whose sender contains')

    it('the outer fetch try propagates instead of falling through to an empty result', () => {
      // Inner per-field tries (theDate / theSender / theSubject / theBody) are
      // deliberately tolerant — they set defaults and must NOT fail the request.
      // The one that matters is the outer try around the message fetch: everything
      // between the fetch and `return output` must be able to report a failure.
      const fetchIdx = script.indexOf('messages of inbox whose sender contains')
      const returnIdx = script.indexOf('return output')
      assert.ok(fetchIdx !== -1 && returnIdx > fetchIdx, 'could not locate the fetch → return span')

      const span = script.slice(fetchIdx, returnIdx)
      // Match the outer handler's exact signature. A bare /on error/ would also match
      // the unrelated `on error saveErr` in the attachment-save block and pass even
      // with the bug fully re-introduced (confirmed by mutation testing).
      assert.match(
        span,
        /on error errMsg number errNum/,
        'the outer fetch try has no `on error errMsg number errNum` — a failure will be laundered into "No emails found"'
      )
    })

    it('surfaces failures via the IRIS_MAIL_ERROR sentinel, not an empty string', () => {
      assert.match(script, /on error errMsg number errNum/)
      assert.match(script, /---IRIS_MAIL_ERROR---/)
    })

    it('the JS side throws on the sentinel instead of parsing it as rows', () => {
      assert.match(SRC, /includes\('---IRIS_MAIL_ERROR---'\)/)
      assert.match(SRC, /throw new Error\([^)]*Mail\.app is not running/)
    })

    it('special-cases -609 (Mail.app not running) with an actionable message', () => {
      assert.match(SRC, /-609/)
    })
  })

  describe('/api/calendar/events', () => {
    const script = scriptContaining('every event of cal whose start date')

    it('the per-calendar try has an on-error handler', () => {
      assert.match(
        script,
        /on error errMsg number errNum/,
        'a bare `end try` here silently drops one calendar while others still return events'
      )
    })

    it('emits a marker row for a failed calendar rather than skipping it', () => {
      assert.match(script, /---IRIS_CAL_ERROR---/)
    })

    it('partitions marker rows out of events and reports them as partial', () => {
      assert.match(SRC, /startsWith\('---IRIS_CAL_ERROR---'\)/)
      assert.match(SRC, /failed_calendars/)
      assert.match(SRC, /partial: true/)
    })
  })

  describe('app preflight', () => {
    it('ensureAppRunning polls rather than sleeping a fixed interval', () => {
      // `open -a <App>` returns before the app is scriptable; a fixed sleep is a race.
      assert.match(SRC, /async function ensureAppRunning/)
      assert.match(SRC, /name of processes\) contains/)
    })

    it('guards every AppleScript-backed route', () => {
      for (const app of ['Mail', 'Calendar', 'Messages']) {
        assert.ok(
          SRC.includes(`ensureAppRunning('${app}')`) || (app === 'Mail' && SRC.includes('ensureMailRunning()')),
          `no launch preflight for ${app}.app`
        )
      }
    })

    it('is NOT wired into GET /health', () => {
      // Deliberate: one closed app must not red-light unrelated bridge routes, and
      // the uptime monitor polls /health on a timer — it must not relaunch apps.
      const healthIdx = SRC.indexOf("app.get('/health'")
      assert.notEqual(healthIdx, -1)
      const healthBlock = SRC.slice(healthIdx, healthIdx + 2000)
      assert.doesNotMatch(healthBlock, /ensureAppRunning|ensureMailRunning/)
    })
  })
})
