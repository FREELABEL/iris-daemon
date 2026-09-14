// The nine typed task paths that still hardcoded a POSIX shell after #185143's
// first fix, plus the two extension-driven runners.
//
// #185143 fixed `sandbox_execute` — the path `iris hive run` actually takes — and
// said so plainly: "NOT claimed: Windows support. Nine typed paths still hardcode
// a POSIX shell." These are those paths. Each one is a dispatch that reaches a
// Windows node, accepts the task, and dies on spawn.
//
// Platform is a PARAMETER throughout. A helper that reads process.platform can
// only be tested on the platform that already worked, which is precisely how a
// Windows bug survives a green suite on a Mac.

const test = require('node:test')
const assert = require('node:assert')
const os = require('os')
const fs = require('fs')
const path = require('path')
const {
  shellFor, scriptFor, pathDelimiterFor, describeSpawnFailure,
  interpreterFor, generatedScriptFor
} = require('../lib/shell-for-platform')

const POSIX = ['darwin', 'linux']

// ─────────────────────────────────────────────────────────────────────────────
// interpreterFor — execute_file, daemon/script-runner.js, daemon/schedule-registry.js
// ─────────────────────────────────────────────────────────────────────────────

test('interpreterFor: portable interpreters are the same everywhere', () => {
  for (const p of [...POSIX, 'win32']) {
    assert.strictEqual(interpreterFor('.py', p).cmd, 'python3', `${p} .py`)
    assert.strictEqual(interpreterFor('.js', p).cmd, 'node', `${p} .js`)
  }
})

test('interpreterFor: an unknown extension falls back to the platform SHELL, not bash', () => {
  for (const p of POSIX) assert.strictEqual(interpreterFor('.whatever', p).cmd, '/bin/bash')
  const win = interpreterFor('.whatever', 'win32')
  assert.notStrictEqual(win.cmd, '/bin/bash', 'the bug: bash is the fallback on a machine without bash')
  assert.match(win.cmd, /cmd\.exe$/i)
})

test('interpreterFor: Windows script extensions get their real Windows interpreters', () => {
  assert.match(interpreterFor('.cmd', 'win32').cmd, /cmd\.exe$/i)
  assert.match(interpreterFor('.bat', 'win32').cmd, /cmd\.exe$/i)
  assert.match(interpreterFor('.ps1', 'win32').cmd, /powershell/i)
  const ps = interpreterFor('.ps1', 'win32')
  assert.ok(ps.args.includes('-NoProfile'), 'a task must not inherit an operator profile')
  assert.ok(ps.args.some(a => /-ExecutionPolicy/i.test(a)), 'default policy blocks unsigned .ps1')
})

test('interpreterFor: .sh on Windows is refused with a REASON, not a bash spawn', () => {
  const r = interpreterFor('.sh', 'win32')
  assert.ok(r.unsupported, '.sh cannot run on Windows and must say so before spawning')
  assert.match(r.reason, /Windows/i)
  assert.notStrictEqual(r.cmd, '/bin/bash')
})

test('interpreterFor: chmod is POSIX-only — Windows has no exec bit', () => {
  for (const p of POSIX) assert.strictEqual(interpreterFor('.sh', p).mode, '755')
  assert.strictEqual(interpreterFor('.cmd', 'win32').mode, null,
    'chmodSync on Windows is a no-op that still throws on some filesystems')
})

// ─────────────────────────────────────────────────────────────────────────────
// generatedScriptFor — scaffold_workspace and the deploy_project builders, which
// assemble a multi-line script rather than taking one from the caller.
// ─────────────────────────────────────────────────────────────────────────────

const LINES = ['echo "Preparing workspace"', 'npm ci', 'echo "Workspace scaffolded successfully"']

test('generatedScriptFor: posix writes a .sh, chmod 755, run by bash', () => {
  const r = generatedScriptFor('/tmp/ws', 'scaffold', LINES, 'darwin')
  assert.ok(r.scriptPath.endsWith('scaffold.sh'))
  assert.strictEqual(r.cmd, '/bin/bash')
  assert.strictEqual(r.mode, '755')
  assert.match(r.content, /set -e/, 'posix keeps fail-fast')
})

