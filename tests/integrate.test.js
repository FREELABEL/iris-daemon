'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const I = require('../daemon/integrate')

const SCRIPT = path.join(__dirname, '..', 'scripts', 'integrate.js')

test('hunks carry their file and the enclosing symbol git reports', () => {
  const diff = [
    'diff --git a/calc.js b/calc.js', '--- a/calc.js', '+++ b/calc.js',
    '@@ -4 +4 @@ function add (a, b) {', '-  throw new Error(1)', '+  return a + b',
    '@@ -1 +1 @@', '-const OFFSET = 0', '+const OFFSET = 1',
    'diff --git a/t/new.test.js b/t/new.test.js', 'new file mode 100644', '--- /dev/null', '+++ b/t/new.test.js',
    '@@ -0,0 +1 @@', '+x',
  ].join('\n')
  const h = I.parseHunks(diff)
  assert.strictEqual(h.length, 3)
  assert.deepStrictEqual(h.map((x) => x.created), [false, false, true])
  assert.deepStrictEqual([h[0].file, h[0].context], ['calc.js', 'function add (a, b) {'])
  assert.strictEqual(h[1].context, '')
})

test('claims: inside your symbol is fine, the top of the file is shared, someone else\'s symbol is a violation', () => {
  const claims = I.normalizeClaims({ a: ['calc.js#add'], b: ['calc.js'] })
  const inside = { file: 'calc.js', context: 'function add (a, b) {', lines: ['  return a + b'] }
  const top = { file: 'calc.js', context: '', lines: ["const { x } = require('y')"] }
  const other = { file: 'calc.js', context: 'function double (x) {', lines: ['  return x * 2'] }
  assert.deepStrictEqual(I.claimViolations('a', [inside, top], claims), [])
  const v = I.claimViolations('a', [inside, other], claims)
  assert.strictEqual(v.length, 1)
  assert.match(v[0].where, /double/)
  assert.deepStrictEqual(I.claimViolations('b', [other], claims), [], 'a whole-file claim covers every symbol')
  assert.strictEqual(I.claimViolations('nobody', [other], claims), null, 'an unclaimed branch is reported, not silently passed')
  const elsewhere = { file: 'other.js', context: '', lines: ['x'] }
  assert.strictEqual(I.claimViolations('a', [elsewhere], claims).length, 1, 'a file it never claimed is a violation')
  assert.deepStrictEqual(I.claimViolations('a', [{ ...elsewhere, created: true }], claims), [], 'a file it created is its own')
})

test('the stop rule: the second return exhausts the budget', () => {
  assert.deepStrictEqual(I.returnBudget({}, 'x'), { count: 1, exhausted: false })
  assert.deepStrictEqual(I.returnBudget({ x: 1 }, 'x'), { count: 2, exhausted: true })
})

// ── end to end, the reel's scenario on a real repo ─────────────────────────────────────────
function setup () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integ-'))
  const g = (...a) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf-8' }); assert.strictEqual(r.status, 0, a.join(' ') + r.stderr); return r.stdout.trim() }
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't')
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s) }
  w('calc.js', [
    'const OFFSET = 0', '',
    'function add (a, b) {', "  throw new Error('NotImplemented')", '}', '',
    'function double (x) {', "  throw new Error('NotImplemented')", '}', '',
    'module.exports = { add, double }', '',
  ].join('\n'))
  w('tests/base.test.js', "require('node:test')('loads', () => require('../calc'))\n")
  g('add', '.'); g('commit', '-qm', 'base')
  const branch = (name, edit) => {
    g('checkout', '-q', '-b', name, 'main'); edit(); g('add', '.'); g('commit', '-qm', name); g('checkout', '-q', 'main')
  }
  const sub = (from, to) => () => w('calc.js', fs.readFileSync(path.join(dir, 'calc.js'), 'utf-8').replace(from, to))
  branch('agent-a', () => { sub("function add (a, b) {\n  throw new Error('NotImplemented')", 'function add (a, b) {\n  return a + b + OFFSET')(); w('tests/add.test.js', "const a=require('node:assert');require('node:test')('add',()=>a.strictEqual(require('../calc').add(2,2),4))\n") })
  branch('agent-b', () => { sub("function double (x) {\n  throw new Error('NotImplemented')", 'function double (x) {\n  return x * 2')(); w('tests/double.test.js', "const a=require('node:assert');require('node:test')('double',()=>a.strictEqual(require('../calc').double(3),6))\n") })
  // passes on its own (nothing tests add yet) — breaks agent-a's test once both are in
  branch('agent-c', () => sub('const OFFSET = 0', 'const OFFSET = 1')())
  // same line as agent-a, different answer: a real conflict
  branch('agent-d', () => sub("function add (a, b) {\n  throw new Error('NotImplemented')", 'function add (a, b) {\n  return b + a')())
  return { dir, g }
}
const integrate = (dir, extra = []) => spawnSync(process.execPath, [SCRIPT, '--json', ...extra, '--', process.execPath, '--test', 'tests/'], { cwd: dir, encoding: 'utf-8' })

