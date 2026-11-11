'use strict'

// What each live session's worktree has touched — the daemon's half of the board ↔ Hive overlap
// check (#193188, the Cursor Projects gap #193174).
//
// The rule itself runs on the server, because a daemon only sees its own machine and the point
// is to catch two PEOPLE (two machines) about to collide. This only reports, per working folder
// of a session that is `active` or `needs_you`:
//
//   { cwd, repo, branch, files }
//
//   repo   the `origin` remote — the identity two worktrees of one repo share (their folders differ)
//   files  repo-relative paths changed since the branch left the default branch (committed or
//          not), plus untracked files. That is "what this session is editing", not just what is
//          unsaved: work committed on the branch collides at merge just the same.
//
// Async with a timeout on every git call: a synchronous subprocess on the heartbeat would stall
// the daemon's event loop and the in-process server with it. Folders that are not a git repo
// (most sessions run in ~) cost one failed rev-parse and are skipped.

const { execFile } = require('child_process')

const LIVE = new Set(['active', 'needs_you'])
const MAX_FOLDERS = 20
const MAX_FILES = 200

function git (cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 10_000, maxBuffer: 4 << 20 }, (err, stdout) => resolve(err ? null : String(stdout)))
  })
}

const lines = (out) => (out || '').split('\n').map((l) => l.trim()).filter(Boolean)

/** The working folders worth asking about: distinct, live, newest first, capped. */
function liveFolders (sessions) {
  const out = []
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const cwd = s && typeof s.project_path === 'string' ? s.project_path.replace(/\/+$/, '') : ''
    if (!cwd || !LIVE.has(s.status) || out.includes(cwd)) continue
    out.push(cwd)
    if (out.length >= MAX_FOLDERS) break
  }
  return out
}

/** Where this branch left the default branch, or null when there is no remote default to ask. */
async function forkPoint (root, run) {
  const candidates = []
  const head = lines(await run(root, ['rev-parse', '--abbrev-ref', 'origin/HEAD']))[0]
  if (head && head !== 'origin/HEAD') candidates.push(head)
  candidates.push('origin/main', 'origin/master')
  for (const ref of candidates) {
    const mb = lines(await run(root, ['merge-base', 'HEAD', ref]))[0]
    if (mb) return mb
  }
  return null
}

/** One folder → its touched set, or null when it is not a git repo with an origin. */
async function touchedFor (cwd, run = git) {
  const root = lines(await run(cwd, ['rev-parse', '--show-toplevel']))[0]
  if (!root) return null
  const repo = lines(await run(root, ['remote', 'get-url', 'origin']))[0]
  if (!repo) return null // no remote = no identity to compare across machines
  const branch = lines(await run(root, ['rev-parse', '--abbrev-ref', 'HEAD']))[0] || null

  const base = await forkPoint(root, run)
  // Against the fork point: committed-on-branch AND uncommitted tracked changes in one list.
  // With no fork point, only what is uncommitted.
  const changed = lines(await run(root, base ? ['diff', '--name-only', base] : ['diff', '--name-only', 'HEAD']))
  const untracked = lines(await run(root, ['ls-files', '--others', '--exclude-standard']))

  const files = [...new Set([...changed, ...untracked])].slice(0, MAX_FILES)
  return { cwd, repo, branch, files }
}

/**
 * The `work_files` heartbeat field: one entry per live session folder that is a git repo.
 * Always an array once computed (an empty one means "looked, nothing live in a repo").
 */
async function collectWorkFiles (sessions, run = git) {
  const folders = liveFolders(sessions)
  const out = await Promise.all(folders.map((cwd) => touchedFor(cwd, run).catch(() => null)))
  return out.filter(Boolean)
}

module.exports = { collectWorkFiles, touchedFor, liveFolders, LIVE, MAX_FILES, MAX_FOLDERS }
