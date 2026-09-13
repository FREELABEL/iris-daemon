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
  assert.strictEqual(args[args.length - 1], 'echo hi', 'the command must be the final argument')
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
