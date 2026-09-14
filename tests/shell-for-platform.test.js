// A hive dispatch to a Windows node died with `spawn /bin/bash ENOENT` (#185143,
// #184733). The executor's free-form path hardcoded a POSIX shell, and the same
// block joined PATH with ':' — so even with a shell that exists, every spawned
// process on Windows would inherit one unusable PATH entry.
//
// The platform is a PARAMETER here rather than read from process.platform, so the
// Windows behaviour is asserted on the machine that does not have it. A test that
// can only check its own platform cannot catch this class of bug at all.

const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { shellFor, pathDelimiterFor, describeSpawnFailure } = require('../lib/shell-for-platform')

// Windows plans quote the trailing argument. With windowsVerbatimArguments node
// escapes nothing for us, so the quoting is ours and cmd.exe's /s strips exactly
// one layer back off. These tests assert the INTENT — the command/script is the
// final argument — rather than the pre-quoting literal spelling.
const unwrap = (a) => (a.startsWith('"') && a.endsWith('"') ? a.slice(1, -1) : a)

test('posix platforms get bash -c', () => {
  for (const p of ['darwin', 'linux', 'freebsd']) {
    const { cmd, args } = shellFor('echo hi', p)
    assert.strictEqual(cmd, '/bin/bash', `${p} should use bash`)
    assert.deepStrictEqual(args, ['-c', 'echo hi'])
  }
})

test('win32 gets a shell that EXISTS on Windows, never /bin/bash', () => {
  const { cmd, args } = shellFor('echo hi', 'win32')
  assert.notStrictEqual(cmd, '/bin/bash', 'the whole bug: /bin/bash is not on Windows')
  assert.match(cmd, /cmd\.exe$/i, 'cmd.exe is the only shell present on every Windows install')
  assert.strictEqual(unwrap(args[args.length - 1]), 'echo hi', 'the command must be the final argument')
  assert.ok(args.includes('/c'), 'cmd.exe needs /c to run a command string')
})

test('win32 honours ComSpec when Windows sets it somewhere non-standard', () => {
  const saved = process.env.ComSpec
  process.env.ComSpec = 'D:\\Windows\\System32\\cmd.exe'
  try {
    assert.strictEqual(shellFor('echo hi', 'win32').cmd, 'D:\\Windows\\System32\\cmd.exe')
  } finally {
    if (saved === undefined) delete process.env.ComSpec; else process.env.ComSpec = saved
  }
})

test('PATH delimiter follows the platform, not the host', () => {
  assert.strictEqual(pathDelimiterFor('win32'), ';', "Windows PATH is ';'-separated")
  assert.strictEqual(pathDelimiterFor('darwin'), ':')
  assert.strictEqual(pathDelimiterFor('linux'), ':')
  // And it must agree with Node's own answer for the host we are on.
  assert.strictEqual(pathDelimiterFor(process.platform), path.delimiter)
})

test('an ENOENT on the shell itself names the shell and the platform', () => {
  // "spawn /bin/bash ENOENT" told the operator nothing about why. The message must
  // distinguish "this node has no shell to run your command with" from "your command
  // was not found", because those need completely different responses.
  const msg = describeSpawnFailure(
    Object.assign(new Error('spawn /bin/bash ENOENT'), { code: 'ENOENT', syscall: 'spawn /bin/bash' }),
    '/bin/bash',
    'win32'
  )
  assert.match(msg, /\/bin\/bash/, 'name the shell that was missing')
  assert.match(msg, /win32|Windows/i, 'name the platform, so the mismatch is obvious')
  assert.ok(msg.length > 40, 'must be an explanation, not a rethrown syscall string')
})

test('a non-ENOENT failure is NOT relabelled as a missing shell', () => {
  // The other direction. Without this, describeSpawnFailure could claim every
  // failure is a missing shell and still pass the test above.
  const msg = describeSpawnFailure(
    Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }),
    '/bin/bash',
    'linux'
  )
  assert.doesNotMatch(msg, /not installed|no shell/i,
    'an EACCES is a permission problem, not a missing interpreter')
  assert.match(msg, /EACCES/, 'keep the real error code visible')
})

// ---------------------------------------------------------------------------
// scriptFor: `iris hive run` does NOT take the bash -c path.
//
// It produces task type `sandbox_execute`, which writes the command to
// task-script.sh and spawns `/bin/bash <script>`. So fixing only the free-form
// `default` case left the actual Windows failure in place — found by running a
// real dispatch, which a unit test of the wrong function could never reveal.
//
// A .sh file is not executable by cmd.exe. The EXTENSION has to change with the
// platform too, not just the interpreter.
// ---------------------------------------------------------------------------

const { scriptFor } = require('../lib/shell-for-platform')

test('posix script: .sh run by bash', () => {
  const s = scriptFor('/tmp/wk', 'echo hi', 'darwin')
  assert.match(s.scriptPath, /\.sh$/, 'posix scripts are .sh')
  assert.strictEqual(s.cmd, '/bin/bash')
  assert.deepStrictEqual(s.args, [s.scriptPath])
  assert.strictEqual(s.content, 'echo hi', 'posix content is passed through unchanged')
  assert.strictEqual(s.mode, '755', 'posix needs the exec bit')
})

test('win32 script: a .cmd run by cmd.exe — NOT a .sh run by bash', () => {
  const s = scriptFor('C:\\wk', 'echo hi', 'win32')
  assert.doesNotMatch(s.scriptPath, /\.sh$/,
    'a .sh file is not runnable by cmd.exe — the extension must change with the platform')
  assert.match(s.scriptPath, /\.cmd$/)
  assert.notStrictEqual(s.cmd, '/bin/bash')
  assert.match(s.cmd, /cmd\.exe$/i)
  assert.strictEqual(unwrap(s.args[s.args.length - 1]), s.scriptPath, 'the script is the final argument')
  assert.strictEqual(s.mode, null, 'Windows has no exec bit to set; chmod would be a no-op or throw')
})

test('win32 script suppresses command echo', () => {
  // Without @echo off, cmd.exe prints every line of the script before running it,
  // so the task output is double the size and interleaved with the commands.
  const s = scriptFor('C:\\wk', 'echo hi', 'win32')
  assert.match(s.content, /^@echo off/, 'cmd.exe echoes each line unless told not to')
  assert.match(s.content, /echo hi/, 'the command itself must survive')
})

test('scriptFor places the script inside the workspace it was given', () => {
  const s = scriptFor('/tmp/wk-abc', 'echo hi', 'linux')
  assert.ok(s.scriptPath.startsWith('/tmp/wk-abc'), 'must not write outside the task workspace')
})
