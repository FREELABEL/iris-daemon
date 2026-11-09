'use strict'

/**
 * Where the `claude` executable is on THIS machine (epic #192964, W4 R2).
 *
 * THE BUG THIS REPLACES: `const CLAUDE_BIN = process.env.CLAUDE_BIN || '/opt/homebrew/bin/claude'`.
 * That is where Homebrew puts it on an Apple-silicon Mac, and nowhere else. On iris-hive-001
 * (Linux, systemd, PATH=/home/…/.iris/bin:/usr/local/bin:/usr/bin:/bin) `claude` is
 * /usr/local/bin/claude, so every reply from a phone failed, 2026-11-09 17:55 and 17:58:
 *   [claude-code] Message failed: spawn /opt/homebrew/bin/claude ENOENT
 * and the task failed with curl (22) 500.
 *
 * Resolved at CALL time, never cached at startup: an install or upgrade that moves the binary
 * (npm → native installer, ~/.local/bin → /usr/local/bin) must not need a daemon restart.
 *
 * Order: an explicit CLAUDE_BIN that exists → every PATH entry → the places installers put it
 * when a service manager (launchd, systemd) hands the daemon a short PATH. An explicit CLAUDE_BIN
 * that does NOT exist is skipped and named in `tried`, so a stale override is visible, not fatal.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

function names (platform) {
  return platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude']
}

function fallbackDirs (home, platform) {
  if (platform === 'win32') {
    return [path.join(home, '.local', 'bin'), path.join(home, 'AppData', 'Roaming', 'npm')]
  }
  return [
    path.join(home, '.local', 'bin'), // the native installer
    path.join(home, '.claude', 'local'), // `claude migrate-installer`
    '/opt/homebrew/bin', // Homebrew, Apple silicon
    '/usr/local/bin', // Homebrew, Intel; npm -g; a symlink on Linux
    '/usr/bin'
  ]
}

function defaultIsExec (p) {
  try {
    const st = fs.statSync(p)
    if (!st.isFile()) return false
    if (process.platform === 'win32') return true
    fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch { return false }
}

/**
 * @param o.env       defaults to process.env
 * @param o.platform  defaults to process.platform
 * @param o.home      defaults to os.homedir()
 * @param o.isExec    (path) => boolean, injectable for tests
 * @returns {{ bin: string|null, tried: string[] }}
 */
function resolveClaudeBin (o = {}) {
  const env = o.env || process.env
  const platform = o.platform || process.platform
  const home = o.home || os.homedir()
  const isExec = o.isExec || defaultIsExec
  const delim = platform === 'win32' ? ';' : ':'
  const tried = []

  const explicit = String(env.CLAUDE_BIN || '').trim()
  if (explicit) {
    if (isExec(explicit)) return { bin: explicit, tried }
    tried.push(`${explicit} (CLAUDE_BIN, not there)`)
  }

  const dirs = String(env.PATH || '').split(delim).filter(Boolean).concat(fallbackDirs(home, platform))
  const seen = new Set()
  for (const dir of dirs) {
    if (seen.has(dir)) continue
    seen.add(dir)
    for (const n of names(platform)) {
      const p = path.join(dir, n)
      if (isExec(p)) return { bin: p, tried }
      tried.push(p)
    }
  }
  return { bin: null, tried }
}

/** The error a caller returns when there is no `claude` here: what was looked at, and the fix. */
function notFoundMessage (tried) {
  return `Claude Code (\`claude\`) is not installed where this daemon can see it. Looked in: ${tried.slice(0, 8).join(', ')}${tried.length > 8 ? ', …' : ''}. Install it, or set CLAUDE_BIN to its full path.`
}

module.exports = { resolveClaudeBin, notFoundMessage }
