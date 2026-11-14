// #193363 follow-up: the daemon notices a drive being plugged in and runs the CLI's catch-up
// (`iris vault auto run`), debounced, one at a time, never on low power, never when turned off;
// and runs `iris vault heal --auto` daily. The CLI owns drive ids and the vault work.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  parseMountinfo, linuxDriveMounts, macVolumes, windowsLetters, snapshot, diff, parsePmset, linuxPower, powerHold,
  enabled, runCli, summarize, VaultAuto,
} = require('../lib/vault-auto')

const FIX = path.join(__dirname, 'fixtures')

// ── mount detection, per OS ──────────────────────────────────────────────────────────────

test('Linux: mountinfo → only real drives; system, pseudo, snap, docker and boot mounts are left out; \\040 decoded', () => {
  const text = fs.readFileSync(path.join(FIX, 'mountinfo-linux.txt'), 'utf8')
  assert.strictEqual(parseMountinfo(text).length, 11)
  assert.deepStrictEqual(linuxDriveMounts(text), ['/media/me/Backup A', '/mnt/redwalrus'])
  assert.deepStrictEqual(snapshot('linux', { readFile: () => text }), ['/media/me/Backup A', '/mnt/redwalrus'])
})

test('Linux: a loop image mounted by hand counts (that is how a throwaway drive is tested)', () => {
  const line = '120 31 7:20 / /tmp/iris-proof/mnt/spare rw,relatime shared:600 - ext4 /dev/loop20 rw'
  assert.deepStrictEqual(linuxDriveMounts(line), ['/tmp/iris-proof/mnt/spare'])
})

test('macOS: /Volumes entries, minus hidden ones and the boot volume link', () => {
  const names = fs.readFileSync(path.join(FIX, 'volumes-darwin.txt'), 'utf8').split('\n').filter(Boolean)
  const links = new Set(['Macintosh HD'])
  assert.deepStrictEqual(macVolumes(names, (n) => links.has(n)), ['/Volumes/Backup A', '/Volumes/Studio Drive', '/Volumes/Com.apple.TimeMachine.localsnapshots'])
  assert.deepStrictEqual(snapshot('darwin', { readdir: () => names, isSymlink: (n) => links.has(n) }).length, 3)
})

test('Windows (best effort): drive letters D: to Z: that exist; C: is never a drive to catch up', () => {
  const present = new Set(['C:\\', 'E:\\', 'Z:\\'])
  assert.deepStrictEqual(windowsLetters((p) => present.has(p)), ['E:\\', 'Z:\\'])
  assert.deepStrictEqual(snapshot('win32', { exists: (p) => present.has(p) }), ['E:\\', 'Z:\\'])
})

test('an unreadable mount table reads as no mounts, never a throw', () => {
  assert.deepStrictEqual(snapshot('linux', { readFile: () => { throw new Error('EACCES') } }), [])
  assert.deepStrictEqual(snapshot('sunos'), [])
})

test('diff: what appeared, what went', () => {
  assert.deepStrictEqual(diff(['/a', '/b'], ['/b', '/c']), { added: ['/c'], removed: ['/a'] })
})

// ── power ────────────────────────────────────────────────────────────────────────────────

test('macOS power: pmset output → battery, percent, Low Power Mode', () => {
  const batt = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234)\t18%; discharging; 1:02 remaining present: true\n"
  assert.deepStrictEqual(parsePmset(batt, ' lowpowermode         0\n'), { onBattery: true, percent: 18, lowPower: false })
  assert.deepStrictEqual(parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; charged;", ' lowpowermode 1'), { onBattery: false, percent: 80, lowPower: true })
  assert.strictEqual(powerHold(parsePmset(batt, '')), 'on battery at 18%')
  assert.strictEqual(powerHold({ onBattery: false, percent: 80, lowPower: true }), 'Low Power Mode is on')
  assert.strictEqual(powerHold({ onBattery: true, percent: 55, lowPower: false }), null)
  assert.strictEqual(powerHold(null), null) // unknown power never holds a catch-up
})

