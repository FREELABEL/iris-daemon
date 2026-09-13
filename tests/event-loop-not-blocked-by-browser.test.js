'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { execSync, spawn } = require('child_process')

/**
 * A HEADED BROWSER MUST NOT RUN ON THE DAEMON'S EVENT LOOP (#182371).
 *
 * MEASURED on the live node, 2026-09-13. The daemon's own watchdog had killed it 54 times:
 *
 *   [watchdog] MAIN THREAD BLOCKED for  60s — Killing pid 98060
 *   [watchdog] MAIN THREAD BLOCKED for  87s — Killing pid 32423
 *   [watchdog] MAIN THREAD BLOCKED for 264s — Killing pid  4304
 *
 * The block durations start at exactly 60s, which is the `--timeout 60000` on
 *
 *   const cmd = `npx playwright test ${spec} --headed --timeout ${timeout}`
 *   execSync(cmd, { stdio: 'inherit', ... })
 *
 * execSync holds the event loop for the whole child process, so while a browser was up the
 * daemon answered NOTHING — no /health, no task dispatch, no heartbeat. The watchdog was not
 * the fault; it was the only part that behaved correctly.
 *
 * Two assertions, because a source grep can pass for the wrong reason:
 *  1. the MECHANISM — prove execSync blocks and detached spawn does not, by measuring loop lag
 *  2. the CALL SITES — no execSync may launch a browser
 */

const ROOT = path.join(__dirname, '..')

/** Measure worst event-loop stall while `work` runs. */
async function loopLagDuring(work) {
  let worst = 0
  let last = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    worst = Math.max(worst, now - last - 20)
    last = now
  }, 20)
  try {
    await work()
    // YIELD BEFORE CLEARING. After execSync returns, this async function resumes on the
    // MICROTASK queue and would reach clearInterval before the delayed interval callback — a
    // macrotask — ever runs. The stall happened and went unobserved; the first version of this
    // test reported 0ms while the loop had been frozen for 1.5s. Let the timer fire once.
    await new Promise((r) => setTimeout(r, 60))
  } finally {
    clearInterval(timer)
  }
  return worst
}

test('MECHANISM: execSync blocks the event loop; detached spawn does not', async () => {
  const SLEEP = 1.5

  const blocked = await loopLagDuring(async () => {
    execSync(`sleep ${SLEEP}`)
  })

  const notBlocked = await loopLagDuring(async () => {
    const p = spawn('sleep', [String(SLEEP)], { stdio: 'ignore', detached: true })
    p.unref()
    // give the loop the same wall-clock window to be measured over
    await new Promise((r) => setTimeout(r, SLEEP * 1000))
  })

  // execSync should stall the loop for ~the child's lifetime; detached spawn for ~nothing.
  assert.ok(
    blocked > 1000,
    `execSync should have stalled the loop >1000ms, measured ${blocked}ms — if this fails the premise of the fix is wrong`,
  )
  assert.ok(
    notBlocked < 250,
    `detached spawn should barely stall the loop (<250ms), measured ${notBlocked}ms`,
  )
})

/**
 * SCOPE, deliberately narrow. Only code that runs ON the daemon's event loop is a defect.
 *
 * Measured 2026-09-13: scripts/save-session.js, som/som-all.js and som/yt-feed.js all carry
 * `#!/usr/bin/env node` shebangs and are require()d by NOTHING in the daemon — they are
 * standalone CLIs the daemon spawns as child processes. There, execSync blocks only its own
 * process, which is what a CLI waiting on a browser should do. Asserting against them would
 * force an async rewrite on code that is already correct, so the invariant is stated as what
 * is actually true: the daemon's own process must not block on a browser.
 */
test('CALL SITES: nothing on the daemon event loop may execSync a browser', () => {
  const offenders = []
  // The daemon process = daemon/** plus index.js (daemon.js mounts the bridge app in-process).
  const inDaemonProcess = (rel) => rel === 'index.js' || rel === 'daemon.js' || rel.startsWith('daemon/')
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'tests') continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.name.endsWith('.js')) continue
      if (!inDaemonProcess(path.relative(ROOT, p))) continue
      const src = fs.readFileSync(p, 'utf8')
      const lines = src.split('\n')
      lines.forEach((line, i) => {
        // execSync on the same line as a browser launch, or execSync(cmd) where cmd is a
        // playwright command assembled nearby.
        if (/execSync\s*\(/.test(line) && /playwright|--headed/.test(line)) {
          offenders.push(`${path.relative(ROOT, p)}:${i + 1}`)
        }
        if (/execSync\s*\(\s*cmd\b/.test(line)) {
          const near = lines.slice(Math.max(0, i - 8), i).join('\n')
          if (/playwright|--headed/.test(near)) offenders.push(`${path.relative(ROOT, p)}:${i + 1}`)
        }
      })
    }
  }
  walk(ROOT)

  assert.deepStrictEqual(
    offenders,
    [],
    `execSync must not launch a browser — it holds the daemon's event loop for the child's whole life ` +
      `and the watchdog then kills the process. Use a detached spawn. Offenders: ${offenders.join(', ')}`,
  )
})
