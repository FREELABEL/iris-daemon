const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

// The REAL module. tests/execute-script.test.js keeps a hand-copied duplicate of the handler
// ("copied from daemon/index.js") which has already drifted from production — it hardcodes
// duration_ms to 0 and never merges env. Those tests are green against code that does not ship.
// Everything here imports what the daemon actually runs.
const {
  runScript, clampTimeout, isPlainFilename, TailBuffer,
  DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, STDOUT_CAP
} = require('../daemon/script-runner')

let tmpDir
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-runner-')) })
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {} })

const run = (content, opts = {}) =>
  runScript({ scriptsDir: path.join(tmpDir, 'scripts'), filename: 'probe.sh', content, ...opts })

// ═══════════════════════════════════════════════════════════════════
// The timeout must be enforceable — the bug this module was extracted to fix
// ═══════════════════════════════════════════════════════════════════

describe('timeout enforcement', () => {
  // HOW THESE TESTS AVOID BEING VACUOUS — read this before changing them.
  //
  // The obvious assertions here are worthless. Measuring elapsed time cannot detect an escaped
  // grandchild, because runScript's own reap guard bounds the response either way. Asserting the
  // grandchild's text is missing from stdout cannot detect it either, if the grandchild's sleep
  // outlasts the measurement window — it was never going to print in time regardless.
  //
  // Both of those passed with the bug deliberately reintroduced. The only assertion that
  // distinguishes "the tree was killed" from "the tree escaped" is an OBSERVED SIDE EFFECT that
  // an orphan would produce after the kill: a file it touches from outside our pipes. Verified
  // by reverting `detached` and confirming these go red.
  const marker = () => path.join(tmpDir, 'orphan-was-alive')

  // A grandchild that reports its own survival by touching a file, long after its parent should
  // have been killed. The parent sleeps far longer so it cannot exit on its own.
  const orphanScript = (m) =>
    '#!/usr/bin/env bash\n' +
    'echo start\n' +
    `( sleep 5; touch "${m}" ) &\n` +
    'sleep 30\n'

  const waitMs = (ms) => new Promise(r => setTimeout(r, ms))

  // MEASURED FAILURE, 2026-08-05, against the shipped daemon:
  //   timeout_ms: 3000  ->  duration_ms: 25266, and the grandchild's output still arrived.
  // spawn() without `detached` leaves the child in the daemon's process group, so SIGKILL hits
  // only the direct child. The grandchild survives, inherits the stdout pipe and holds it open,
  // and node's `close` waits for stdio EOF rather than for the process to die.
  //
  // This is the single most important test in the file: without it the documented timeout is
  // decorative, and a runaway script on a Hive node cannot be stopped.
  it('kills the whole process TREE, not just the direct child', async () => {
    const m = marker()
    const res = await run(orphanScript(m), { timeoutMs: 1000 })

    assert.equal(res.timed_out, true, 'should be reported as a timeout')
    assert.equal(res.status, 'timeout')

    // Wait past the grandchild's own deadline. If the group was signalled it died at ~1s and can
    // never touch the file; if only bash was signalled it is still running and touches at ~5s.
    await waitMs(6000)
    assert.equal(fs.existsSync(m), false,
      'the grandchild outlived the kill — the process GROUP was not signalled, so the timeout is unenforceable')
  })

  it('a clean run is unaffected by the timeout machinery', async () => {
    const res = await run('#!/usr/bin/env bash\necho hello\n', { timeoutMs: 5000 })
    assert.equal(res.status, 'completed')
    assert.equal(res.exit_code, 0)
    assert.equal(res.timed_out, false)
    assert.match(res.stdout, /hello/)
  })

  it('a script that ignores SIGTERM is still killed', async () => {
    // Trapping SIGTERM is normal in real scripts. If the escalation to SIGKILL is missing, a
    // trap turns the timeout back into a suggestion. Again the observable is a side effect: a
    // trapping parent that survives goes on to touch the file itself.
    const m = path.join(tmpDir, 'trapper-was-alive')
    const res = await run(
      '#!/usr/bin/env bash\ntrap "" TERM\necho armed\nsleep 5\n' + `touch "${m}"\n`,
      { timeoutMs: 1000 }
    )
    assert.equal(res.timed_out, true)

    await waitMs(6000)
    assert.equal(fs.existsSync(m), false,
      'SIGTERM was trapped and SIGKILL never followed — the script ran to completion past its timeout')
  })

  it('bounds the response even when a child cannot be reaped', async () => {
    // Distinct property from the two above: this one pins the reap guard, which is what stops an
    // un-signallable process from holding the HTTP request open (the observed 206s). It passes
    // with or without the process-group fix BY DESIGN — the tree tests above are what cover that.
    const started = Date.now()
    const res = await run(orphanScript(path.join(tmpDir, 'ignored')), { timeoutMs: 1000 })
    const elapsed = Date.now() - started
    assert.equal(res.timed_out, true)
    assert.ok(elapsed < 10_000,
      `the request hung for ${elapsed}ms — a stuck child must not hold the response open`)
  })

  it('clamps the timeout into the documented range instead of trusting the caller', () => {
    assert.equal(clampTimeout(undefined), DEFAULT_TIMEOUT_MS)
    assert.equal(clampTimeout(0), DEFAULT_TIMEOUT_MS, '0 must not mean "no timeout"')
    assert.equal(clampTimeout(-5), DEFAULT_TIMEOUT_MS)
    assert.equal(clampTimeout('nonsense'), DEFAULT_TIMEOUT_MS)
    assert.equal(clampTimeout(1), MIN_TIMEOUT_MS)
    assert.equal(clampTimeout(999_999_999), MAX_TIMEOUT_MS)
  })
})

