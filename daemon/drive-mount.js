'use strict'

/**
 * #188567 — a Hive drive (`iris hive drive`, JuiceFS) mounted into a sandbox at /workspace.
 *
 * The drive is already mounted on this node by the CLI (`iris hive drive mount <name>`), which
 * keeps its config in ~/.iris/drives/<name>.json. A sandboxed run that asks for the drive gets
 * `<mountpoint>/workspace` bind-mounted at /workspace — the drive's workspace, not the whole
 * drive, so a 100 GB video folder elsewhere on the drive is not in every sandbox's lap.
 *
 * CREDENTIALS. The config holds the metadata URL (often with a password). This module reads only
 * `mountpoint` from it and returns paths — never the URL — so nothing that reaches a container
 * argv or env can carry it. The container sees files through the kernel, nothing else.
 *
 * ONE WRITER. At most one sandbox, on any node, mounts a drive read-write at a time; everyone
 * else mounts it read-only. The lock lives IN the drive so every node that mounts it sees the
 * same one, and JuiceFS makes mkdir atomic across clients (its metadata engine is the referee):
 *
 *   <drive>/.iris/rw/          exists  ⇔ someone holds read-write
 *   <drive>/.iris/rw/holder    "<holder> <expires_at epoch seconds>"
 *
 * fl-iris-api's Cloudflare bridge (DriveBridge) speaks the same protocol from a shell task, so a
 * Cloudflare sandbox and a Docker sandbox cannot both write the same drive. Change one, change
 * both. A holder that crashes is taken over after its expiry; a holder renews by acquiring again.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

// Same rule as `iris hive drive create` (platform-hive-drive.ts NAME).
const NAME = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/
const HOLDER = /^[A-Za-z0-9._:-]{1,80}$/
// A lock directory with no holder file is a writer mid-acquire; older than this, it crashed there.
const ORPHAN_SECONDS = 60

/** "work" → rw, "work:ro" → ro, "work:rw" → rw. Anything else is refused, never guessed. */
function parseDriveSpec (spec) {
  const s = String(spec ?? '').trim()
  const m = /^([^:]+)(?::(ro|rw))?$/.exec(s)
  if (!m || !NAME.test(m[1])) {
    throw new Error(`drive must look like <name> or <name>:ro (3–32 lowercase letters, digits, dashes), not "${s}"`)
  }
  return { name: m[1], readOnly: m[2] === 'ro' }
}

const lockDir = (root) => path.join(root, '.iris', 'rw')
const holderFile = (root) => path.join(lockDir(root), 'holder')

/** { holder, expiresAt (epoch s) } or null when nobody holds it (or the holder is mid-acquire). */
function readHolder (root) {
  try {
    const [holder, exp] = fs.readFileSync(holderFile(root), 'utf8').trim().split(/\s+/)
    return holder ? { holder, expiresAt: Number(exp) || 0 } : null
  } catch {
    return null
  }
}

function writeHolder (root, holder, ttlSeconds, nowMs) {
  const exp = Math.floor(nowMs / 1000) + Math.max(1, Math.floor(ttlSeconds))
  // Write-then-rename so a reader never sees half a line.
  const tmp = path.join(lockDir(root), `.holder.${process.pid}.${crypto.randomBytes(4).toString('hex')}`)
  fs.writeFileSync(tmp, `${holder} ${exp}\n`)
  fs.renameSync(tmp, holderFile(root))
}

function isStale (root, cur, nowMs) {
  if (cur) return cur.expiresAt * 1000 < nowMs
  try {
    return (nowMs - fs.statSync(lockDir(root)).mtimeMs) / 1000 > ORPHAN_SECONDS
  } catch {
    return true
  }
}

/**
 * Take (or renew) the read-write lock. Returns { ok: true } or { ok: false, reason }.
 * @param {string} root      the drive's mountpoint
 * @param {string} holder    who is writing, e.g. "task-<id>" or "sandbox-lease-<id>"
 * @param {number} ttlSeconds how long the lock holds without a renewal
 */