test('Linux power: a discharging battery below the line holds; AC or no battery does not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'va-pow-'))
  fs.mkdirSync(path.join(root, 'BAT0'))
  fs.writeFileSync(path.join(root, 'BAT0', 'status'), 'Discharging\n')
  fs.writeFileSync(path.join(root, 'BAT0', 'capacity'), '12\n')
  assert.deepStrictEqual(linuxPower(root), { onBattery: true, percent: 12, lowPower: false })
  fs.writeFileSync(path.join(root, 'BAT0', 'status'), 'Charging\n')
  assert.strictEqual(powerHold(linuxPower(root)), null)
  assert.deepStrictEqual(linuxPower(path.join(root, 'none')), { onBattery: false, percent: null, lowPower: false })
})

// ── on / off ─────────────────────────────────────────────────────────────────────────────

test('`iris vault auto off` (enabled: false) and IRIS_VAULT_AUTO=0 both turn it off; no file = on', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'va-on-'))
  const f = path.join(d, 'vault-auto.json')
  assert.strictEqual(enabled({}, f), true)
  fs.writeFileSync(f, JSON.stringify({ enabled: false }))
  assert.strictEqual(enabled({}, f), false)
  fs.writeFileSync(f, JSON.stringify({ enabled: true }))
  assert.strictEqual(enabled({ IRIS_VAULT_AUTO: '0' }, f), false)
  fs.writeFileSync(f, '{not json')
  assert.strictEqual(enabled({}, f), true)
})

// ── the watcher: debounce, one at a time, off, power ─────────────────────────────────────

/** A fake clock: setTimeout/setInterval that only fire when the test says so. */
function clock () {
  let id = 0
  const timers = new Map()
  return {
    setTimeout: (fn, ms) => { const h = { id: ++id, fn, ms, kind: 't' }; timers.set(h.id, h); return h },
    clearTimeout: (h) => { if (h) timers.delete(h.id) },
    setInterval: (fn, ms) => { const h = { id: ++id, fn, ms, kind: 'i' }; timers.set(h.id, h); return h },
    clearInterval: (h) => { if (h) timers.delete(h.id) },
    pending: (ms) => [...timers.values()].filter((t) => t.kind === 't' && (ms == null || t.ms === ms)),
    fire: (h) => { timers.delete(h.id); return h.fn() },
  }
}

function watcher (over = {}) {
  const c = clock()
  let mounts = over.mounts || []
  const runs = []
  const logs = []
  let release
  const a = new VaultAuto({
    platform: 'linux', bin: '/fake/iris', debounceMs: 20000, pollMs: 5000, startupDelayMs: 120000, healFirstMs: 1800000, watch: null,
    snapshot: () => mounts, power: over.power || (() => null), enabled: over.enabled || (() => true), log: (s) => logs.push(s),
    run: (args) => { runs.push(args); return over.slow ? new Promise((r) => { release = () => r({ ok: true, body: { ok: true, vaults: [] } }) }) : Promise.resolve({ ok: true, body: { ok: true, vaults: [{ vault: 'studio', text: 'caught up 3 files (12 chunks)', checks: [{ label: 'Backup A', status: 'ok' }] }] } }) },
    ...c,
  })
  return { a, c, runs, logs, plug: (...m) => { mounts = [...mounts, ...m] }, release: () => release && release() }
}

test('a drive plugged in → one catch-up after the debounce; a burst of mounts is ONE run', async () => {
  const w = watcher({ mounts: ['/'] })
  w.a.start()
  w.plug('/media/me/Backup A')
  w.a.poll()
  w.plug('/media/me/Backup A-2') // a second partition 2 s later restarts the wait
  w.a.poll()
  const pend = w.c.pending(20000)
  assert.strictEqual(pend.length, 1, 'one debounce timer, not two')
  await w.c.fire(pend[0])
  assert.deepStrictEqual(w.runs, [['vault', 'auto', 'run', '--trigger', 'mount', '--json']])
  assert.ok(w.logs.some((l) => /catch-up studio: caught up 3 files/.test(l)))
  assert.ok(w.logs.some((l) => /drive connected: \/media\/me\/Backup A/.test(l)))
})

test('a mount going away does not start anything', () => {
  const w = watcher({ mounts: ['/mnt/x'] })
  w.a.start()
  w.a.snapshot = () => []
  w.a.poll()
  assert.strictEqual(w.c.pending(20000).length, 0)
})

