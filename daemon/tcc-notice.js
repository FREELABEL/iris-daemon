/**
 * macOS privacy (TCC) denials — said ONCE, and said correctly.
 *
 * Two defects, one cause: nobody owned this message, so every caller repeated it and every
 * caller repeated the same wrong advice (#184935).
 *
 * 1. VOLUME. The daemon is POLLED. `[mail/search]`, `[calendar/events]` and
 *    `[imessage/search]` each logged an identical denial on every cycle: 172 lines across 4
 *    call sites in the current stderr log, 168 of which said nothing the first one did not.
 *    (The bug report said those lines were most of the 3.4MB log; measured, they are 19KB of
 *    it — the redundancy is real, the volume claim was not.) The HTTP response still carries
 *    the message every time, because a caller needs its own answer; only the LOG is deduped,
 *    once per process per store. A log's job is to record that a thing happened, not to count
 *    how many times it was asked about.
 *
 * 2. THE ADVICE WAS WRONG IN THE WAY THAT COSTS A DAY. "Grant Full Disk Access to
 *    iris-daemon" reads as "add the app you launch it from", so people add Terminal.app —
 *    and nothing changes. The daemon is started by LAUNCHD (io.heyiris.daemon →
 *    iris-daemon-wrapper.sh → `exec node …/daemon.js`), so the process performing the read
 *    is the node binary launchd spawned, and TCC grants are per-executable. Terminal's grant
 *    covers what Terminal started, which is not this. The fix text now names the exact
 *    binary — `process.execPath`, which IS the reader — and says the restart is mandatory,
 *    because TCC is resolved at process start and a running daemon keeps its old answer.
 */

/** Kept short: this string also travels in an HTTP error body. */
const TCC_SHORT =
  "the iris daemon has no Full Disk Access (the DAEMON's own grant, not your terminal's)"

/** The message drivers reject with. Keeps the "No permission to read" prefix that the doctor greps for. */
function tccDenialMessage(store) {
  return `No permission to read ${store} — ${TCC_SHORT}`
}

/**
 * One actionable line, for error text that has nowhere to put nine.
 * Names the binary and rules out the wrong fix in the same breath — those are the two things
 * the old "grant Full Disk Access to the daemon process" left the reader to guess.
 */
function tccFixOneLine() {
  return (
    `add ${process.execPath} to System Settings › Privacy & Security › Full Disk Access ` +
    `(NOT Terminal — launchd starts the daemon, and TCC grants are per-executable), ` +
    `then run: iris-daemon restart`
  )
}

/**
 * The actionable instructions, emitted to the log once per PROCESS rather than inlined into
 * every rejection. Multi-line on purpose: a one-line hint is what produced the wrong fix.
 */
function tccGuidance() {
  return [
    'HOW TO FIX — granting Full Disk Access to Terminal.app does NOT work. launchd starts',
    'this daemon, not your terminal, and TCC grants are per-executable.',
    '  1. Open System Settings › Privacy & Security › Full Disk Access',
    '  2. Click +, press ⇧⌘G, and paste the binary this daemon is running:',
    `       ${process.execPath}`,
    '  3. Click Open and leave the toggle ON.',
    '  4. Run: iris-daemon restart',
    '     (mandatory — TCC is resolved at process start, so a running daemon keeps the',
    '      answer it booted with and will look unfixed.)',
  ]
}

/** Does this error look like a refused grant, as opposed to a missing file or a bad query? */
function isTccDenial(err) {
  const m = String((err && err.message) || err || '')
  return /No permission to read|Full Disk Access|Operation not permitted|authorization denied/i.test(m)
}

/**
 * Per-process, per-store. Keyed by store rather than by call site, because "Mail is
 * unreadable" is one fact whether /api/mail/search or a scheduled sweep discovered it.
 */
const announced = new Set()

/**
 * The instructions are the same for every store, so they print ONCE per process — not once
 * per store. Keying them per store was the first cut here and it tripled a ten-line block
 * for no new information, which is a smaller version of the bug being fixed.
 */
let guidancePrinted = false

/**
 * Log a caller's error, collapsing repeat TCC denials.
 *
 * @returns {boolean} true if anything was written — so a caller can tell "suppressed" from
 *   "logged", instead of assuming silence means nothing went wrong.
 */
function logDriverError(tag, err, { store } = {}) {
  const msg = String((err && err.message) || err || 'unknown error')
  if (!isTccDenial(err)) {
    console.error(`[${tag}] ${msg}`)
    return true
  }
  const key = store || tag
  if (announced.has(key)) return false
  announced.add(key)
  console.error(`[tcc] ${msg}`)
  console.error(`[tcc] Further denials for ${key} will not be logged by this process.`)
  if (!guidancePrinted) {
    guidancePrinted = true
    for (const line of tccGuidance()) console.error(`[tcc] ${line}`)
  }
  return true
}

/** Tests only — the guard is per-process by design. */
function _resetAnnounced() {
  announced.clear()
  guidancePrinted = false
}

module.exports = { TCC_SHORT, tccDenialMessage, tccFixOneLine, tccGuidance, isTccDenial, logDriverError, _resetAnnounced }
