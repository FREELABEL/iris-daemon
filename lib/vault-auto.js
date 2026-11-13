// #193363 follow-up — vault copies that look after themselves.
//
// 1. CATCH-UP ON PLUG-IN. Watch this machine's mounted volumes; when one appears (a drive was
//    plugged in), wait for things to settle, then run the CLI's own catch-up:
//        iris vault auto run --trigger mount --json
//    which brings every vault copy on the drives plugged in here up to date (encrypted chunks only,
//    each hash-checked), and records "caught up 3 files" on the vault's copy and the drive's Atlas
//    record. The CLI decides which drives hold vault copies (it owns the drive ids — fs:<uuid> /
//    volume serial); the daemon only notices that the set of mounts changed. One implementation.
//
// 2. HEAL, DAILY. `iris vault heal --auto --json` once a day: a copy unseen past its vault's
//    lost-after is rebuilt on a spare the user named for that vault, nowhere else.
//
// Never two runs at once (the CLI also holds a lock per vault), debounced, deferred on battery /
// low power where that is cheap to read (macOS pmset, Linux /sys/class/power_supply), and off with
// `iris vault auto off` (~/.iris/vault-auto.json) or IRIS_VAULT_AUTO=0. The CLI is run with stdin
// closed and no TTY, so it can never prompt: a step that needs a vault key is skipped and says why.
//
// MOUNT DETECTION PER OS
//   Linux    /proc/self/mountinfo, polled (it is not inotify-able; reading it is ~0.1 ms)
//   macOS    /Volumes, watched (fs.watch) plus polled as a fallback
//   Windows  best effort: drive letters D:..Z: polled every 15 s (no volume-arrival events here)
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile, execFileSync } = require('child_process')

// ── mount tables ───────────────────────────────────────────────────────────────────────────

/** /proc/self/mountinfo → [{ mount, source, fstype }]. Octal escapes (\040 = space) decoded. */
function parseMountinfo (text) {
  const out = []
  const unesc = (s) => String(s).replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue
    const sep = line.indexOf(' - ')
    if (sep < 0) continue
    const left = line.slice(0, sep).split(' ')
    const right = line.slice(sep + 3).split(' ')
    if (left.length < 5 || right.length < 2) continue
    out.push({ mount: unesc(left[4]), fstype: right[0], source: unesc(right[1]) })
  }
  return out
}

// Pseudo and system filesystems: never a user's drive, and they churn (containers, snaps).
const PSEUDO_FS = new Set(['proc', 'sysfs', 'devtmpfs', 'devpts', 'tmpfs', 'cgroup', 'cgroup2', 'securityfs', 'pstore', 'bpf',
  'debugfs', 'tracefs', 'configfs', 'fusectl', 'mqueue', 'hugetlbfs', 'autofs', 'binfmt_misc', 'efivarfs', 'squashfs', 'overlay',
  'nsfs', 'ramfs', 'rpc_pipefs', 'fuse.gvfsd-fuse', 'fuse.portal', 'fuse.snapfuse', 'fuse.lxcfs'])
const SYSTEM_MOUNTS = /^\/(proc|sys|dev|run\/(user|lock|snapd|credentials)|snap|boot|var\/lib\/(docker|containers|kubelet))(\/|$)/

/** Linux: the mounts that could be a user's drive (real block devices, outside system paths). */
function linuxDriveMounts (mountinfo) {
  return parseMountinfo(mountinfo)
    .filter((m) => !PSEUDO_FS.has(m.fstype) && m.source.startsWith('/dev/') && m.mount !== '/' && !SYSTEM_MOUNTS.test(m.mount))
    .map((m) => m.mount)
}

/** macOS: the volumes under /Volumes, minus the boot volume's own link and hidden entries. */
function macVolumes (names, isSymlink = () => false) {
  return names.filter((n) => !n.startsWith('.') && !isSymlink(n)).map((n) => path.join('/Volumes', n))
}

/** Windows (best effort): the drive letters that exist, C: excluded. */
function windowsLetters (exists = (p) => fs.existsSync(p)) {
  const out = []
  for (let c = 68; c <= 90; c++) { // D..Z
    const root = `${String.fromCharCode(c)}:\\`
    try { if (exists(root)) out.push(root) } catch { /* not there */ }
  }
  return out
}