test('generatedScriptFor: win32 does NOT produce a .sh or a bash spawn', () => {
  const r = generatedScriptFor('C:\\ws', 'scaffold', LINES, 'win32')
  assert.ok(!r.scriptPath.endsWith('.sh'), 'a .sh has no interpreter on Windows')
  assert.notStrictEqual(r.cmd, '/bin/bash')
  assert.strictEqual(r.mode, null)
})

test('generatedScriptFor: win32 keeps FAIL-FAST — the posix script has set -e', () => {
  // Dropping set -e silently would turn "deploy failed at step 2" into "deploy
  // succeeded", which is worse than the ENOENT this replaces.
  const r = generatedScriptFor('C:\\ws', 'scaffold', LINES, 'win32')
  assert.match(r.content, /ErrorActionPreference\s*=\s*['"]Stop['"]/i,
    'PowerShell fail-fast is the set -e equivalent')
})

test('generatedScriptFor: win32 checks the exit code of EVERY command', () => {
  // $ErrorActionPreference=Stop does NOT stop on a native exe returning non-zero;
  // it only governs PowerShell errors. Without an explicit $LASTEXITCODE check a
  // failing `npm ci` would sail past, which is the silent-success trap again.
  const r = generatedScriptFor('C:\\ws', 'scaffold', LINES, 'win32')
  assert.match(r.content, /LASTEXITCODE/, 'native exit codes must be checked explicitly')
})

test('generatedScriptFor: win32 uses CRLF', () => {
  const r = generatedScriptFor('C:\\ws', 'scaffold', LINES, 'win32')
  assert.ok(r.content.includes('\r\n'), 'Windows interpreters are line-ending sensitive')
  assert.ok(!/[^\r]\n/.test(r.content), 'no bare LF should survive')
})

test('generatedScriptFor: the caller learns the platform refused, rather than guessing', () => {
  const r = generatedScriptFor('C:\\ws', 'scaffold', LINES, 'win32')
  assert.ok('translated' in r, 'callers must be able to tell a translation happened')
})

// ─────────────────────────────────────────────────────────────────────────────
// The invariant that ties all of it together
// ─────────────────────────────────────────────────────────────────────────────

test('NOTHING this module returns for win32 ever names a POSIX shell', () => {
  const outs = [
    shellFor('echo hi', 'win32'),
    scriptFor('C:\\ws', 'echo hi', 'win32'),
    interpreterFor('.py', 'win32'),
    interpreterFor('.unknown', 'win32'),
    generatedScriptFor('C:\\ws', 's', LINES, 'win32')
  ]
  for (const o of outs) {
    assert.ok(!/\/bin\/(ba)?sh/.test(JSON.stringify(o)),
      `a POSIX shell leaked into a win32 result: ${JSON.stringify(o).slice(0, 160)}`)
  }
})

test('the source tree has no bare /bin/bash left in the typed task paths', () => {
  // The regression guard. Every remaining literal must be reached only through a
  // platform decision — this asserts the COUNT of raw literals in the dispatch
  // switch, so adding one back fails here rather than on a client's Windows box.
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'task-executor.js'), 'utf8')
  const bare = src.split('\n')
    .map((l, i) => [i + 1, l])
    // A comment cannot spawn anything. Matching prose made the guard fail on its
    // own explanatory text, which is the kind of noise that gets a guard deleted.
    .filter(([, l]) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .filter(([, l]) => /['"]\/bin\/bash['"]/.test(l))
    .filter(([, l]) => !/shell-for-platform|platformFor|POSIX_ONLY_OK/.test(l))
  assert.deepStrictEqual(bare.map(([n]) => n), [],
    'these lines still hardcode bash:\n' + bare.map(([n, l]) => `  ${n}: ${l.trim()}`).join('\n'))
})