// ═══════════════════════════════════════════════════════════════════
// Exit status must survive the trip — a failure that reports success is worse than a crash
// ═══════════════════════════════════════════════════════════════════

describe('exit status fidelity', () => {
  it('preserves a non-zero exit code and marks the run failed', async () => {
    const res = await run('#!/usr/bin/env bash\necho nope\nexit 42\n')
    assert.equal(res.exit_code, 42, 'the exact code matters — callers branch on it')
    assert.equal(res.status, 'failed')
  })

  it('distinguishes a timeout from an ordinary failure', async () => {
    // Both are "not success", but only one means the script was cut off mid-work. Collapsing
    // them makes a hung node look like a failing script.
    const failed = await run('#!/usr/bin/env bash\nexit 3\n')
    const timedOut = await run('#!/usr/bin/env bash\nsleep 20\n', { timeoutMs: 1000 })
    assert.equal(failed.status, 'failed')
    assert.equal(failed.timed_out, false)
    assert.equal(timedOut.status, 'timeout')
    assert.equal(timedOut.timed_out, true)
  })

  it('reports the signal when the process was killed rather than exiting', async () => {
    const res = await run('#!/usr/bin/env bash\nsleep 20\n', { timeoutMs: 1000 })
    // exit_code is null for a signalled process; without `signal` the caller has nothing at all
    // to explain the null, which is how "Exit code: ?" reached the operator.
    assert.ok(res.signal !== undefined, 'signal must be present to explain a null exit code')
  })
})

// ═══════════════════════════════════════════════════════════════════
// Output handling — bounded, and honest about what it dropped
// ═══════════════════════════════════════════════════════════════════

