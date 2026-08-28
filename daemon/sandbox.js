'use strict'

/**
 * S2.2 — per-run isolation. The gate on the whole Hive Functions epic.
 *
 * Today a `user_script` runs as `/bin/bash <path>` directly on the host, in a directory called
 * a "workspace" that is only a directory. On your own laptop that is a choice you made about
 * your own machine. On a SHARED server node executing other people's scripts it is not a
 * feature, it is a liability — the epic says so plainly, and the reason is this daemon's
 * ambient authority:
 *
 *   - it holds IRIS_API_KEY, FL_API_TOKEN and node credentials in its environment and in
 *     ~/.iris (the beta audit found several of those on disk at 0644)
 *   - on macOS it may hold FULL DISK ACCESS, which is why the S1 probe exists at all
 *   - it can reach the tailnet, and `hive fs push` writes files to other people's machines
 *
 * A script inheriting that environment inherits the fleet. So the container gets NOTHING it is
 * not explicitly handed.
 *
 * THE ONE RULE THAT MATTERS MOST: there is no fallback to host execution. If isolation is
 * required and unavailable, the run FAILS and says why. A sandbox that silently degrades to
 * running unsandboxed is worse than no sandbox, because everything downstream — the manifest,
 * the routing gate, the page seam — is built believing it holds.
 */

const path = require('path')

/** Defaults chosen to be boring and survivable, not generous. */
const DEFAULT_LIMITS = {
  cpus: '1',
  memory: '512m',
  pids: 128,
  timeoutSeconds: 300
}

/** Images per runtime. Pinned by digest-able tag rather than `latest`, which is not a version. */
const RUNTIME_IMAGES = {
  bash: 'alpine:3.20',
  node: 'node:22-alpine',
  python: 'python:3.12-alpine'
}

const RUNTIME_ENTRY = {
  bash: (f) => ['/bin/sh', f],
  node: (f) => ['node', f],
  python: (f) => ['python3', f]
}

/**
 * Build the `docker run` invocation for one script.
 *
 * Every flag here is load-bearing; the comments say which failure each one prevents, because
 * the next person to "simplify" this will otherwise remove the ones that look redundant.
 *
 * @param {object} o
 * @param {string} o.runtime    bash | node | python
 * @param {string} o.scriptPath absolute path to the script on the host
 * @param {string} o.outputDir  host dir the script may write results into
 * @param {object} [o.limits]   { cpus, memory, pids, timeoutSeconds }
 * @param {boolean} [o.allowNetwork] opt IN to egress (S2.3); default is none
 * @param {object} [o.env]      explicit env to hand in; NOTHING is inherited
 */
function buildSandboxCommand (o) {
  const runtime = o.runtime || 'bash'
  const image = RUNTIME_IMAGES[runtime]
  if (!image) throw new Error(`no sandbox image for runtime '${runtime}'`)
  if (!o.scriptPath || !path.isAbsolute(o.scriptPath)) {
    throw new Error('scriptPath must be an absolute host path')
  }

  const limits = { ...DEFAULT_LIMITS, ...(o.limits || {}) }
  const scriptName = path.basename(o.scriptPath)

  const args = [
    'run',
    // Never leave a container behind. A runner that accumulates dead containers fills the
    // disk, and a full disk on this machine has already taken down a build today.
    '--rm',

    // NO NETWORK unless the script asked for it and was granted it. Default-deny is the only
    // safe default for arbitrary code; S2.3 turns this on per manifest.
    ...(o.allowNetwork ? [] : ['--network', 'none']),

    // Hard caps. Without these one run starves every other task on the node, and "the fleet is
    // slow" is a much harder thing to diagnose than "this run was killed for using 4GB".
    '--cpus', String(limits.cpus),
    '--memory', String(limits.memory),
    '--memory-swap', String(limits.memory), // no swap escape hatch past the memory cap
    '--pids-limit', String(limits.pids),    // a fork bomb is one line of bash

    // Drop every capability and forbid regaining any. A script does not need to mount, change
    // ownership, or load kernel modules.
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',

    // Non-root inside the container, so a container escape lands as nobody rather than root.
    '--user', '65534:65534',

    // Read-only root filesystem with a small writable tmpfs. Anything the script needs to keep
    // goes to the mounted output dir, which makes "what did this run produce" answerable.
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',

    // The script itself, read-only. It is code to execute, not data to edit.
    '-v', `${o.scriptPath}:/run/${scriptName}:ro`
  ]

  if (o.outputDir) {
    if (!path.isAbsolute(o.outputDir)) throw new Error('outputDir must be an absolute host path')
    args.push('-v', `${o.outputDir}:/out:rw`)
  }

  // ENV IS EXPLICIT, ALWAYS. Docker inherits nothing by default, and we add nothing by
  // default — this is what stops a script reading the daemon's IRIS_API_KEY out of its own
  // environment. Anything a script legitimately needs is handed to it deliberately (S2 secrets).
  for (const [k, v] of Object.entries(o.env || {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(k)) throw new Error(`refusing unsafe env name '${k}'`)
    args.push('-e', `${k}=${v}`)
  }

  args.push('--workdir', '/out')
  args.push(image)
  args.push(...RUNTIME_ENTRY[runtime](`/run/${scriptName}`))

  return { cmd: 'docker', args, timeoutMs: limits.timeoutSeconds * 1000 }
}

/**
 * Must this run be isolated?
 *
 * A node that serves OTHER PEOPLE'S scripts must always isolate. A personal machine may opt in.
 * The decision is the NODE's, not the script's — a script cannot be trusted to say whether it
 * deserves a sandbox.
 */
function isolationRequired (node) {
  if (!node || typeof node !== 'object') return true // unknown node: assume the strict case
  if (node.shared === true || node.role === 'server') return true
  return node.require_isolation === true
}

/**
 * Decide how a run may proceed. Returns either an approval or a REFUSAL — never a downgrade.
 *
 * @param {object} node       { shared?, role?, require_isolation? }
 * @param {object} isolation  the probe result: { available: true|false|null, reason }
 */
function decideExecution (node, isolation) {
  const required = isolationRequired(node)
  const available = isolation && isolation.available === true

  if (!required) {
    return { mode: available ? 'sandboxed' : 'host', isolated: available, reason: null }
  }

  if (available) return { mode: 'sandboxed', isolated: true, reason: null }

  // THE REFUSAL. Not a warning, not a downgrade. Everything above this layer — the manifest,
  // the routing gate, the page seam — is built believing isolation holds where it is required,
  // and quietly running on the host would make all of it a lie at once.
  const why = (isolation && isolation.reason) || 'no container runtime detected'

  return {
    mode: 'refused',
    isolated: false,
    reason: `this node requires per-run isolation and none is available: ${why}`
  }
}

module.exports = {
  buildSandboxCommand,
  isolationRequired,
  decideExecution,
  DEFAULT_LIMITS,
  RUNTIME_IMAGES
}
