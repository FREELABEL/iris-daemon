'use strict'

/**
 * Which program runs a `code_generation` task, and with what arguments.
 *
 * The task used to spawn `iris-code --non-interactive --prompt <p>`. No current install ships an
 * `iris-code` binary, and the old lookup returned the bare name 'iris-code' whenever nothing was
 * found on disk — so it never fell through, and every code_generation task died with
 * "iris-code: command not found" (exit 127). Found 2026-10-08 approving a meeting action (#188354).
 *
 * Now: a real `iris-code` keeps its own arguments (an old install still works). Otherwise the
 * `iris` CLI that every node has runs the prompt non-interactively: `iris run <prompt>`.
 */
const path = require('path')

function candidates (home) {
  return {
    legacy: ['/usr/local/bin/iris-code', '/usr/bin/iris-code', path.join(home, '.local/bin/iris-code')],
    iris: [path.join(home, '.iris/bin/iris'), '/usr/local/bin/iris', '/usr/bin/iris', path.join(home, '.local/bin/iris')]
  }
}

/**
 * @param {string} prompt
 * @param {{ exists?: (p: string) => boolean, home?: string }} [opts]
 * @returns {{ cmd: string, args: string[], via: 'iris-code' | 'iris' }}
 */
function agentCommand (prompt, opts = {}) {
  const exists = opts.exists || ((p) => { try { return require('fs').existsSync(p) } catch { return false } })
  const c = candidates(opts.home || process.env.HOME || '')
  const legacy = c.legacy.find(exists)
  if (legacy) return { cmd: legacy, args: ['--non-interactive', '--prompt', prompt], via: 'iris-code' }
  // The installer puts `iris` on PATH; a bare name lets the spawn resolve it when none of the
  // usual locations exist (Homebrew, a custom prefix).
  const iris = c.iris.find(exists) || 'iris'
  return { cmd: iris, args: ['run', prompt], via: 'iris' }
}

/** First executable named `name` on PATH, or null. */
function onPath (name, env = process.env, exists) {
  const fs = require('fs')
  const ok = exists || ((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true } catch { return false } })
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (dir && ok(path.join(dir, name))) return path.join(dir, name)
  }
  return null
}

/**
 * The `opencode` runtime (#188351). The executor ran `opencode --non-interactive --prompt <p>`:
 * OpenCode has no --non-interactive flag (it printed its help and exited 1 on every task), and its
 * top-level --prompt starts the interactive TUI — which, with no TTY, never exits and ignores
 * SIGTERM. The non-interactive form is `opencode run <message>`. No OpenCode on the node: the
 * node's own `iris` (an OpenCode build) runs it the same way.
 */
function opencodeCommand (prompt, opts = {}) {
  const found = opts.opencode !== undefined ? opts.opencode : onPath('opencode', opts.env)
  if (found) return { cmd: found, args: ['run', prompt], via: 'opencode' }
  return agentCommand(prompt, opts)
}

module.exports = { agentCommand, opencodeCommand, onPath }
