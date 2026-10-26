// playbook_run assigned config.cwd to an undeclared `cwd` and threw "cwd is not defined" on
// every task that set it, so no project playbook could run through Hive (#191214).
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { resolvePlaybookCwd, statusForExit } = require('../daemon/task-executor')

test('an existing absolute directory is the run folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-cwd-'))
  assert.strictEqual(resolvePlaybookCwd({ cwd: dir }), dir)
})

test('no cwd means the default workspace', () => {
  assert.strictEqual(resolvePlaybookCwd(undefined), null)
  assert.strictEqual(resolvePlaybookCwd({}), null)
  assert.strictEqual(resolvePlaybookCwd({ cwd: '' }), null)
})

test('a relative path is refused, not resolved against wherever the daemon started', () => {
  assert.throws(() => resolvePlaybookCwd({ cwd: 'work/freelabel' }), /absolute path/)
})

test('a missing folder or a file is refused, not run somewhere else', () => {
  assert.throws(() => resolvePlaybookCwd({ cwd: '/definitely/not/here-191214' }), /not a directory/)
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-cwd-')), 'f')
  fs.writeFileSync(file, '')
  assert.throws(() => resolvePlaybookCwd({ cwd: file }), /not a directory/)
})

test('the playbook_run case sends cwd to the spawn folder, never a bare `cwd =`', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'task-executor.js'), 'utf8')
  const start = src.indexOf("case 'playbook_run':")
  const block = src.slice(start, src.indexOf('break', start))
  assert.match(block, /workspace\.projectDir = playbookCwd/)
  assert.doesNotMatch(block, /^\s*cwd\s*=/m)
})

test('a failed playbook is failed, not "completed with warnings"', () => {
  assert.strictEqual(statusForExit('playbook_run', 1), 'failed')
  assert.strictEqual(statusForExit('skill_run', 1), 'failed')
  assert.strictEqual(statusForExit('playbook_run', 0), 'completed')
})
