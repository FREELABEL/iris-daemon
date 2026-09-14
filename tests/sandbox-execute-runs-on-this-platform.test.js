// Does the `sandbox_execute` path actually RUN a command on the platform we are on?
//
// This is the end-to-end half of #185143 / #184733. `iris hive run <node> "<cmd>"` produces
// task type sandbox_execute, which writes the command to a script and spawns an interpreter
// on it. On Windows that failed with `spawn /bin/bash ENOENT` for every dispatch, because
// the interpreter, the file extension and the chmod were all hardcoded POSIX.
//
// WHY THIS TEST EXISTS RATHER THAN A UNIT TEST OF scriptFor():
// lib/shell-for-platform.js is already unit-tested, including the win32 branch, from a Mac
// — the platform is a parameter there precisely so that is possible. What a unit test
// CANNOT tell you is whether the thing it returns actually executes on Windows: whether
// cmd.exe accepts the file, whether the extension matters, whether CRLF matters, whether
// the exit code and stdout come back. Those only answer on the real OS.
//
// So this test does the whole operation — resolve, write, chmod-if-applicable, spawn, read
// output and exit code — and it runs on whatever platform CI gives it. On a Windows runner
// it is the first real proof of the fix. On Linux/macOS it guards the POSIX side, which is
// the side that used to be the only side.
//
// IT ALSO RUNS THE NEGATIVE CONTROL. On Windows it asserts that the OLD approach — spawning
// /bin/bash — genuinely fails with ENOENT. Without that, "the new way works" could be true
// on a machine where the old way worked too, and the test would prove nothing about the bug.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { scriptFor } = require('../lib/shell-for-platform')

const IS_WIN = process.platform === 'win32'

function run (cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ spawnError: err, code: null, stdout, stderr })
      return
    }
    child.once('error', (err) => resolve({ spawnError: err, code: null, stdout, stderr }))
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.once('close', (code) => resolve({ spawnError: null, code, stdout, stderr }))
  })
}

test('the sandbox_execute path runs a command and returns its output on this platform', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-sbx-'))
  try {
    // Exactly what daemon/task-executor.js does for task type sandbox_execute.
    const marker = 'SANDBOX_EXECUTE_OK_' + process.pid
    const script = scriptFor(dir, `echo ${marker}`)

    fs.writeFileSync(script.scriptPath, script.content, 'utf-8')
    if (script.mode) fs.chmodSync(script.scriptPath, script.mode)

    // The platform contract, asserted here because getting it wrong is the bug.
    if (IS_WIN) {
      assert.match(script.scriptPath, /\.cmd$/, 'cmd.exe cannot execute a .sh')
      assert.match(script.cmd, /cmd\.exe$/i)
      assert.strictEqual(script.mode, null, 'Windows has no exec bit to set')
    } else {
      assert.match(script.scriptPath, /\.sh$/)
      assert.strictEqual(script.cmd, '/bin/bash')
      assert.strictEqual(script.mode, '755')
    }

    // spawnOptions IS PART OF THE CONTRACT and must be passed through.
    //
    // The first version of this test dropped it, and a real windows-latest runner rejected
    // the result:
    //     '"C:\...\task-script.cmd"' is not recognized as an internal or external command
    // On Windows the returned args already contain an explicitly quoted path, paired with
    // cmd.exe's /s, which strips exactly the first and last quote. Without
    // windowsVerbatimArguments Node re-quotes the already-quoted argument, so cmd.exe sees
    // `""C:\...""` and takes the quotes as part of the command NAME.
    //
    // So the production code was right and the test was wrong — it exercised something the
    // executor never does. daemon/task-executor.js threads spawnOptions into spawn (it
    // spreads `...(spawnOptions || {})`), and a test that omits half the contract is testing
    // a different program.
    assert.ok(script.spawnOptions, 'the contract must carry spawnOptions')
    if (IS_WIN) {
      assert.strictEqual(script.spawnOptions.windowsVerbatimArguments, true,
        'Windows needs windowsVerbatimArguments, or Node re-quotes the quoted path')
    }
    const r = await run(script.cmd, script.args, { cwd: dir, ...script.spawnOptions })

    assert.strictEqual(r.spawnError, null,
      `the interpreter itself failed to start: ${r.spawnError && r.spawnError.message}`)
    assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}. stderr: ${r.stderr}`)
    assert.ok(r.stdout.includes(marker),
      `stdout did not carry the command's output. got: ${JSON.stringify(r.stdout.slice(0, 200))}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the OLD hardcoded /bin/bash genuinely fails here — the negative control', async (t) => {
  if (!IS_WIN) {
    // On POSIX /bin/bash exists, so there is no failure to demonstrate. Saying so is the
    // point: this assertion is only meaningful on the platform the bug was about.
    t.skip('/bin/bash exists on this platform — the control is only meaningful on Windows')
    return
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-sbx-ctl-'))
  try {
    const sh = path.join(dir, 'task-script.sh')
    fs.writeFileSync(sh, 'echo SHOULD_NEVER_RUN\n', 'utf-8')
    const r = await run('/bin/bash', [sh], { cwd: dir })
    assert.notStrictEqual(r.spawnError, null,
      'spawning /bin/bash on Windows was expected to fail — if it succeeds, this runner is ' +
      'not representative of a Windows client and the test above proves nothing about #185143')
    assert.strictEqual(r.spawnError.code, 'ENOENT',
      `expected ENOENT, got ${r.spawnError.code}: ${r.spawnError.message}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('daemon/task-executor.js does not hardcode a POSIX shell for sandbox_execute', () => {
  // The source assertion, so a future edit that reintroduces the literal is caught even if
  // CI has no Windows runner that day.
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'task-executor.js'), 'utf-8')
  // The window has to clear the case's own comments, which explain the bug and are long.
  // A 600-char window silently matched NOTHING and the assertion failed on correct code —
  // a fixture too small to contain its subject, which reads exactly like a real regression.
  const block = /case 'sandbox_execute':[\s\S]{0,2500}?break/.exec(src)
  assert.ok(block, 'could not find the sandbox_execute case — did it move?')
  assert.ok(!/cmd = '\/bin\/bash'/.test(block[0]),
    'sandbox_execute hardcodes /bin/bash again — that is #185143')
  assert.match(block[0], /scriptFor\(/,
    'sandbox_execute should resolve its interpreter through scriptFor()')
})
