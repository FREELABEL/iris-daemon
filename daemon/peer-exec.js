'use strict'

/**
 * peer_exec — a Hive peer running a shell command on this machine.
 *
 * This is the strongest thing a connection can do, and it is gated behind the `terminal`
 * permission the machine's owner grants explicitly. Note the deliberate asymmetry with file
 * browsing: `peer_file_browse` is confined to the daemon's share directory with a traversal
 * guard, while this is not confined at all. That is not an oversight — `files` lets a peer
 * read a share, `terminal` gives them the machine. Anyone granting it should understand that
 * is what they are granting.
 *
 * WHY THIS FILE EXISTS. The original ran execSync inline in the task switch, which had two
 * compounding problems:
 *
 *   1. execSync BLOCKS THE EVENT LOOP. The heartbeat runs in this same process, and the
 *      daemon collects pending work on that heartbeat — so a peer command froze the node for
 *      its whole duration, made it look offline to the hub, and stopped it picking up
 *      anything else. A capability meant to help someone could take their node down.
 *   2. The timeout was capped at 60s — shorter than a real `brew install`. The stated purpose
 *      of the capability is helping someone set a machine up, and the cap killed exactly
 *      that, halfway, which is how you end up with a half-installed package.
 */

/**
 * The ceiling on a single peer command.
 *
 * Long enough for a real install; still a ceiling, because unbounded would let a peer hold a
 * slot on someone else's machine indefinitely. The timeout is what makes the grant revocable
 * in practice rather than only on paper.
 */
const PEER_EXEC_MAX_SECONDS = 600

/** Used when a caller says nothing. Short on purpose: most peer commands are a version check. */
const PEER_EXEC_DEFAULT_SECONDS = 30

/**
 * Pure. Decide what runs, where, and for how long — separately from running it, so the policy
 * is testable without spawning anything.
 *
 * @returns {{ok: boolean, command?: string, cwd?: string, timeoutMs?: number, reason?: string}}
 */
function planPeerExec (task, defaults = {}) {
  const cfg = (task && task.config) || {}
  const raw = cfg.command !== undefined ? cfg.command : (task && task.prompt)

  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: 'peer_exec requires config.command (a non-empty string)' }
  }

  // A nonsense timeout must not become NO timeout — falling back to the default is safe,
  // falling through to 0 would mean "no limit" in child_process and remove the ceiling.
  const asked = Number(task && task.timeout_seconds)
  const seconds = Number.isFinite(asked) && asked > 0
    ? Math.min(asked, PEER_EXEC_MAX_SECONDS)
    : PEER_EXEC_DEFAULT_SECONDS

  return {
    ok: true,
    command: raw,
    cwd: cfg.cwd || defaults.dataDir || process.env.WORKSPACE_DIR || process.cwd(),
    timeoutMs: seconds * 1000
  }
}

module.exports = { planPeerExec, PEER_EXEC_MAX_SECONDS, PEER_EXEC_DEFAULT_SECONDS }