/** This machine's current drive mounts, sorted. Never throws. */
function snapshot (platform = process.platform, io = {}) {
  try {
    if (platform === 'linux') return linuxDriveMounts((io.readFile || fs.readFileSync)('/proc/self/mountinfo', 'utf8')).sort()
    if (platform === 'darwin') {
      const names = (io.readdir || fs.readdirSync)('/Volumes')
      const isLink = io.isSymlink || ((n) => { try { return fs.lstatSync(path.join('/Volumes', n)).isSymbolicLink() } catch { return true } })
      return macVolumes(names, isLink).sort()
    }
    if (platform === 'win32') return windowsLetters(io.exists).sort()
  } catch { /* unreadable: report nothing new */ }
  return []
}

/** What appeared and what went since the last snapshot. */
function diff (before, after) {
  const b = new Set(before)
  const a = new Set(after)
  return { added: after.filter((m) => !b.has(m)), removed: before.filter((m) => !a.has(m)) }
}

// ── power ──────────────────────────────────────────────────────────────────────────────────

/** `pmset -g batt` + `pmset -g` (macOS) → { onBattery, percent, lowPower }. */
function parsePmset (batt, settings = '') {
  const onBattery = /'Battery Power'/.test(String(batt))
  const m = /(\d+)%/.exec(String(batt))
  const lp = /\blowpowermode\s+1\b/.test(String(settings))
  return { onBattery, percent: m ? Number(m[1]) : null, lowPower: lp }
}

/** Linux: any battery discharging, and its capacity. */
function linuxPower (root = '/sys/class/power_supply', io = fs) {
  let names = []
  try { names = io.readdirSync(root) } catch { return { onBattery: false, percent: null, lowPower: false } }
  for (const n of names) {
    if (!/^BAT/i.test(n)) continue
    try {
      const status = String(io.readFileSync(path.join(root, n, 'status'), 'utf8')).trim()
      const cap = Number(String(io.readFileSync(path.join(root, n, 'capacity'), 'utf8')).trim())
      if (status === 'Discharging') return { onBattery: true, percent: Number.isFinite(cap) ? cap : null, lowPower: false }
    } catch { /* unreadable battery: ignore */ }
  }
  return { onBattery: false, percent: null, lowPower: false }
}

/** Why a catch-up waits for power, or null. Copying a drive's worth of chunks on 12 % is not kind. */
function powerHold (p, minPercent = 30) {
  if (!p) return null
  if (p.lowPower) return 'Low Power Mode is on'
  if (p.onBattery && p.percent != null && p.percent < minPercent) return `on battery at ${p.percent}%`
  return null
}

function readPower (platform = process.platform) {
  try {
    if (platform === 'darwin') {
      const batt = execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8', timeout: 5000 })
      const settings = execFileSync('pmset', ['-g'], { encoding: 'utf8', timeout: 5000 })
      return parsePmset(batt, settings)
    }
    if (platform === 'linux') return linuxPower()
  } catch { /* unknown power: do not hold */ }
  return null
}

// ── on / off ───────────────────────────────────────────────────────────────────────────────

const STATE_FILE = () => path.join(os.homedir(), '.iris', 'vault-auto.json')

/** `iris vault auto off` writes { enabled: false } here; IRIS_VAULT_AUTO=0 turns it off for the daemon. */
function enabled (env = process.env, file = STATE_FILE()) {
  if (env.IRIS_VAULT_AUTO === '0') return false
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).enabled !== false } catch { return true }
}

// ── running the CLI ────────────────────────────────────────────────────────────────────────

function findIris () {
  if (process.env.IRIS_VAULT_AUTO_BIN) return process.env.IRIS_VAULT_AUTO_BIN
  const home = os.homedir()
  for (const p of [path.join(home, '.iris/bin/iris'), '/usr/local/bin/iris', '/opt/homebrew/bin/iris', '/usr/bin/iris', path.join(home, '.local/bin/iris')]) {
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch {}
  }
  return null
}

/** Run one CLI command with no TTY and stdin closed: it cannot ask anything. Resolves, never rejects. */
function runCli (bin, args, { timeoutMs = 2 * 3600 * 1000, env = process.env, exec = execFile } = {}) {
  return new Promise((resolve) => {
    const child = exec(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env }, (err, stdout, stderr) => {
      let body = null
      const out = String(stdout || '')
      try { body = JSON.parse(out.slice(out.indexOf('{'))) } catch {}
      // Exit 1 with a JSON body = it ran and has something to report (a copy short, a vault skipped).
      resolve({ ok: !!body, exitCode: err ? (err.code ?? 1) : 0, body, stderr: String(stderr || ''), error: err && !body ? String(err.message).slice(0, 300) : null })
    })
    try { child && child.stdin && child.stdin.end() } catch {}
  })
}

