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

/**
 * S2.3 — egress policy, taken from the script's own manifest.
 *
 * DENY IS THE DEFAULT AND AN UNKNOWN VALUE DENIES. Failing open on a value we do not
 * understand is how a typo (`egress=ture`) becomes unrestricted internet access for arbitrary
 * code. Only an explicit, recognised grant lifts the network lock.
 */
const EGRESS_GRANTS = new Set(['any', 'all', 'internet'])

function egressAllowed (manifest) {
  const v = manifest && typeof manifest.egress === 'string' ? manifest.egress.trim().toLowerCase() : null
  return v !== null && EGRESS_GRANTS.has(v)
}

/** Node policy from the environment, matching how the executor already reads its config. */
function nodePolicyFromEnv (env = process.env) {
  return {
    shared: env.IRIS_NODE_SHARED === '1',
    require_isolation: env.IRIS_REQUIRE_ISOLATION === '1'
  }
}

/**
 * Decide HOW a user script runs, and hand back the command — or a refusal.
 *
 * This is the whole S2.2 call site in one testable function, deliberately: the executor is
 * 4,000 lines and every capability that bought itself a branch in there is a capability nobody
 * can test. The executor's job is to call this and obey it.
 *
 * A REFUSAL RETURNS NO COMMAND. Not a command that happens to be safe, not a flag the caller
 * might forget to check — nothing to run. The only way to execute is to be handed something.
 */
function planScriptExecution (o) {
  const decision = decideExecution(o.policy || {}, o.isolation)
  const manifest = o.manifest || {}

  if (decision.mode === 'refused') {
    return { mode: 'refused', isolated: false, reason: decision.reason, cmd: null, args: null }
  }

  // The manifest may lower the timeout but not raise it past the sandbox ceiling; a script does
  // not get to grant itself more of the node than the node offers.
  const timeoutSeconds = Math.min(
    Number(manifest.timeout) > 0 ? Number(manifest.timeout) : DEFAULT_LIMITS.timeoutSeconds,
    DEFAULT_LIMITS.timeoutSeconds
  )

  if (decision.mode === 'sandboxed') {
    const built = buildSandboxCommand({
      runtime: o.runtime,
      scriptPath: o.scriptPath,
      outputDir: o.outputDir,
      allowNetwork: egressAllowed(manifest),
      env: o.env,
      limits: { ...(o.limits || {}), timeoutSeconds }
    })

    return { mode: 'sandboxed', isolated: true, reason: null, egressEnforced: true, ...built }
  }

  // HOST PATH — a personal node with no container runtime. It runs, and it says plainly that
  // nothing here is enforced. Reporting egress as applied when the script has the machine's
  // whole network would be a claim the system cannot back.
  const entry = {
    bash: ['/bin/bash', o.scriptPath],
    node: ['node', o.scriptPath],
    python: ['python3', o.scriptPath]
  }[o.runtime || 'bash'] || ['/bin/bash', o.scriptPath]

  return {
    mode: 'host',
    isolated: false,
    egressEnforced: false,
    reason: (o.isolation && o.isolation.reason) || null,
    cmd: entry[0],
    args: entry.slice(1),
    timeoutMs: timeoutSeconds * 1000
  }
}

module.exports = {
  planScriptExecution,
  nodePolicyFromEnv,
  egressAllowed,
  buildSandboxCommand,
  isolationRequired,
  decideExecution,
  DEFAULT_LIMITS,
  RUNTIME_IMAGES
}
