'use strict'
const { execFileSync } = require('child_process')

/**
 * Git is NOT required to install IRIS or to run a Hive node. As of 2026-09-13 the
 * installers and `iris node install` fetch the daemon over plain HTTPS, because Git
 * was only ever moving bytes — clients were losing the whole node to a prerequisite
 * nothing actually read the history of.
 *
 * But two FEATURES still shell out to it for real work:
 *   - reference-repo indexing  (lib/references.js)
 *   - exchange / bounty tasks  (daemon/task-executor.js)
 *
 * Without this guard those produce `Command failed: git clone https://...` — the word
 * "git" appears, buried in an echoed command, with nothing to say that Git is a
 * MISSING PREREQUISITE the user can go and install. That is the same shape as the
 * incident this whole line of work came from (#184597): the installer skipped the
 * daemon for want of Node, said "installed successfully", and pointed at a command
 * that could not work. The failure was real and the reason was never named.
 *
 * So: check once, up front, and fail with a sentence someone can act on.
 */

let cached = null

/** Is a usable git on PATH? Cached — this is called per task, not per process. */
function gitAvailable () {
  if (cached !== null) return cached
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe', timeout: 5000 })
    cached = true
  } catch {
    cached = false
  }
  return cached
}

/**
 * Throw a message a person can act on, naming the feature that needed Git.
 * Returns nothing when Git is present.
 */
function requireGit (feature) {
  if (gitAvailable()) return
  const err = new Error(
    `${feature} needs Git, and Git is not installed on this machine.\n` +
    `  Install it: https://git-scm.com/downloads\n` +
    `  Nothing else about this node requires Git — installing IRIS and running the ` +
    `daemon do not. Only this feature does.`
  )
  err.code = 'GIT_MISSING'
  err.feature = feature
  throw err
}

/** For tests: forget the cached probe. */
function _resetGitCache () { cached = null }

module.exports = { gitAvailable, requireGit, _resetGitCache }