/** One line per vault for the daemon log, from `iris vault auto run --json` / `iris vault heal --json`. */
function summarize (kind, r) {
  if (!r.body) return [`[vault-auto] ${kind} FAILED — ${(r.error || r.stderr.trim().split('\n').pop() || 'no output').slice(0, 300)}`]
  if (r.body.skipped) return [`[vault-auto] ${kind} skipped — ${r.body.skipped}`]
  const lines = []
  for (const v of r.body.vaults || []) {
    if (v.skipped) { lines.push(`[vault-auto] ${kind} ${v.vault}: skipped — ${v.skipped}`); continue }
    if (v.error) { lines.push(`[vault-auto] ${kind} ${v.vault}: FAILED — ${v.error}`); continue }
    if (kind === 'catch-up') {
      const where = (v.checks || []).map((c) => `${c.label} ${c.status}`).join(', ')
      lines.push(`[vault-auto] catch-up ${v.vault}: ${v.text || 'up to date'}${where ? ` (${where})` : ''}`)
    } else {
      const p = v.plan || {}
      const rebuilt = (v.rebuilt || []).filter((x) => x.ok).length
      if (!(p.lost || []).length && !(p.returned || []).length) continue
      lines.push(`[vault-auto] heal ${v.vault}: ${(p.lost || []).length} lost, ${rebuilt} rebuilt on a spare, ${(p.alerts || []).length} with no spare${(v.retired || []).length ? `, ${(v.retired || []).filter((x) => x.ok).length} spare(s) retired` : ''}`)
    }
  }
  if (!lines.length) lines.push(`[vault-auto] ${kind}: nothing to do`)
  return lines
}

// ── the watcher ────────────────────────────────────────────────────────────────────────────

/**
 * new VaultAuto({ ... }).start()
 *
 * Everything that touches the world is injectable (snapshot, power, run, timers, log), so the
 * tests drive it with fake mounts and a fake clock.
 */
class VaultAuto {
  constructor (o = {}) {
    this.platform = o.platform || process.platform
    this.snapshot = o.snapshot || (() => snapshot(this.platform))
    this.power = o.power || (() => readPower(this.platform))
    this.isEnabled = o.enabled || (() => enabled())
    this.bin = o.bin === undefined ? findIris() : o.bin
    this.run = o.run || ((args) => runCli(this.bin, args))
    this.log = o.log || ((s) => console.log(s))
    this.setTimeout = o.setTimeout || setTimeout
    this.clearTimeout = o.clearTimeout || clearTimeout
    this.setInterval = o.setInterval || setInterval
    this.clearInterval = o.clearInterval || clearInterval
    this.watch = o.watch === undefined ? ((dir, cb) => fs.watch(dir, cb)) : o.watch
    this.debounceMs = o.debounceMs ?? Number(process.env.IRIS_VAULT_AUTO_DEBOUNCE_MS || 20000)
    this.pollMs = o.pollMs ?? (this.platform === 'win32' ? 15000 : Number(process.env.IRIS_VAULT_AUTO_POLL_MS || 5000))
    this.powerRetryMs = o.powerRetryMs ?? 10 * 60 * 1000
    const envMs = (k, d) => (Number(process.env[k]) > 0 ? Number(process.env[k]) : d)
    this.startupDelayMs = o.startupDelayMs ?? envMs('IRIS_VAULT_AUTO_STARTUP_MS', 2 * 60 * 1000)
    this.healEveryMs = o.healEveryMs ?? envMs('IRIS_VAULT_HEAL_EVERY_MS', 24 * 3600 * 1000)
    this.healFirstMs = o.healFirstMs ?? envMs('IRIS_VAULT_HEAL_FIRST_MS', 30 * 60 * 1000)
    this.extraArgs = o.extraArgs || []
    this.last = []
    this.timer = null
    this.running = false
    this.rerun = false
    this.healing = false
    this.handles = []
    this.report = { last_catchup: null, last_heal: null, pending: false }
  }