describe('output capture', () => {
  it('bounds memory as chunks arrive rather than after the fact', () => {
    // The shipped daemon did `stdout += chunk` unbounded and only applied .slice(-50000) at the
    // very end. The cap protected the RESPONSE and never the node: a script printing a few GB
    // OOMs the daemon long before anything is trimmed.
    const buf = new TailBuffer(100)
    for (let i = 0; i < 10_000; i++) buf.push('x'.repeat(100))
    assert.ok(buf.text.length <= 100, `buffer grew to ${buf.text.length}, cap was 100`)
    assert.equal(buf.total, 1_000_000, 'the true size must still be known')
    assert.equal(buf.truncated, true)
  })

  it('ANNOUNCES truncation instead of silently dropping output', async () => {
    // Output that vanishes without a marker is indistinguishable from output never produced —
    // and that is how a partial result gets read as a complete one.
    const res = await run(
      `#!/usr/bin/env bash\nfor i in $(seq 1 ${Math.ceil(STDOUT_CAP / 50) + 200}); do printf '%050d\\n' "$i"; done\n`,
      { timeoutMs: 20_000 }
    )
    assert.equal(res.stdout_truncated, true, 'this run must exceed the cap for the test to mean anything')
    assert.match(res.stdout, /bytes of earlier output truncated/,
      'truncation must be visible in-band to someone reading only stdout')
  })

  it('keeps the TAIL of the output, where the failure usually is', async () => {
    const res = await run(
      `#!/usr/bin/env bash\nfor i in $(seq 1 ${Math.ceil(STDOUT_CAP / 50) + 200}); do printf '%050d\\n' "$i"; done\necho FINAL-LINE\n`,
      { timeoutMs: 20_000 }
    )
    assert.match(res.stdout, /FINAL-LINE/, 'the end of the log is what diagnoses the run')
  })

  it('does not report truncation when nothing was dropped', async () => {
    // A marker that is always present teaches people to ignore it.
    const res = await run('#!/usr/bin/env bash\necho small\n')
    assert.equal(res.stdout_truncated, false)
    assert.ok(!res.stdout.includes('truncated'))
  })

  it('captures stderr separately from stdout', async () => {
    const res = await run('#!/usr/bin/env bash\necho to-out\necho to-err >&2\nexit 1\n')
    assert.match(res.stdout, /to-out/)
    assert.match(res.stderr, /to-err/)
    assert.ok(!res.stdout.includes('to-err'))
  })
})

// ═══════════════════════════════════════════════════════════════════
// Input handling
// ═══════════════════════════════════════════════════════════════════

describe('filename validation', () => {
  it('rejects traversal and path separators', () => {
    for (const bad of ['../escape.sh', 'a/b.sh', 'a\\b.sh', '..', '']) {
      assert.equal(isPlainFilename(bad), false, `${JSON.stringify(bad)} must be rejected`)
    }
    assert.equal(isPlainFilename('fine.sh'), true)
  })

  it('never writes outside the scripts directory', async () => {
    await assert.rejects(
      () => runScript({ scriptsDir: path.join(tmpDir, 'scripts'), filename: '../pwned.sh', content: 'echo x' }),
      /plain name/
    )
    assert.equal(fs.existsSync(path.join(tmpDir, 'pwned.sh')), false)
  })
})

describe('persistence', () => {
  it('removes the script when persist is false', async () => {
    await run('#!/usr/bin/env bash\ntrue\n', { persist: false })
    assert.equal(fs.existsSync(path.join(tmpDir, 'scripts', 'probe.sh')), false)
  })

  it('keeps the script and reports its path when persist is true', async () => {
    const res = await run('#!/usr/bin/env bash\ntrue\n', { persist: true })
    assert.equal(res.script_path, '/scripts/probe.sh')
    assert.equal(fs.existsSync(path.join(tmpDir, 'scripts', 'probe.sh')), true)
  })

  it('cleans up even when the script TIMES OUT', async () => {
    // The leak nobody notices: a timing-out script is exactly the one likely to be retried, so
    // a cleanup path that only runs on success accumulates the worst scripts on the node.
    await run('#!/usr/bin/env bash\nsleep 20\n', { timeoutMs: 1000, persist: false })
    assert.equal(fs.existsSync(path.join(tmpDir, 'scripts', 'probe.sh')), false)
  })
})

