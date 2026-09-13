// `iris-daemon` had no doctor (#185141), and iris-daemon/iris-bridge are two
// control surfaces over ONE process with no shared self-check (#185142). The cost
// showed up on 2026-09-13: launchd's child and the :3200 listener were different
// processes, `kickstart -k` returned 0 three times without replacing the one
// serving, and /health answered 200 from the stale orphan the whole time. A fix
// was then "verified live" on a process that had never loaded it (#185150).
//
// So every check here must be able to say NO. evaluate() is pure — facts are
// injected — because a doctor that can only be run on a healthy machine has never
// been tested on the case it exists for.

const test = require('node:test')
const assert = require('node:assert')
const { evaluate, CHECKS } = require('../lib/daemon-doctor')

// A machine where everything is right.
function healthy () {
  return {
    launchdPid: 4242,
    portHolderPid: 4242,
    bridgeProcessPids: [4242],
    processStartedMs: Date.parse('2026-09-13T19:00:00Z'),
    newestCodeMs: Date.parse('2026-09-13T18:00:00Z'),
    healthStatus: 200,
    config: { parsed: true, mode: 0o600, keys: ['api_url', 'node_api_key', 'node_id', 'user_id'] },
    watchdogKills: { sinceStart: 0, historical: 0 },
    stdoutLogBytes: 5 * 1024 * 1024
  }
}

const byId = (res, id) => res.checks.find(c => c.id === id)

test('a healthy machine passes every check', () => {
  const res = evaluate(healthy())
  const failed = res.checks.filter(c => c.status === 'fail')
  assert.deepStrictEqual(failed.map(c => c.id), [], 'no check may fail on a healthy machine')
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.exitCode, 0)
})

test('every check is exercised by at least one failing fixture', () => {
  // Guards against adding a check that can never go red — the exact defect this
  // whole file is about.
  const broken = {
    launchd_pid_is_port_holder: { ...healthy(), launchdPid: 1, portHolderPid: 2, bridgeProcessPids: [1, 2] },
    single_executor: { ...healthy(), bridgeProcessPids: [4242, 5555] },
    running_code_is_current: { ...healthy(), newestCodeMs: Date.parse('2026-09-13T20:00:00Z') },
    health_responds: { ...healthy(), healthStatus: 503 },
    config_valid: { ...healthy(), config: { parsed: false, mode: 0o600, keys: [] } },
    watchdog_quiet: { ...healthy(), watchdogKills: { sinceStart: 7, historical: 54 } },
    log_rotation: { ...healthy(), stdoutLogBytes: 400 * 1024 * 1024 }
  }
  for (const c of CHECKS) {
    assert.ok(broken[c.id], `check "${c.id}" has no failing fixture — it may be unfalsifiable`)
    const res = evaluate(broken[c.id])
    assert.strictEqual(byId(res, c.id).status, 'fail',
      `check "${c.id}" did not go red on its own broken fixture`)
  }
})

test('split brain is reported with BOTH pids, because one pid explains nothing', () => {
  const res = evaluate({ ...healthy(), launchdPid: 83810, portHolderPid: 67934, bridgeProcessPids: [83810, 67934] })
  const c = byId(res, 'launchd_pid_is_port_holder')
  assert.strictEqual(c.status, 'fail')
  assert.match(c.detail, /83810/)
  assert.match(c.detail, /67934/)
  assert.strictEqual(res.ok, false)
  assert.notStrictEqual(res.exitCode, 0, 'a split brain must fail the exit code, not just print')
})

test('stale code is detected by TIME, not by grepping for a symbol', () => {
  // Grepping for a new symbol reports "deployed" whenever the symbol already
  // existed. Comparing the process start to the newest file cannot do that.
  const res = evaluate({
    ...healthy(),
    processStartedMs: Date.parse('2026-09-13T18:18:28Z'),
    newestCodeMs: Date.parse('2026-09-13T18:21:34Z')
  })
  const c = byId(res, 'running_code_is_current')
  assert.strictEqual(c.status, 'fail')
  assert.match(c.detail, /restart/i, 'must say what to do about it')
})

test('a 200 from /health does NOT excuse a split brain or stale code', () => {
  // The specific way tonight went wrong: health was green throughout.
  const res = evaluate({
    ...healthy(),
    healthStatus: 200,
    launchdPid: 1, portHolderPid: 2, bridgeProcessPids: [1, 2],
    newestCodeMs: Date.parse('2026-09-14T00:00:00Z')
  })
  assert.strictEqual(byId(res, 'health_responds').status, 'pass')
  assert.strictEqual(res.ok, false, 'health being green must not make the overall verdict green')
})

test('an unmeasurable fact is UNKNOWN, never a pass', () => {
  // A daemon that is not running at all cannot be pronounced healthy.
  const res = evaluate({ ...healthy(), portHolderPid: null, launchdPid: null, bridgeProcessPids: [] })
  const statuses = res.checks.map(c => c.status)
  assert.ok(!statuses.includes('pass') || res.ok === false)
  assert.strictEqual(res.ok, false, 'nothing measured must not read as healthy')
  const c = byId(res, 'launchd_pid_is_port_holder')
  assert.ok(['fail', 'unknown'].includes(c.status), `got ${c.status}`)
})

test('config mode 0644 fails — the file holds a live node key', () => {
  const res = evaluate({ ...healthy(), config: { parsed: true, mode: 0o644, keys: ['node_api_key', 'user_id', 'node_id', 'api_url'] } })
  assert.strictEqual(byId(res, 'config_valid').status, 'fail')
})

test('no check ever prints a config VALUE', () => {
  const res = evaluate({
    ...healthy(),
    config: { parsed: true, mode: 0o600, keys: ['node_api_key', 'user_id', 'node_id', 'api_url'], values: { node_api_key: 'node_live_SECRET' } }
  })
  const text = JSON.stringify(res)
  assert.ok(!text.includes('node_live_SECRET'), 'the doctor must never echo a credential')
})

// ---------------------------------------------------------------------------
// A LIFETIME kill count cannot distinguish "killed 54 times before you fixed it"
// from "killed 54 times today" — so the doctor would stay red forever after a fix
// that worked, and a red that never goes green is one nobody reads. The watchdog
// message now carries an ISO timestamp specifically so this can be bounded to the
// current boot.
// ---------------------------------------------------------------------------

test('kills that all PREDATE this boot do not fail the check', () => {
  const res = evaluate({ ...healthy(), watchdogKills: { sinceStart: 0, historical: 54 } })
  const c = byId(res, 'watchdog_quiet')
  assert.strictEqual(c.status, 'pass', '54 historical kills with none since boot is a fixed daemon, not a sick one')
  assert.match(c.detail, /54/, 'the history must still be visible, not hidden')
})

test('even ONE kill since this boot fails the check', () => {
  const res = evaluate({ ...healthy(), watchdogKills: { sinceStart: 1, historical: 54 } })
  assert.strictEqual(byId(res, 'watchdog_quiet').status, 'fail')
  assert.strictEqual(res.ok, false)
})

test('untimestamped kills cannot be bounded, so they are not silently forgiven', () => {
  // Lines written before the watchdog carried a timestamp. Counting them as
  // "not since boot" would be a guess dressed as a measurement.
  const res = evaluate({ ...healthy(), watchdogKills: { sinceStart: null, historical: 54 } })
  const c = byId(res, 'watchdog_quiet')
  assert.strictEqual(c.status, 'unknown', 'unbounded is unknown, never pass')
  assert.match(c.detail, /timestamp/i, 'must say WHY it cannot answer')
  assert.strictEqual(res.ok, false)
})
