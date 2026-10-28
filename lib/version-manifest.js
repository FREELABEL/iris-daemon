'use strict'

// WHICH COMMIT IS THIS DAEMON RUNNING (#191614).
//
// package.json says 2.0.0 and is never bumped, so `daemon_version` has been the same string on
// every node for months while the installed copies drifted apart: on 2026-10-28 iris-hive-001
// and -002 ran plain copies older than main, and the MacBook ran a git checkout 47 commits
// behind with local edits. Finding that out took per-machine forensics (hashing files against
// old versions). The commit SHA is the version.
//
// `iris daemon update` writes `.iris-daemon-version.json` into the bridge directory when it
// installs a commit:
//
//   { "schema": 1, "commit": "<40-hex sha>", "installed_at": "<iso>", "source": "...",
//     "files": { "<relative path>": "<sha256 hex>" } }
//
// `files` is exactly the commit's tree (no node_modules, no runtime files), so DRIFT means
// "a file the install shipped is no longer what it shipped": a hand edit, a hand-copied fix, a
// half-finished update. Runtime files the daemon writes (logs, tokens, caches) are not in the
// manifest and never count as drift.
//
// THE COMMIT IS READ ONCE, AT LOAD. The updater swaps directories under a running daemon
// (bridge -> bridge.prev, bridge.next -> bridge), so a lazy read would let the OLD process
// report the NEW commit — and "the running daemon reports the new commit" is exactly the
// check the updater relies on to decide whether to roll back. What a process reports must be
// what it loaded. Drift, by contrast, is re-checked: a swapped tree no longer matching what
// this process loaded is true, and worth saying.
//
// No manifest (every install before this change, and any git checkout) reports "unknown" for
// both — honestly, never a guess.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const MANIFEST_NAME = '.iris-daemon-version.json'
const UNKNOWN = 'unknown'
const DRIFT_TTL_MS = 5 * 60 * 1000

function sha256File (file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function isSha (s) {
  return typeof s === 'string' && /^[0-9a-f]{40}$/.test(s)
}

// The manifest, or null when there is none or it cannot be trusted (unparseable, no commit,
// no file list). A manifest we cannot read is treated like no manifest: "unknown".
function readManifest (dir) {
  let raw
  try { raw = fs.readFileSync(path.join(dir, MANIFEST_NAME), 'utf8') } catch { return null }
  let m
  try { m = JSON.parse(raw) } catch { return null }
  if (!m || !isSha(m.commit) || !m.files || typeof m.files !== 'object') return null
  return m
}

// Compare the files on disk with the manifest. Returns the paths that changed or vanished.
function checkDrift (dir, manifest) {
  const changed = []
  const missing = []
  for (const [rel, want] of Object.entries(manifest.files)) {
    const file = path.join(dir, rel)
    let got
    try { got = sha256File(file) } catch { missing.push(rel); continue }
    if (got !== want) changed.push(rel)
  }
  return { drift: changed.length + missing.length > 0, changed, missing }
}

// Walk a tree and hash every file, the way the updater builds a manifest. Excludes the
// manifest itself, .git and node_modules (dependencies are not part of a commit).
function hashTree (dir) {
  const files = {}
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (r === MANIFEST_NAME) continue
      const a = path.join(abs, e.name)
      if (e.isDirectory()) walk(a, r)
      else if (e.isFile()) files[r] = sha256File(a)
    }
  }
  walk(dir, '')
  return files
}

// One instance per process, frozen at construction (see the header).
function createReporter (dir, opts = {}) {
  const now = opts.now || Date.now
  const manifest = readManifest(dir)
  let cached = null
  let cachedAt = 0

  function drift () {
    if (!manifest) return UNKNOWN
    if (cached !== null && now() - cachedAt < DRIFT_TTL_MS) return cached
    try { cached = checkDrift(dir, manifest).drift } catch { cached = UNKNOWN }
    cachedAt = now()
    return cached
  }

  return {
    report () {
      return {
        daemon_commit: manifest ? manifest.commit : UNKNOWN,
        daemon_drift: drift(),
        daemon_installed_at: manifest && manifest.installed_at ? manifest.installed_at : null,
      }
    },
  }
}

// `daemon_version` is the field the hub already stores and serves (NodeTaskDispatcher +
// ComputeNodeController whitelist it); daemon_commit is not on those whitelists yet. Folding the
// commit into it as semver BUILD METADATA makes every node's commit visible in `iris hive nodes
// list` and the fleet view with no server change: "2.0.0+<sha>" or "2.0.0+<sha>.drift".
// Without a manifest the plain package version is sent, exactly as before.
function versionString (pkgVersion, report) {
  const v = pkgVersion || UNKNOWN
  if (!report || !isSha(report.daemon_commit)) return v
  return `${v}+${report.daemon_commit}${report.daemon_drift === true ? '.drift' : ''}`
}

let _default = null
// The reporter for THIS install (the directory this file was loaded from), created on first use
// — which the daemon does at startup, before any update can swap the tree.
function running () {
  if (!_default) _default = createReporter(path.join(__dirname, '..'))
  return _default
}

module.exports = { MANIFEST_NAME, UNKNOWN, readManifest, checkDrift, hashTree, createReporter, versionString, running, sha256File }
