const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { buildSandboxCommand, isolationRequired, decideExecution, DEFAULT_LIMITS } = require('../daemon/sandbox')

/**
 * S2.2 — per-run isolation, the gate on the whole Hive Functions epic.
 *
 * A `user_script` currently runs as `/bin/bash <path>` on the host, inside a "workspace" that
 * is only a directory. This daemon holds IRIS_API_KEY and FL_API_TOKEN in its environment, may
 * hold Full Disk Access, and can write files to other machines over the tailnet. A script that
 * inherits that environment inherits the fleet.
 */

const base = { runtime: 'bash', scriptPath: '/tmp/x/user-script.sh', outputDir: '/tmp/x/.output' }
const argsOf = (o = {}) => buildSandboxCommand({ ...base, ...o }).args
const has = (args, flag, value) => {
  const i = args.indexOf(flag)
  return i !== -1 && (value === undefined || args[i + 1] === value)
}

describe('the container gets nothing it was not handed', () => {
  it('INHERITS NO ENVIRONMENT by default', () => {
    // The single most important property. The daemon's env holds fleet credentials.
    const args = argsOf()
    assert.equal(args.filter((a) => a === '-e').length, 0)
  })

  it('passes only env explicitly handed to it', () => {
    const args = argsOf({ env: { CASE_ID: '42' } })
    assert.ok(args.includes('CASE_ID=42'))
    assert.equal(args.filter((a) => a === '-e').length, 1)
  })

  it('refuses an env name that could smuggle shell syntax', () => {
    assert.throws(() => buildSandboxCommand({ ...base, env: { 'BAD;NAME': '1' } }), /unsafe env name/)
  })

  it('has NO NETWORK unless egress was granted', () => {
    assert.ok(has(argsOf(), '--network', 'none'))
    assert.ok(!has(argsOf({ allowNetwork: true }), '--network', 'none'))
  })
})

describe('blast radius', () => {
  it('drops all capabilities and forbids regaining them', () => {
    const args = argsOf()
    assert.ok(has(args, '--cap-drop', 'ALL'))
    assert.ok(has(args, '--security-opt', 'no-new-privileges'))
  })

  it('runs as a non-root user', () => {
    // A container escape should land as nobody, not root.
    assert.ok(has(argsOf(), '--user', '65534:65534'))
  })

  it('mounts a read-only root and the script read-only', () => {
    const args = argsOf()
    assert.ok(args.includes('--read-only'))
    assert.ok(args.some((a) => a.endsWith('/run/user-script.sh:ro')))
  })

  it('caps cpu, memory, swap and pids', () => {
    const args = argsOf()
    assert.ok(has(args, '--cpus', DEFAULT_LIMITS.cpus))
    assert.ok(has(args, '--memory', DEFAULT_LIMITS.memory))
    // Without matching memory-swap the memory cap is escapable via swap.
    assert.ok(has(args, '--memory-swap', DEFAULT_LIMITS.memory))
    // A fork bomb is one line of bash.
    assert.ok(has(args, '--pids-limit', String(DEFAULT_LIMITS.pids)))
  })

  it('always removes the container', () => {
    assert.ok(argsOf().includes('--rm'))
  })

  it('rejects a relative script path rather than resolving it somewhere surprising', () => {
    assert.throws(() => buildSandboxCommand({ ...base, scriptPath: 'user-script.sh' }), /absolute/)
  })

  it('refuses a runtime it has no image for', () => {
    assert.throws(() => buildSandboxCommand({ ...base, runtime: 'brainfuck' }), /no sandbox image/)
  })
})

describe('who must be isolated', () => {
  it('a shared or server node always must', () => {
    assert.equal(isolationRequired({ shared: true }), true)
    assert.equal(isolationRequired({ role: 'server' }), true)
  })

  it('a personal node may opt in', () => {
    assert.equal(isolationRequired({}), false)
    assert.equal(isolationRequired({ require_isolation: true }), true)
  })

  it('an UNKNOWN node is assumed to need it', () => {
    // Guessing wrong in this direction costs a refusal; guessing wrong the other way runs
    // someone else's bash on a machine holding the fleet's credentials.
    assert.equal(isolationRequired(null), true)
    assert.equal(isolationRequired(undefined), true)
  })
})

describe('the refusal — the rule everything else stands on', () => {
  it('NEVER falls back to the host when isolation is required', () => {
    // A sandbox that silently degrades is worse than no sandbox: the manifest, the routing
    // gate and the page seam are all built believing it holds.
    const d = decideExecution({ shared: true }, { available: false, reason: 'docker daemon not running' })
    assert.equal(d.mode, 'refused')
    assert.equal(d.isolated, false)
    assert.match(d.reason, /docker daemon not running/)
  })

  it('an UNMEASURABLE runtime is also a refusal, not a pass', () => {
    // available:null means the probe could not tell. Not knowing is not permission.
    const d = decideExecution({ shared: true }, { available: null, reason: 'probe failed' })
    assert.equal(d.mode, 'refused')
  })

  it('a missing probe result is a refusal', () => {
    assert.equal(decideExecution({ shared: true }, undefined).mode, 'refused')
  })

  it('sandboxes when it can', () => {
    const d = decideExecution({ shared: true }, { available: true })
    assert.equal(d.mode, 'sandboxed')
    assert.equal(d.isolated, true)
  })

  it('a personal node still PREFERS the sandbox when one is available', () => {
    assert.equal(decideExecution({}, { available: true }).mode, 'sandboxed')
  })

  it('a personal node without a runtime runs on the host, and says it is not isolated', () => {
    const d = decideExecution({}, { available: false, reason: 'none' })
    assert.equal(d.mode, 'host')
    assert.equal(d.isolated, false)
  })
})