  start () {
    this.last = this.snapshot()
    this.handles.push(['i', this.setInterval(() => this.poll(), this.pollMs)])
    if (this.platform === 'darwin' && this.watch) {
      try { this.watcher = this.watch('/Volumes', () => this.poll()) } catch { /* poll still runs */ }
    }
    // Drives already plugged in when the daemon starts are caught up once, after it settles.
    this.handles.push(['t', this.setTimeout(() => this.trigger('startup'), this.startupDelayMs)])
    this.handles.push(['t', this.setTimeout(() => this.heal(), this.healFirstMs)])
    this.handles.push(['i', this.setInterval(() => this.heal(), this.healEveryMs)])
    for (const [, h] of this.handles) if (h && typeof h.unref === 'function') h.unref()
    return this
  }

  stop () {
    for (const [k, h] of this.handles) (k === 'i' ? this.clearInterval : this.clearTimeout)(h)
    this.handles = []
    if (this.timer) this.clearTimeout(this.timer)
    this.timer = null
    try { this.watcher && this.watcher.close() } catch {}
  }

  /** Compare mounts with the last look; a new one (re)starts the debounce. */
  poll () {
    const now = this.snapshot()
    const d = diff(this.last, now)
    this.last = now
    if (d.added.length) {
      this.log(`[vault-auto] drive connected: ${d.added.join(', ')} — catching up in ${Math.round(this.debounceMs / 1000)} s`)
      this.trigger('mount')
    }
    return d
  }

  /** Debounce: a burst of mounts (several partitions, a slow USB hub) becomes one run. */
  trigger (why) {
    this.report.pending = true
    if (this.timer) this.clearTimeout(this.timer)
    this.timer = this.setTimeout(() => { this.timer = null; this.catchUp(why) }, why === 'startup' ? 0 : this.debounceMs)
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref()
  }

  async catchUp (why) {
    if (this.running) { this.rerun = true; return { queued: true } }
    if (!this.isEnabled()) { this.report.pending = false; this.log('[vault-auto] catch-up skipped — automatic catch-up is off on this machine (iris vault auto on)'); return { off: true } }
    if (!this.bin) { this.report.pending = false; this.log('[vault-auto] catch-up skipped — IRIS CLI not found'); return { noCli: true } }
    const hold = powerHold(this.power())
    if (hold) {
      this.log(`[vault-auto] catch-up waits — ${hold}; trying again in ${Math.round(this.powerRetryMs / 60000)} min`)
      const h = this.setTimeout(() => this.catchUp(why), this.powerRetryMs)
      if (h && typeof h.unref === 'function') h.unref()
      return { held: hold }
    }
    this.running = true
    this.report.pending = false
    try {
      const r = await this.run(['vault', 'auto', 'run', '--trigger', why === 'startup' ? 'mount' : why, '--json', ...this.extraArgs])
      for (const l of summarize('catch-up', r)) this.log(l)
      this.report.last_catchup = { at: new Date().toISOString(), ok: !!(r.body && r.body.ok !== false) }
      return r
    } finally {
      this.running = false
      // A drive plugged in while we were busy gets its own run.
      if (this.rerun) { this.rerun = false; this.trigger('mount') }
    }
  }

  async heal () {
    if (this.healing || !this.isEnabled() || !this.bin) return null
    this.healing = true
    try {
      const r = await this.run(['vault', 'heal', '--auto', '--json', ...this.extraArgs])
      for (const l of summarize('heal', r)) this.log(l)
      this.report.last_heal = { at: new Date().toISOString(), ok: !!(r.body && r.body.ok !== false) }
      return r
    } finally {
      this.healing = false
    }
  }
}

module.exports = {
  parseMountinfo, linuxDriveMounts, macVolumes, windowsLetters, snapshot, diff,
  parsePmset, linuxPower, powerHold, enabled, runCli, summarize, findIris, VaultAuto,
}

// Standalone: `node lib/vault-auto.js` runs the watcher on its own (logs to stdout). Used to prove
// it in a throwaway HOME without touching the real daemon; the daemon itself requires this module.
if (require.main === module) {
  const extra = process.argv.slice(2)
  const a = new VaultAuto({ extraArgs: extra }).start()
  console.log(`[vault-auto] watching ${a.platform} mounts every ${a.pollMs} ms (debounce ${a.debounceMs} ms), CLI: ${a.bin || 'NOT FOUND'}`)
  setInterval(() => {}, 1 << 30)
}
