// The SOM batch lock (#190291). On 2026-10-21 a batch on iris-hive-001 died at 03:40 and left
// /tmp/som_batch.lock behind. For the next 30 minutes every SOM run, including one dispatched
// from Hive, printed "ALREADY RUNNING", exited 0 and was reported as completed. The lock only
// looked at its age, never at whether its process was alive.
const test = require('node:test')
const assert = require('node:assert')
const { lockVerdict } = require('../som/som-lock')

const MIN = 60 * 1000
const now = Date.parse('2026-10-21T04:08:00Z')

test('a lock whose process is dead is stale at any age', () => {
  assert.strictEqual(lockVerdict({ pid: 920095, started: now - 28 * MIN }, now, () => false), 'stale')
  assert.strictEqual(lockVerdict({ pid: 920095, started: now - 1 * MIN }, now, () => false), 'stale')
})

test('a lock whose process is alive and young means a batch is running', () => {
  assert.strictEqual(lockVerdict({ pid: 1234, started: now - 5 * MIN }, now, () => true), 'busy')
})

test('a live lock older than 30 minutes is still treated as stale (a hung batch)', () => {
  assert.strictEqual(lockVerdict({ pid: 1234, started: now - 31 * MIN }, now, () => true), 'stale')
})

test('a corrupt lock is stale', () => {
  assert.strictEqual(lockVerdict(null, now, () => true), 'stale')
  assert.strictEqual(lockVerdict({ pid: 'x' }, now, () => true), 'stale')
})

test('the default liveness check finds this process alive and a nonsense pid dead', () => {
  const { pidAlive } = require('../som/som-lock')
  assert.strictEqual(pidAlive(process.pid), true)
  assert.strictEqual(pidAlive(2 ** 22 + 12345), false)
})

test('som-all.js uses the shared verdict instead of its own age-only check', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../som/som-all.js'), 'utf8')
  assert.match(src, /require\('\.\/som-lock'\)/)
  assert.doesNotMatch(src, /if \(age < maxAge\)/)
})

// The orphan pre-flight (#190291). It spared only its own PID and its direct parent, and SIGTERM'd
// every other process whose command line mentions som-all.js. That includes the tmux client the
// daemon launches it from (`tmux new-session … node som-all.js …`) and any wrapper shell, so every
// daemon-started SOM run killed its own session within a second, reported "completed", and left its lock behind.
test('the pre-flight never kills its own ancestors, only other node som-all.js processes', () => {
  const { orphanPids } = require('../som/som-lock')
  const ps = [
    '100 tmux new-session -d -s iris-som_batch-x node /h/.iris/bridge/som/som-all.js only=courses',
    '101 /bin/sh -c node /h/.iris/bridge/som/som-all.js only=courses',
    '102 node /h/.iris/bridge/som/som-all.js only=courses',
    '200 node /h/.iris/bridge/som/som-all.js limit=25',
    '300 bash -c timeout 120 node som-all.js dry=1',
    '400 grep som-all.js',
  ].join('\n')
  // We are 102. Our ancestors are 101 and 100. 200 is a real other batch; 300 is a shell, not node.
  assert.deepStrictEqual(orphanPids(ps, 102, [101, 100]), [200])
})

// som-all.js resolves its API token from ~/.iris/sdk/.env (all `iris auth` leaves on a machine), but
// spawned the outreach specs with the bare environment, so on iris-hive-001 every campaign died with
// "HEYIRIS_TOKEN env var required". And a batch whose campaigns all failed still exited 0, which Hive
// reported as a completed task (#190291).
test('som-all hands its resolved token to every campaign it spawns', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../som/som-all.js'), 'utf8')
  const spawns = src.match(/env: \{ \.\.\.process\.env[^}]*\}/g) || []
  assert.ok(spawns.length >= 2, 'expected the campaign spawn sites')
  for (const s of spawns) assert.match(s, /HEYIRIS_TOKEN: API_TOKEN/)
})

test('a batch with a failed campaign exits non-zero', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../som/som-all.js'), 'utf8')
  assert.match(src, /process\.exitCode = results\.some\(r => r\.code !== 0\) \? 1 : 0/)
})

