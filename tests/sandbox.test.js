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

// ── S2.2 wiring + S2.3 egress ────────────────────────────────────────────────

const { planScriptExecution, nodePolicyFromEnv } = require('../daemon/sandbox')

const plan = (o = {}) =>
  planScriptExecution({
    runtime: 'bash',
    scriptPath: '/tmp/x/user-script.sh',
    outputDir: '/tmp/x/.output',
    manifest: {},
    policy: {},
    isolation: { available: true },
    ...o
  })

describe('planScriptExecution — the call site', () => {
  it('sandboxes when a runtime is available', () => {
    const p = plan()
    assert.equal(p.mode, 'sandboxed')
    assert.equal(p.cmd, 'docker')
  })

  it('runs on the host on a personal node with no runtime, and SAYS it is unisolated', () => {
    const p = plan({ isolation: { available: false, reason: 'not running' } })
    assert.equal(p.mode, 'host')
    assert.equal(p.isolated, false)
    assert.equal(p.cmd, '/bin/bash')
  })

  it('REFUSES on a shared node with no runtime — it never silently runs unisolated', () => {
    const p = plan({ policy: { shared: true }, isolation: { available: false, reason: 'not running' } })
    assert.equal(p.mode, 'refused')
    assert.ok(!p.cmd, 'a refusal must not hand back a runnable command')
    assert.match(p.reason, /not running/)
  })

  it('honours the manifest timeout, bounded', () => {
    assert.equal(plan({ manifest: { timeout: 30 } }).timeoutMs, 30000)
  })
})

describe('S2.3 — egress policy comes from the manifest', () => {
  it('DENIES network by default — a script that did not ask does not get it', () => {
    assert.ok(plan().args.includes('none'))
  })

  it('grants egress only when the manifest asked for it', () => {
    const p = plan({ manifest: { egress: 'any' } })
    assert.ok(!p.args.includes('none'), 'egress=any must lift --network none')
  })

  it('an unrecognised egress value denies rather than opens', () => {
    // Failing open on a value we do not understand is how a typo becomes internet access
    // for arbitrary code.
    const p = plan({ manifest: { egress: 'sure-why-not' } })
    assert.ok(p.args.includes('none'))
  })

  it('egress is irrelevant on the host path and does not silently claim to apply', () => {
    const p = plan({ manifest: { egress: 'none' }, isolation: { available: false } })
    assert.equal(p.mode, 'host')
    assert.equal(p.egressEnforced, false)
  })
})

describe('node policy from env', () => {
  it('a plain laptop requires nothing', () => {
    assert.equal(nodePolicyFromEnv({}).shared, false)
  })

  it('IRIS_NODE_SHARED=1 makes isolation mandatory', () => {
    assert.equal(nodePolicyFromEnv({ IRIS_NODE_SHARED: '1' }).shared, true)
  })

  it('IRIS_REQUIRE_ISOLATION=1 opts a personal node in', () => {
    assert.equal(nodePolicyFromEnv({ IRIS_REQUIRE_ISOLATION: '1' }).require_isolation, true)
  })
})

// ── S2.4 warm path ───────────────────────────────────────────────────────────

const { imagesToWarm, planWarmup } = require('../daemon/sandbox')

describe('S2.4 — a page-invoked action cannot wait for a cold pull', () => {
  it('warms every runtime image the sandbox can be asked for', () => {
    // A cold `docker run` pulls hundreds of MB on first use. The epic's constraint is that a
    // page-invoked action cannot wait 30s for that.
    const imgs = imagesToWarm()
    assert.ok(imgs.length >= 3)
    assert.ok(imgs.some((i) => i.startsWith('alpine')))
  })

  it('does nothing when there is no container runtime — no pointless pulls, no errors', () => {
    const p = planWarmup({ available: false, reason: 'not running' })
    assert.equal(p.shouldWarm, false)
    assert.deepEqual(p.images, [])
  })

  it('warms when a runtime IS available', () => {
    const p = planWarmup({ available: true })
    assert.equal(p.shouldWarm, true)
    assert.ok(p.images.length > 0)
  })

  it('an UNKNOWN runtime state does not trigger a warmup', () => {
    // Same rule as everywhere else here: not knowing is not a yes.
    assert.equal(planWarmup({ available: null }).shouldWarm, false)
    assert.equal(planWarmup(undefined).shouldWarm, false)
  })
})
