'use strict'

/**
 * Two ways a Hive task could outlive its purpose, found in the #188351 headless-prompt audit
 * (2026-10-08):
 *
 * 1. STDIN LEFT OPEN. The direct-spawn path piped stdin and only closed it when there was a
 *    payload. `iris run` (OpenCode's run) reads piped stdin when it is not a TTY, so it waited
 *    for an EOF that never came — measured: still running at 40 s on a "reply OK" prompt, while
 *    the same command with stdin closed answered in 10 s. The tmux path hid it (tmux is a TTY).
 *
 * 2. SIGKILL NEVER SENT. Timeouts did `kill('SIGTERM')`, then 5 s later
 *    `if (!child.killed) kill('SIGKILL')`. `child.killed` is true once the SIGTERM was DELIVERED,
 *    not once the process EXITED, so the SIGKILL branch was dead code — and the OpenCode TUI
 *    ignores SIGTERM (measured: alive 60 s after `timeout 20`). A timed-out task kept running.
 */

/** Close the child's stdin so a program that reads it sees EOF instead of waiting forever. */
function closeStdin (child, payload = null) {
  if (!child || !child.stdin) return
  child.stdin.on('error', () => { /* the child exited before reading — its exit code says why */ })
  if (payload !== null && payload !== undefined) child.stdin.end(payload)
  else child.stdin.end()
}

/** Has the process actually ended? (`child.killed` only means a signal was delivered.) */
function hasExited (child) {
  return child.exitCode !== null || child.signalCode !== null
}

/** SIGTERM now; SIGKILL after `graceMs` if it is still running. Returns the escalation timer. */
function killWithEscalation (child, graceMs = 5000) {
  if (!child || hasExited(child)) return null
  try { child.kill('SIGTERM') } catch { /* already gone */ }
  const t = setTimeout(() => {
    if (!hasExited(child)) {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
  }, graceMs)
  if (typeof t.unref === 'function') t.unref()
  return t
}

module.exports = { closeStdin, hasExited, killWithEscalation }