// The SOM drives a HEADED browser (playwright.config.ts headless:false). On a Linux Hive node with no
// screen, Chromium exits with "Missing X server or $DISPLAY" before the first lead. Macs have a display.
// Linux nodes without one run each campaign under a virtual display (#190291).
test('on Linux with no display, campaigns run under xvfb-run; with a display, directly', () => {
  const { campaignCommand } = require('../som/som-lock')
  assert.deepStrictEqual(campaignCommand('linux', {}, true, 'som.js', ['courses']).cmd, 'xvfb-run')
  assert.deepStrictEqual(campaignCommand('linux', { DISPLAY: ':0' }, true, 'som.js', ['courses']), { cmd: 'node', args: ['som.js', 'courses'] })
  assert.deepStrictEqual(campaignCommand('darwin', {}, false, 'som.js', ['courses']), { cmd: 'node', args: ['som.js', 'courses'] })
  const x = campaignCommand('linux', {}, true, 'som.js', ['courses'])
  assert.deepStrictEqual(x.args.slice(-3), ['node', 'som.js', 'courses'])
  assert.ok(x.args.includes('-a'), 'pick a free display number automatically')
})

test('som-all spawns campaigns through campaignCommand', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../som/som-all.js'), 'utf8')
  assert.doesNotMatch(src, /spawn\('node', \[somScript/)
  assert.match(src, /campaignCommand\(/)
})

// A machine without PLATFORM_UPDATES_DISCORD_CHANNEL_WEBHOOK_URL crashed the whole campaign at its
// end-of-run alert ("TypeError: Invalid URL" at new URL('')). An alert channel is optional (#190291).
test('every Discord alert skips quietly when no webhook is configured', () => {
  const fs = require('fs'), path = require('path')
  for (const f of ['batch-with-login.spec.ts', 'email-batch-outreach.spec.ts']) {
    const src = fs.readFileSync(path.join(__dirname, '../som', f), 'utf8')
    const sites = src.split('new URL(DISCORD_WEBHOOK)').length - 1
    const guarded = (src.match(/if \(!DISCORD_WEBHOOK\) \{[^}]*return resolve\(\); \}\s*const url = new URL\(DISCORD_WEBHOOK\)/g) || []).length
    assert.ok(sites > 0, `${f}: expected Discord alert sites`)
    assert.strictEqual(guarded, sites, `${f}: ${sites - guarded} unguarded Discord alert(s)`)
  }
})

// Chrome left running after a stop, and a "throttle" that added browsers (2026-10-23).
const { descendantPids, orphanBrowserPids, parallelLimit } = require('../som/som-lock')

test('a stop reaches the whole campaign tree, browsers included', () => {
  const ps = ['100 1', '200 100', '300 200', '400 300', '401 400', '402 400', '999 1'].join('\n')
  assert.deepStrictEqual(descendantPids(ps, 100).sort(), [200, 300, 400, 401, 402])
  assert.deepStrictEqual(descendantPids(ps, 999), [])
})

test('only Playwright browsers whose owner died are closed', () => {
  const chrome = '/home/u/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome --no-sandbox --remote-debugging-pipe'
  const ps = [
    `500 1 ${chrome}`,                                   // owner gone → orphan
    `501 4321 ${chrome}`,                                // a live run owns it
    '502 500 /home/u/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome --type=renderer', // helper, dies with 500
    '503 1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',                     // your own Chrome
  ].join('\n')
  assert.deepStrictEqual(orphanBrowserPids(ps), [500])
})

test('a busier machine never gets more browsers', () => {
  assert.strictEqual(parallelLimit({ freeGb: 16, loadPct: 10 }), 2)
  assert.strictEqual(parallelLimit({ freeGb: 3, loadPct: 10 }), 1)
  assert.strictEqual(parallelLimit({ freeGb: 16, loadPct: 60 }), 1)
  assert.strictEqual(parallelLimit({ freeGb: 16, loadPct: 10, battery: 20, charging: false }), 1)
  assert.strictEqual(parallelLimit({ freeGb: 16, loadPct: 10, requested: 1 }), 1)
  assert.strictEqual(parallelLimit({ freeGb: 16, loadPct: 10, requested: 5 }), 2)
})
