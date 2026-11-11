'use strict'

// #193188 — what a live session's worktree has touched, measured against a REAL git repository
// (a bare "origin" and a clone with a branch), not a fake: the point of the field is what git
// says, and a typed fake of git would only agree with whoever typed it.
//
// The last test prints the payload shape the server parses; fl-iris-api keeps a copy of that
// output at tests/Unit/Hive/fixtures/work_files.json (WorkOverlapTest), so the key names on both
// sides come from here.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { collectWorkFiles, touchedFor, liveFolders } = require('../daemon/work-files')

const sh = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })

function repo () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-files-'))
  const origin = path.join(dir, 'origin.git')
  const work = path.join(dir, 'work')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' })
  sh(work, 'checkout', '-q', '-b', 'main')
  fs.mkdirSync(path.join(work, 'app/Services'), { recursive: true })
  fs.writeFileSync(path.join(work, 'app/Services/NodeTaskDispatcher.php'), '<?php\n')
  fs.writeFileSync(path.join(work, 'README.md'), 'x\n')
  sh(work, 'add', '.')
  sh(work, 'commit', '-q', '-m', 'base')
  sh(work, 'push', '-q', 'origin', 'main')
  sh(work, 'remote', 'set-head', 'origin', 'main')
  // The remote URL the server will normalise — a real-looking one, set after the push.
  sh(work, 'remote', 'set-url', 'origin', 'git@github.com:FREELABEL/fl-iris-api.git')
  sh(work, 'checkout', '-q', '-b', 'wt/193188-board-overlap')
  return { dir, work }
}

test('a folder that is not a git repository reports nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'))
  assert.strictEqual(await touchedFor(dir), null)
})

test('committed-on-branch, uncommitted and untracked files all count; untouched files do not', async () => {
  const { work } = repo()
  fs.writeFileSync(path.join(work, 'app/Services/NodeTaskDispatcher.php'), '<?php // committed on the branch\n')
  sh(work, 'commit', '-qam', 'branch work')
  fs.writeFileSync(path.join(work, 'README.md'), 'edited, not committed\n')
  fs.writeFileSync(path.join(work, 'app/Services/New.php'), '<?php\n')

  const t = await touchedFor(work)
  assert.strictEqual(t.repo, 'git@github.com:FREELABEL/fl-iris-api.git')
  assert.strictEqual(t.branch, 'wt/193188-board-overlap')
  assert.deepStrictEqual([...t.files].sort(), ['README.md', 'app/Services/New.php', 'app/Services/NodeTaskDispatcher.php'])
})

test('a session in a SUBFOLDER reports paths relative to the repository root, and its own cwd', async () => {
  const { work } = repo()
  fs.writeFileSync(path.join(work, 'app/Services/NodeTaskDispatcher.php'), '<?php // edit\n')
  const sub = path.join(work, 'app')
  const t = await touchedFor(sub)
  assert.strictEqual(t.cwd, sub)
  assert.deepStrictEqual(t.files, ['app/Services/NodeTaskDispatcher.php'])
})

test('a clean branch reports an empty list — looked, nothing touched', async () => {
  const { work } = repo()
  assert.deepStrictEqual((await touchedFor(work)).files, [])
})

test('only live sessions are scanned, each folder once', () => {
  const sessions = [
    { project_path: '/w/a/', status: 'active' },
    { project_path: '/w/a', status: 'needs_you' },
    { project_path: '/w/b', status: 'idle' },
    { project_path: '/w/c', status: 'stale' },
    { project_path: null, status: 'active' },
    { project_path: '/w/d', status: 'needs_you' }
  ]
  assert.deepStrictEqual(liveFolders(sessions), ['/w/a', '/w/d'])
})

test('the heartbeat field: one entry per live folder in a repo, the server-side fixture shape', async () => {
  const { work } = repo()
  fs.writeFileSync(path.join(work, 'app/Services/NodeTaskDispatcher.php'), '<?php // A is editing\n')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'))
  const out = await collectWorkFiles([
    { session_id: 's1', status: 'active', project_path: work },
    { session_id: 's2', status: 'active', project_path: home }, // not a repo: skipped
    { session_id: 's3', status: 'idle', project_path: work }
  ])
  assert.strictEqual(out.length, 1)
  assert.deepStrictEqual(Object.keys(out[0]).sort(), ['branch', 'cwd', 'files', 'repo'])
  assert.deepStrictEqual(out[0].files, ['app/Services/NodeTaskDispatcher.php'])
  if (process.env.WORK_FILES_FIXTURE) {
    fs.writeFileSync(process.env.WORK_FILES_FIXTURE, JSON.stringify({ work_files: out.map((e) => ({ ...e, cwd: '/Users/dev/code/fl-iris-api-wt-1-a' })) }, null, 2) + '\n')
  }
})
