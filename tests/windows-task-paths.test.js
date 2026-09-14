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

// ─────────────────────────────────────────────────────────────────────────────
// cmd.exe quoting — the bug that only exists on the platform we cannot run on.
//
// spawn('cmd.exe', ['/d','/s','/c', command]) does NOT do what it looks like.
// Node escapes arguments on Windows using MSVCRT rules; cmd.exe parses its
// command line with its OWN rules, and the two disagree exactly when the command
// contains quotes. Node sets windowsVerbatimArguments automatically when you pass
// `shell:`, but NOT when you name cmd.exe yourself — which is what this code does.
//
// The consequence is not "it errors". It is that cmd.exe receives a DIFFERENT
// command than the operator typed, which is the worst outcome in this whole bug
// family: it runs, and it runs something else.
//
// `/s` is what makes the safe form work: with /s, cmd.exe strips the first and
// last quote of the trailing string and treats everything between as the command
// verbatim, instead of counting quotes and guessing.
// ─────────────────────────────────────────────────────────────────────────────

test('win32 spawns must ask for VERBATIM arguments', () => {
  const plan = shellFor('echo hi', 'win32')
  assert.ok(plan.spawnOptions, 'the plan must carry the options its spawn needs')
  assert.strictEqual(plan.spawnOptions.windowsVerbatimArguments, true,
    'without this node re-escapes the command and cmd.exe misreads it')
})

test('posix plans do not smuggle a Windows-only spawn option', () => {
  for (const p of POSIX) {
    const o = shellFor('echo hi', p).spawnOptions || {}
    assert.notStrictEqual(o.windowsVerbatimArguments, true, `${p} must not set it`)
  }
})

test('win32 wraps the command so /s strips exactly one layer of quotes', () => {
  const { args } = shellFor('echo hi', 'win32')
  const last = args[args.length - 1]
  assert.ok(last.startsWith('"') && last.endsWith('"'),
    'the /s contract is that the command is the quoted trailing argument')
  assert.strictEqual(last.slice(1, -1), 'echo hi')
})

test('win32 survives a command that CONTAINS quotes — the case that breaks', () => {
  // git commit -m "a message" is the everyday command that exposes this.
  const cmd = 'git commit -m "fix: a thing"'
  const { args } = shellFor(cmd, 'win32')
  const last = args[args.length - 1]
  assert.strictEqual(last.slice(1, -1), cmd,
    'the inner quotes must survive untouched — /s only removes the outer pair')
})

test('win32 script invocation is verbatim too', () => {
  const s = scriptFor('C:\\ws', 'echo hi', 'win32')
  assert.strictEqual((s.spawnOptions || {}).windowsVerbatimArguments, true,
    'the script path can contain spaces (C:\\Users\\Some Name\\...)')
})

test('a script path containing a space is quoted', () => {
  const s = scriptFor('C:\\Users\\Some Name\\ws', 'echo hi', 'win32')
  const last = s.args[s.args.length - 1]
  assert.ok(last.startsWith('"') && last.endsWith('"'),
    'an unquoted path with a space becomes two arguments and cmd runs the wrong file')
})

// ─────────────────────────────────────────────────────────────────────────────
// The spawn sites themselves.
//
// A plan that carries the right options is worth nothing if the caller drops
// them. #185143's first patch was exactly this shape — it fixed a function the
// failing path never called, and the unit tests could not tell. So these assert
// the SOURCE at the two spawn sites, not the helper.
// ─────────────────────────────────────────────────────────────────────────────

const EXEC_SRC = () => fs.readFileSync(path.join(__dirname, '..', 'daemon', 'task-executor.js'), 'utf8')

test('every spawn of a task passes the plan spawnOptions through', () => {
  const src = EXEC_SRC()
  const spawns = [...src.matchAll(/const child = spawn\(cmd, args, \{([\s\S]{0,1200}?)\n      \}\)/g)]
  assert.ok(spawns.length >= 2, `expected the task spawn sites, found ${spawns.length}`)
  for (const [i, m] of spawns.entries()) {
    assert.match(m[1], /spawnOptions/,
      `spawn site ${i + 1} drops spawnOptions — on Windows that loses ` +
      'windowsVerbatimArguments and cmd.exe silently receives a different command')
  }
})

test('no task spawn builds PATH with a hardcoded POSIX delimiter', () => {
  const bad = EXEC_SRC().split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => !/^\s*(\/\/|\*)/.test(l))
    // A PATH built with ':' and POSIX default dirs is unusable on Windows, where
    // the delimiter is ';' — every spawned process inherits one broken entry.
    .filter(([, l]) => /PATH:\s*`[^`]*\$\{[^}]+\}:/.test(l))
  assert.deepStrictEqual(bad.map(([n]) => n), [],
    'these build PATH with ":" instead of pathDelimiterFor():\n' +
    bad.map(([n, l]) => `  ${n}: ${l.trim()}`).join('\n'))
})