function acquireRw (root, holder, ttlSeconds, nowMs = Date.now()) {
  if (!HOLDER.test(String(holder))) throw new Error(`bad lock holder "${holder}"`)
  fs.mkdirSync(path.join(root, '.iris'), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(lockDir(root))
      writeHolder(root, holder, ttlSeconds, nowMs)
      return { ok: true }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
    const cur = readHolder(root)
    if (cur && cur.holder === holder) {
      writeHolder(root, holder, ttlSeconds, nowMs)
      return { ok: true }
    }
    if (!isStale(root, cur, nowMs)) {
      const who = cur ? cur.holder : 'another run (starting)'
      const until = cur ? ` until ${new Date(cur.expiresAt * 1000).toISOString()}` : ''
      return { ok: false, reason: `the drive is mounted read-write by ${who}${until} — mount it :ro, or wait` }
    }
    // Stale: move it aside (only one taker's rename can succeed), then try once more to create.
    try {
      const aside = `${lockDir(root)}.stale.${crypto.randomBytes(4).toString('hex')}`
      fs.renameSync(lockDir(root), aside)
      fs.rmSync(aside, { recursive: true, force: true })
    } catch { /* someone else took it over first — the next mkdir decides */ }
  }
  const cur = readHolder(root)
  return { ok: false, reason: `the drive is mounted read-write by ${cur ? cur.holder : 'another run'} — mount it :ro, or wait` }
}

/** Release, only by the holder. Returns whether it released. */
function releaseRw (root, holder) {
  const cur = readHolder(root)
  if (!cur || cur.holder !== holder) return false
  fs.rmSync(lockDir(root), { recursive: true, force: true })
  return true
}

/** Same check as the CLI's isMounted: the kernel's table, not a pid file or an exit code. */
function isMounted (mountpoint, mountsTable) {
  const table = mountsTable ?? (() => {
    try { return fs.readFileSync('/proc/mounts', 'utf8') } catch {}
    try { return require('child_process').execFileSync('mount', { encoding: 'utf8' }) } catch { return '' }
  })()
  const mp = path.resolve(mountpoint)
  return table.split('\n').some((l) => l.split(/\s+/).includes(mp) || l.includes(` on ${mp} `))
}

/**
 * The drive's paths on this node — the mountpoint and its workspace. NEVER the metadata URL.
 * Throws with a plain reason when the drive is unknown here or not mounted: a sandbox must not be
 * handed the empty directory underneath an unmounted drive and told it is the drive.
 */
function resolveDrive (name, { home = os.homedir(), mountsTable } = {}) {
  let cfg
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(home, '.iris', 'drives', `${name}.json`), 'utf8'))
  } catch {
    throw new Error(`no drive called ${name} on this node — iris hive drive join ${name} --meta …`)
  }
  const mountpoint = typeof cfg.mountpoint === 'string' && path.isAbsolute(cfg.mountpoint) ? path.resolve(cfg.mountpoint) : null
  if (!mountpoint) throw new Error(`drive ${name} has no mountpoint in its config`)
  if (!isMounted(mountpoint, mountsTable)) throw new Error(`drive ${name} is not mounted on this node — iris hive drive mount ${name}`)
  return { name, mountpoint, workspace: path.join(mountpoint, 'workspace') }
}

/**
 * Everything a sandboxed run needs to mount a drive, or a refusal. rw takes the lock (and the
 * result carries release()); ro takes nothing. rw while someone else writes is REFUSED — not
 * downgraded to ro, because a run that believes it saved its work and did not is worse than one
 * that was told no.
 */
function planDriveMount (spec, { home, mountsTable, holder, ttlSeconds = 600 } = {}) {
  let want, d
  try {
    want = parseDriveSpec(spec)
    d = resolveDrive(want.name, { home, mountsTable })
  } catch (e) {
    return { ok: false, reason: e.message }
  }
  fs.mkdirSync(d.workspace, { recursive: true })
  if (!want.readOnly) {
    const got = acquireRw(d.mountpoint, holder, ttlSeconds)
    if (!got.ok) return { ok: false, reason: `drive ${want.name}: ${got.reason}` }
  }
  return {
    ok: true,
    name: want.name,
    readOnly: want.readOnly,
    hostPath: d.workspace,
    release: () => (want.readOnly ? false : releaseRw(d.mountpoint, holder))
  }
}

module.exports = { parseDriveSpec, acquireRw, releaseRw, readHolder, isMounted, resolveDrive, planDriveMount, NAME }
