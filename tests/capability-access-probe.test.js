'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

/**
 * A capability is evidence of ACCESS, never evidence of EXISTENCE (#182007).
 *
 * `detectAppleApps` reported `imessage: fs.existsSync(chatDbPath)`. existsSync is a stat, and
 * macOS TCC blocks the open() — not the stat. So on a Mac without Full Disk Access the chat
 * database is present and unreadable, and the node advertised itself as iMessage-capable.
 *
 * Measured 2026-08-23 on MacBookPro: presence TRUE, `sqlite3` read "authorization denied", 69
 * consecutive Calendar failures — and `hive nodes show` still listing the node online with
 * nine capabilities, none of them a permission.
 *
 * Why it matters more than a wrong boolean: a TCC-blocked read returns EMPTY rather than
 * failing. The node accepts the work and answers zero rows, which reads as a legitimate
 * result. That is the same failure the capability gate exists to stop (#182452), one layer
 * down — and the gate cannot be built correctly while its input lies.
 *
 * These tests exercise the probe against real files, because the entire point is that the
 * cheap answer (does the path exist) and the true answer (can I read it) differ.
 */

const { detectAppleApps } = require('../daemon/hardware-profile')

function tmpFile (name, contents) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'capprobe-'))
  const p = path.join(d, name)
  if (contents !== undefined) fs.writeFileSync(p, contents)
  return p
}

/** The probe is not exported; reach it the way the profile does, through a real file. */
function probe (filePath) {
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    fs.readSync(fd, Buffer.alloc(1), 0, 1, 0)
    return { readable: true, reason: null }
  } catch (e) {
    if (e && e.code === 'ENOENT') return { readable: false, reason: 'absent' }
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) return { readable: false, reason: 'permission-denied' }
    return { readable: false, reason: (e && e.code) || 'unknown' }
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* already gone */ } }
  }
}

test('a readable file reports readable, with no reason', () => {
  const p = tmpFile('readable.db', 'x')
  const r = probe(p)
  assert.strictEqual(r.readable, true)
  assert.strictEqual(r.reason, null, 'a reason on a healthy capability is noise')
})

test('an EMPTY but readable file is readable — not mistaken for blocked', () => {
  // A zero-length chat.db is a real state (a Mac that has never sent a message). Measured:
  // readSync returns 0 rather than throwing, so this must not be reported as denied.
  const p = tmpFile('empty.db', '')
  const r = probe(p)
  assert.strictEqual(r.readable, true, 'empty is not the same as unreadable')
  assert.strictEqual(r.reason, null)
})

test('a missing file reports absent — distinguishable from blocked', () => {
  const r = probe(path.join(os.tmpdir(), 'capprobe-nope', 'never-existed.db'))
  assert.strictEqual(r.readable, false)
  assert.strictEqual(r.reason, 'absent', 'absent and permission-denied need different remedies')
})

test('a file that EXISTS but cannot be opened reports permission-denied, not present', () => {
  // This is the exact shape of the bug: existsSync says true, the open says no.
  const p = tmpFile('locked.db', 'secret')
  fs.chmodSync(p, 0o000)

  // Running as root defeats mode bits; skip rather than assert something untrue.
  let blocked = true
  try { const fd = fs.openSync(p, 'r'); fs.closeSync(fd); blocked = false } catch { /* expected */ }
  if (!blocked) return

  assert.strictEqual(fs.existsSync(p), true, 'the old probe would have said CAPABLE here')
  const r = probe(p)
  assert.strictEqual(r.readable, false, 'presence must not be reported as capability')
  assert.strictEqual(r.reason, 'permission-denied')
})

test('the profile no longer derives imessage from existsSync', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'hardware-profile.js'), 'utf8')
  assert.ok(
    !/imessage:\s*fs\.existsSync/.test(src),
    'imessage must come from an access attempt, not a stat',
  )
  assert.match(src, /imessage:\s*imessageAccess\.readable/, 'imessage reflects a real read')
  assert.match(src, /imessage_reason/, 'a false capability must say WHY — absent and blocked differ')
})

/**
 * The same defect one layer over, in the probe that actually feeds the heartbeat.
 *
 * bridge-registry's imessage `available()` carried the comment "Probe for real" and then
 * called `fs.accessSync(db, R_OK)`. That is not a real probe: access(2) tests unix permission
 * BITS, and TCC leaves those intact while denying the open(). chat.db is mode 0600 owned by
 * the user whether or not Full Disk Access was ever granted — so R_OK returns success on a
 * machine that cannot read a single row.
 *
 * This is the more consequential of the two, because `bridge_capabilities` is what the
 * heartbeat sends and therefore what any future routing gate would consult.
 */
test('accessSync(R_OK) cannot detect a TCC-style denial — which is why it was the wrong probe', () => {
  // Reproduce chat.db's ownership/mode exactly: ours, 0600, readable by bits.
  const p = tmpFile('chat.db', 'x')
  fs.chmodSync(p, 0o600)

  // The OLD probe passes here, and would pass identically on a TCC-blocked file, because
  // TCC does not alter the mode bits it inspects.
  assert.doesNotThrow(
    () => fs.accessSync(p, fs.constants.R_OK),
    'R_OK passes on a file we own — it can never be evidence of Full Disk Access',
  )

  // The NEW probe touches the file, which is the syscall a TCC denial lands on.
  assert.strictEqual(probe(p).readable, true, 'and it still says yes when the read genuinely works')
})

test('bridge-registry probes iMessage by opening the db, not by asking access(2)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'bridge-registry.js'), 'utf8')
  assert.ok(
    !/accessSync\(db,\s*fs\.constants\.R_OK\)/.test(src),
    'R_OK on chat.db is indistinguishable from having no permission at all',
  )
  assert.match(src, /fd = fs\.openSync\(db, 'r'\)/, 'the probe must open the database')
  assert.match(
    src,
    /RESTART the daemon/,
    'granting FDA without restarting changes nothing — TCC is read at process start, so the remedy must say so',
  )
})

test('detectAppleApps returns a three-way answer on this platform', () => {
  const p = detectAppleApps()
  assert.ok(typeof p === 'object' && p !== null)
  assert.strictEqual(typeof p.imessage, 'boolean')
  if (p.platform === 'darwin') {
    // Never hand out a path that was not actually opened.
    if (!p.imessage) assert.strictEqual(p.chat_db, null, 'an unreadable db must not be advertised as a path')
    assert.ok(p.imessage_reason === null || typeof p.imessage_reason === 'string')
  }
})
