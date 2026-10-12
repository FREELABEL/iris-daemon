'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const F = require('../daemon/fail-first')

test('test files are recognised across the stacks the fleet runs', () => {
  const got = F.testFilesIn([
    'tests/Feature/InvoiceTest.php', 'app/Services/Invoice.php',
    'packages/opencode/test/bug-dedupe.test.ts', 'src/cli/cmd/bug.ts',
    'web/Button.spec.jsx', 'svc/test_parser.py', 'pkg/run_test.go', 'README.md',
  ])
  assert.deepStrictEqual(got, ['tests/Feature/InvoiceTest.php', 'packages/opencode/test/bug-dedupe.test.ts', 'web/Button.spec.jsx', 'svc/test_parser.py', 'pkg/run_test.go'])
})

test('only "fails on base, passes on tip" is a pass', () => {
  const t = ['a.test.js']
  assert.strictEqual(F.verdict({ testFiles: t, baseExit: 1, tipExit: 0 }).verdict, 'BITES')
  assert.strictEqual(F.verdict({ testFiles: t, baseExit: 0, tipExit: 0 }).verdict, 'TOOTHLESS')
  assert.strictEqual(F.verdict({ testFiles: t, baseExit: 1, tipExit: 1 }).verdict, 'BROKEN')
  assert.strictEqual(F.verdict({ testFiles: [], baseExit: 1, tipExit: 0 }).verdict, 'NO_TESTS')
  for (const v of ['TOOTHLESS', 'BROKEN', 'NO_TESTS']) assert.strictEqual(F.verdict({ testFiles: v === 'NO_TESTS' ? [] : t, baseExit: v === 'TOOTHLESS' ? 0 : 1, tipExit: v === 'BROKEN' ? 1 : 0 }).ok, false)
})

test('a run that did not happen is never read as a result', () => {
  assert.strictEqual(F.verdict({ testFiles: ['a.test.js'], baseExit: null, tipExit: 0 }).verdict, 'UNRUN')
  assert.strictEqual(F.verdict({ testFiles: ['a.test.js'], baseExit: 1, tipExit: null }).verdict, 'UNRUN')
})

// End to end, on a real throwaway repo: a guarding test BITES, a decorative one is TOOTHLESS.
function repo () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-repo-'))
  const g = (...a) => assert.strictEqual(spawnSync('git', a, { cwd: dir }).status, 0, a.join(' '))
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't')
  fs.writeFileSync(path.join(dir, 'add.js'), 'module.exports = (a, b) => a - b\n') // the bug
  g('add', '.'); g('commit', '-qm', 'base')
  const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).stdout.trim()
  return { dir, g, base }
}
const SCRIPT = path.join(__dirname, '..', 'scripts', 'fail-first.js')
const ff = (dir, base) => spawnSync(process.execPath, [SCRIPT, '--base', base, '--json', '--', process.execPath, '--test', 'tests/'], { cwd: dir, encoding: 'utf-8' })

test('end to end: a test that guards the fix BITES', () => {
  const { dir, g, base } = repo()
  fs.writeFileSync(path.join(dir, 'add.js'), 'module.exports = (a, b) => a + b\n') // the fix
  fs.mkdirSync(path.join(dir, 'tests'))
  fs.writeFileSync(path.join(dir, 'tests', 'add.test.js'), "const t=require('node:test');const a=require('node:assert');t('adds',()=>a.strictEqual(require('../add')(2,2),4))\n")
  g('add', '.'); g('commit', '-qm', 'fix')
  const r = ff(dir, base)
  const out = JSON.parse(r.stdout.trim().split('\n').pop())
  assert.strictEqual(out.verdict, 'BITES', r.stdout + r.stderr)
  assert.strictEqual(r.status, 0)
  // the throwaway checkout is gone
  assert.strictEqual(spawnSync('git', ['worktree', 'list'], { cwd: dir, encoding: 'utf-8' }).stdout.trim().split('\n').length, 1)
})

test('end to end: a test that would have passed anyway is TOOTHLESS', () => {
  const { dir, g, base } = repo()
  fs.writeFileSync(path.join(dir, 'add.js'), 'module.exports = (a, b) => a + b\n')
  fs.mkdirSync(path.join(dir, 'tests'))
  // asserts something the buggy code also satisfies: 2 - 0 === 2 + 0
  fs.writeFileSync(path.join(dir, 'tests', 'add.test.js'), "const t=require('node:test');const a=require('node:assert');t('adds',()=>a.strictEqual(require('../add')(2,0),2))\n")
  g('add', '.'); g('commit', '-qm', 'fix with a weak test')
  const r = ff(dir, base)
  assert.strictEqual(JSON.parse(r.stdout.trim().split('\n').pop()).verdict, 'TOOTHLESS', r.stdout + r.stderr)
  assert.strictEqual(r.status, 1)
})

test('every coding task carries the rule, PHI included; it is added once and can be opted out', () => {
  const p = F.codingPrompt({ prompt: 'fix the total', config: {} })
  assert.match(p, /## Hive rule: prove the test bites/)
  assert.ok(p.includes(F.FAIL_FIRST_SCRIPT))
  assert.ok(fs.existsSync(F.FAIL_FIRST_SCRIPT), F.FAIL_FIRST_SCRIPT)
  const phi = F.codingPrompt({ prompt: 'fix', config: {} }, { phi: true })
  assert.match(phi, /prove the test bites/)
  assert.doesNotMatch(phi, /record a video/) // the proof-video rule still never reaches PHI work
  assert.strictEqual(F.withFailFirstRule(p), p)
  assert.doesNotMatch(F.codingPrompt({ prompt: 'x', config: { fail_first: false } }), /prove the test bites/)
})