describe('environment', () => {
  it('merges caller env over the daemon env', async () => {
    // The copied test never covered this, and the copy did not implement it — which is precisely
    // how --project env injection could have broken without a red test.
    const res = await run('#!/usr/bin/env bash\necho "V=$INJECTED"\n', { env: { INJECTED: 'from-caller' } })
    assert.match(res.stdout, /V=from-caller/)
  })

  it('still inherits PATH so interpreters resolve', async () => {
    const res = await run('#!/usr/bin/env bash\ntest -n "$PATH" && echo has-path\n', { env: { X: '1' } })
    assert.match(res.stdout, /has-path/)
  })
})

// ═══════════════════════════════════════════════════════════════════
// Stress — the conditions a single happy-path test never reaches
// ═══════════════════════════════════════════════════════════════════

describe('stress', () => {
  it('runs many scripts concurrently without crossing their output', async () => {
    // Hive dispatches to a node with max_concurrent slots. If buffers or script paths collide,
    // the symptom is one task reporting another's result — a wrong answer, not an error.
    const N = 12
    const runs = Array.from({ length: N }, (_, i) =>
      runScript({
        scriptsDir: path.join(tmpDir, 'scripts'),
        filename: `concurrent-${i}.sh`,
        content: `#!/usr/bin/env bash\nsleep 0.${(i % 5) + 1}\necho token-${i}\nexit ${i % 3}\n`,
        timeoutMs: 20_000
      })
    )
    const results = await Promise.all(runs)
    results.forEach((res, i) => {
      assert.match(res.stdout, new RegExp(`token-${i}\\b`), `run ${i} got the wrong stdout`)
      assert.equal(res.exit_code, i % 3, `run ${i} got the wrong exit code`)
      for (let j = 0; j < N; j++) {
        if (j !== i) assert.ok(!new RegExp(`token-${j}\\b`).test(res.stdout), `run ${i} leaked run ${j}'s output`)
      }
    })
  })

  it('survives a script that floods stdout without exhausting memory', async () => {
    const before = process.memoryUsage().heapUsed
    const res = await run(
      "#!/usr/bin/env bash\nfor i in $(seq 1 20000); do printf '%0100d\\n' \"$i\"; done\n",
      { timeoutMs: 30_000 }
    )
    const grew = process.memoryUsage().heapUsed - before
    assert.equal(res.stdout_truncated, true)
    assert.ok(res.stdout.length < STDOUT_CAP * 2, 'the returned payload must stay bounded')
    // ~2MB of output must not translate into an unbounded heap footprint.
    assert.ok(grew < 50 * 1024 * 1024, `heap grew ${Math.round(grew / 1024 / 1024)}MB on a 2MB flood`)
  })

  it('handles a flood of output that is ALSO killed by the timeout', async () => {
    // The nastiest combination: the buffer is filling while the kill lands. If draining and
    // killing race badly this is where it hangs.
    const started = Date.now()
    const res = await run(
      "#!/usr/bin/env bash\nwhile true; do printf '%0100d\\n' 1; done\n",
      { timeoutMs: 1500 }
    )
    assert.equal(res.timed_out, true)
    assert.ok(Date.now() - started < 12_000, 'a flooding script must still be killable')
  })

  it('handles binary and invalid UTF-8 on stdout without throwing', async () => {
    const res = await run('#!/usr/bin/env bash\nhead -c 2048 /dev/urandom\n', { timeoutMs: 15_000 })
    assert.ok(typeof res.stdout === 'string', 'binary output must not crash the capture')
  })

  it('reports a spawn failure instead of hanging', async () => {
    const res = await runScript({
      scriptsDir: path.join(tmpDir, 'scripts'),
      filename: 'broken.py',
      content: 'this is not python',
      timeoutMs: 10_000
    })
    // python3 exits non-zero on a syntax error; the contract is only that we settle and say so.
    assert.ok(['failed', 'completed'].includes(res.status))
    assert.ok(res.duration_ms >= 0)
  })
})