test('end to end: two merge, the one that breaks the combination and the one that conflicts go back; then they stop', () => {
  const { dir, g } = setup()
  let r = integrate(dir, ['--branches', 'agent-a,agent-b,agent-c,agent-d', '--into', 'integrate/run'])
  let out = JSON.parse(r.stdout.trim().split('\n').pop())
  assert.strictEqual(out.outcome, 'PARTIAL', r.stdout + r.stderr)
  assert.deepStrictEqual(out.results.map((x) => [x.branch, x.status, x.why]), [
    ['agent-a', 'MERGED', undefined], ['agent-b', 'MERGED', undefined],
    ['agent-c', 'RETURNED', 'tests'], ['agent-d', 'RETURNED', 'conflict'],
  ])
  assert.strictEqual(r.status, 1)
  // the integration branch holds exactly what passed, and the tests pass on it
  const calc = g('show', 'integrate/run:calc.js')
  assert.match(calc, /return a \+ b \+ OFFSET/); assert.match(calc, /return x \* 2/); assert.match(calc, /OFFSET = 0/)
  assert.strictEqual(g('worktree', 'list').split('\n').length, 1, 'the throwaway worktree is gone')
  // second time round: the same two come back again and the job stops
  r = integrate(dir, ['--branches', 'agent-c,agent-d', '--base', 'integrate/run', '--into', 'integrate/run2'])
  out = JSON.parse(r.stdout.trim().split('\n').pop())
  assert.strictEqual(out.outcome, 'STOPPED', r.stdout + r.stderr)
  assert.deepStrictEqual(out.results.map((x) => x.status), ['STOPPED', 'STOPPED'])
})

test('end to end: a branch that edits a function it did not claim is returned before any merge', () => {
  const { dir, g } = setup()
  g('checkout', '-q', '-b', 'agent-e', 'main')
  const f = path.join(dir, 'calc.js')
  fs.writeFileSync(f, fs.readFileSync(f, 'utf-8').replace("function add (a, b) {\n  throw new Error('NotImplemented')", 'function add (a, b) {\n  return a + b').replace("function double (x) {\n  throw new Error('NotImplemented')", 'function double (x) {\n  return x + x'))
  g('commit', '-qam', 'agent-e does add AND double'); g('checkout', '-q', 'main')
  fs.writeFileSync(path.join(dir, 'claims.json'), JSON.stringify({ 'agent-a': ['calc.js#add'], 'agent-e': ['calc.js#add'] }))
  const r = integrate(dir, ['--branches', 'agent-a,agent-e', '--claims', 'claims.json', '--into', 'integrate/claims'])
  const out = JSON.parse(r.stdout.trim().split('\n').pop())
  assert.deepStrictEqual(out.results.map((x) => [x.branch, x.status, x.why]), [['agent-a', 'MERGED', undefined], ['agent-e', 'RETURNED', 'claims']], r.stdout + r.stderr)
  assert.ok(out.results[1].detail.some((d) => /double/.test(d)), JSON.stringify(out.results[1]))
})