test('never two catch-ups at once: a drive plugged in mid-run gets ONE more run after it', async () => {
  const w = watcher({ slow: true })
  w.a.start()
  const first = w.a.catchUp('mount')
  assert.deepStrictEqual(await w.a.catchUp('mount'), { queued: true })
  assert.deepStrictEqual(await w.a.catchUp('mount'), { queued: true })
  assert.strictEqual(w.runs.length, 1)
  w.release()
  await first
  assert.strictEqual(w.c.pending(20000).length, 1, 'the queued plug-in becomes one debounced run')
})

test('auto off → nothing runs, and the log says how to turn it on', async () => {
  const w = watcher({ enabled: () => false })
  w.a.start()
  assert.deepStrictEqual(await w.a.catchUp('mount'), { off: true })
  assert.strictEqual(await w.a.heal(), null)
  assert.strictEqual(w.runs.length, 0)
  assert.ok(w.logs.some((l) => /off on this machine \(iris vault auto on\)/.test(l)))
})

test('low power → the catch-up waits and retries later instead of running', async () => {
  const w = watcher({ power: () => ({ onBattery: true, percent: 9, lowPower: false }) })
  w.a.start()
  const r = await w.a.catchUp('mount')
  assert.deepStrictEqual(r, { held: 'on battery at 9%' })
  assert.strictEqual(w.runs.length, 0)
  assert.strictEqual(w.c.pending(10 * 60 * 1000).length, 1)
})

test('drives already plugged in at start are caught up once; heal is scheduled daily', async () => {
  const w = watcher({ mounts: ['/mnt/a'] })
  w.a.start()
  const startup = w.c.pending(120000)[0]
  w.c.fire(startup)
  await w.c.fire(w.c.pending(0)[0])
  assert.deepStrictEqual(w.runs[0], ['vault', 'auto', 'run', '--trigger', 'mount', '--json'])
  await w.c.fire(w.c.pending(1800000)[0])
  assert.deepStrictEqual(w.runs[1], ['vault', 'heal', '--auto', '--json'])
  w.a.stop()
  assert.strictEqual(w.c.pending().length, 0)
})

test('no IRIS CLI → skipped with a reason, no throw', async () => {
  const w = watcher()
  w.a.bin = null
  assert.deepStrictEqual(await w.a.catchUp('mount'), { noCli: true })
})

// ── the CLI run: no TTY, stdin closed, never hangs ───────────────────────────────────────

test('the CLI runs with stdin closed: a command that would wait for input gets EOF and returns', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'va-cli-'))
  const bin = path.join(d, 'iris')
  // A stand-in that reads a "passphrase" from stdin: with stdin closed it sees EOF at once.
  fs.writeFileSync(bin, `#!/bin/sh\nread -r pass\nif [ -z "$pass" ]; then echo '{"ok":true,"vaults":[{"vault":"studio","skipped":"the key cannot be opened without a person here"}]}'; exit 0; fi\necho '{"ok":false}'\n`)
  fs.chmodSync(bin, 0o755)
  const t0 = Date.now()
  const r = await runCli(bin, ['vault', 'auto', 'run', '--json'], { timeoutMs: 10000 })
  assert.ok(Date.now() - t0 < 5000)
  assert.deepStrictEqual(summarize('catch-up', r), ['[vault-auto] catch-up studio: skipped — the key cannot be opened without a person here'])
})

test('summaries: a failure, a machine that is off, a heal', () => {
  assert.match(summarize('catch-up', { body: null, error: 'spawn ENOENT', stderr: '' })[0], /FAILED — spawn ENOENT/)
  assert.deepStrictEqual(summarize('heal', { body: { ok: true, skipped: 'automatic catch-up is off on this machine' } }), ['[vault-auto] heal skipped — automatic catch-up is off on this machine'])
  const h = summarize('heal', { body: { ok: true, vaults: [{ vault: 'studio', plan: { lost: [{ key: 'drive:fs:b' }], alerts: [], returned: [] }, rebuilt: [{ ok: true }], retired: [] }] } })
  assert.deepStrictEqual(h, ['[vault-auto] heal studio: 1 lost, 1 rebuilt on a spare, 0 with no spare'])
  assert.deepStrictEqual(summarize('heal', { body: { ok: true, vaults: [{ vault: 'v', plan: { lost: [], returned: [] }, rebuilt: [] }] } }), ['[vault-auto] heal: nothing to do'])
})
