'use strict'

/**
 * S1.2 — what this machine can actually DO, established by attempting it.
 *
 * THE RULE, and the reason this file exists at all:
 *
 *   Detect by ATTEMPTING the access, never by checking that a path exists.
 *
 * A TCC-blocked read on macOS does not error the way people expect. `existsSync` returns true
 * for a file the process cannot read, `accessSync(R_OK)` can pass on a path TCC will still
 * refuse, and some protected reads come back EMPTY rather than throwing. Every one of those
 * reports a healthy node that can read nothing — and a script that needs Full Disk Access then
 * lands there and returns a clean, confident, wrong answer: a case folder containing no
 * documents, because the folder could not be read rather than because it is empty.
 *
 * So each probe here performs the real operation and inspects the real result. Where a probe
 * cannot be run, it reports UNKNOWN — never `true`. An unmeasured permission and a granted one
 * must never be the same value, because the routing gate treats silence as refusal and that is
 * only safe if silence is honestly reported.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

/** SQLite files begin with this. Reading it proves the bytes really came back. */
const SQLITE_MAGIC = 'SQLite format 3'

/**
 * Full Disk Access — attempt to READ a TCC-protected file and verify the CONTENT.
 *
 * chat.db is the canonical protected artefact. We do not stat it, we do not `access()` it: we
 * open it and read the first bytes, then check they are the SQLite header. That distinguishes
 * all three real outcomes — granted, denied, and "the file is not there at all" — which
 * existence checks collapse into one.
 */
function probeFullDiskAccess (io = defaultIo) {
  if (io.platform() !== 'darwin') {
    // Not a macOS concept. Saying "unavailable" would send someone to a Settings pane that
    // does not exist on their OS.
    return unknown('full-disk-access is a macOS concept; not applicable on ' + io.platform())
  }

  const target = path.join(io.homedir(), 'Library', 'Messages', 'chat.db')
  let fd = null
  try {
    fd = io.open(target, 'r')
    const buf = Buffer.alloc(SQLITE_MAGIC.length)
    const bytes = io.read(fd, buf)

    // EMPTY IS NOT OK. A protected read that yields zero bytes is the exact failure this
    // probe exists to catch, and it is indistinguishable from success to anything that only
    // checks for a thrown error.
    if (!bytes) {
      return no('read returned 0 bytes — TCC is blocking it silently')
    }
    if (buf.toString('utf8', 0, SQLITE_MAGIC.length) !== SQLITE_MAGIC) {
      return no('read did not return the expected file contents')
    }
    return yes()
  } catch (e) {
    const code = e && e.code
    if (code === 'EPERM' || code === 'EACCES') {
      return no('denied by macOS privacy (grant Full Disk Access to the terminal/daemon, then restart it)')
    }
    if (code === 'ENOENT') {
      // Genuinely different: nothing to read, so this tells us nothing about the permission.
      return unknown('no Messages database on this machine — cannot determine Full Disk Access from it')
    }
    return no(`could not read the protected file: ${code || (e && e.message) || 'unknown error'}`)
  } finally {
    if (fd !== null) { try { io.close(fd) } catch { /* best effort */ } }
  }
}

/**
 * Browser — RUN it. A path that exists is not a browser that launches; a quarantined or
 * half-installed app satisfies every existence check and fails the first real invocation.
 */
const BROWSER_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
]

function probeBrowser (io = defaultIo) {
  const errors = []
  for (const bin of BROWSER_CANDIDATES) {
    try {
      const out = io.exec(bin, ['--version'], 2500)
      if (out && /\d+\.\d+/.test(out)) {
        return yes(out.trim().slice(0, 60))
      }
      errors.push(`${path.basename(bin)}: ran but reported no version`)
    } catch (e) {
      const code = e && e.code
      if (code !== 'ENOENT') errors.push(`${path.basename(bin)}: ${code || (e && e.message)}`)
    }
  }
  return no(errors.length ? errors.join('; ').slice(0, 160) : 'no browser executable responded to --version')
}

/**
 * Per-run isolation (S2.2) — can this machine actually run a container?
 *
 * `which docker` is the wrong question, and it is the same class of mistake as `existsSync` for
 * Full Disk Access: the CLI is present on this machine right now while the daemon behind it is
 * not running, so a presence check reports an isolation capability that cannot isolate
 * anything. `docker info` talks to the daemon, so it fails when the daemon is down — which is
 * the state that matters.
 */
function probeIsolation (io = defaultIo) {
  try {
    const out = io.exec('docker', ['info', '--format', '{{.ServerVersion}}'], 5000)
    const version = (out || '').trim()
    if (!version) return no('docker responded but reported no server version')
    return yes(`docker ${version}`)
  } catch (e) {
    const code = e && e.code
    if (code === 'ENOENT') return no('no container runtime installed')
    // A non-zero exit from `docker info` is almost always "daemon not running", and saying so
    // is more useful than the raw stderr, which is a paragraph about a socket path.
    return no('container runtime installed but not running (start Docker/OrbStack)')
  }
}

/**
 * Network egress — make a real outbound request. Reading a config value or an interface list
 * says what the machine is configured to do, not what it can do from behind this firewall.
 */
async function probeNetwork (io = defaultIo) {
  try {
    const ok = await io.reach('https://api.github.com', 4000)
    return ok ? yes() : no('outbound HTTPS request did not succeed')
  } catch (e) {
    return no(`outbound HTTPS failed: ${(e && e.message) || 'unknown error'}`)
  }
}

/**
 * Run every probe. Returns the map the heartbeat advertises.
 *
 * A probe that THROWS becomes `unknown` with the error, never a silent omission and never
 * `false`: "the probe broke" is not "the permission is absent", and an operator sent to fix the
 * wrong one of those loses an afternoon.
 */
async function probePermissions (io = defaultIo) {
  const at = io.now()
  const out = {}

  const run = async (name, fn) => {
    try {
      out[name] = { ...(await fn(io)), checked_at: at }
    } catch (e) {
      out[name] = { ...unknown(`probe failed: ${(e && e.message) || 'unknown error'}`), checked_at: at }
    }
  }

  await run('full-disk-access', probeFullDiskAccess)
  await run('browser', probeBrowser)
  await run('network', probeNetwork)
  await run('isolation', probeIsolation)

  return out
}

// ─── result shapes ──────────────────────────────────────────────
// `available` is a TRISTATE by way of null: true / false / null(unknown). The routing gate
// treats anything that is not exactly true as unsatisfied, so an unknown is safe — but it is
// reported as unknown so the REASON can say we could not measure rather than that it is absent.
const yes = (detail = null) => ({ available: true, reason: null, detail })
const no = (reason) => ({ available: false, reason })
const unknown = (reason) => ({ available: null, reason })

const defaultIo = {
  platform: () => process.platform,
  homedir: () => os.homedir(),
  now: () => new Date().toISOString(),
  open: (p, flags) => fs.openSync(p, flags),
  read: (fd, buf) => fs.readSync(fd, buf, 0, buf.length, 0),
  close: (fd) => fs.closeSync(fd),
  exec: (bin, args, timeout) => execFileSync(bin, args, { timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
  reach: async (url, timeout) => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeout)
    try {
      const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal })
      return !!res && res.status > 0
    } finally {
      clearTimeout(t)
    }
  }
}

module.exports = { probePermissions, probeFullDiskAccess, probeBrowser, probeNetwork, probeIsolation, defaultIo, SQLITE_MAGIC }
