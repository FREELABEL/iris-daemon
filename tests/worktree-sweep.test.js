// #188702: the sweep removes only worktrees that lose nothing, and says why it kept the rest.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { sweep } = require('../lib/worktree-sweep')

// Commits dated 10 days ago: the sweep counts a recent commit as recent use, correctly.
const OLD = new Date(Date.now() - 10 * 86_400_000).toISOString()
const sh = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe', env: { ...process.env, GIT_COMMITTER_DATE: OLD, GIT_AUTHOR_DATE: OLD } }).toString()
function old (p) { const t = (Date.now() - 10 * 86_400_000) / 1000; fs.utimesSync(p, t, t) }

test('removes clean+pushed+idle, keeps dirty, unpushed and recent', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wts-')))
  const origin = path.join(root, 'origin.git'); fs.mkdirSync(origin); sh(origin, 'init', '-q', '--bare')
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo)
  sh(repo, 'init', '-q'); sh(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  sh(repo, 'remote', 'add', 'origin', origin); sh(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main'); sh(repo, 'fetch', '-q', 'origin')
  const add = (n) => { const p = path.join(root, n); sh(repo, 'worktree', 'add', '-q', '--detach', p, 'origin/main'); return p }
  const done = add('done'); old(done)
  const dirty = add('dirty'); fs.writeFileSync(path.join(dirty, 'x.txt'), 'work'); old(dirty)
  const local = add('local'); sh(local, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'only here'); old(local)
  const fresh = add('fresh')

  const r = await sweep({ roots: [root], log: () => {} })
  assert.strictEqual(fs.existsSync(done), false, 'clean, pushed, idle -> removed')
  for (const p of [dirty, local, fresh]) assert.ok(fs.existsSync(p), `${path.basename(p)} kept`)
  assert.strictEqual(fs.readFileSync(path.join(dirty, 'x.txt'), 'utf-8'), 'work')
  assert.strictEqual(r.removed, 1)
  assert.strictEqual(r.count, 3)
  assert.deepStrictEqual(r.kept, { 'uncommitted changes': 1, '1 commit(s) on no remote': 1, 'used in the last 3 days': 1 })
})

test('dry run removes nothing', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wts-')))
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo)
  sh(repo, 'init', '-q'); sh(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  const p = path.join(root, 'w'); sh(repo, 'worktree', 'add', '-q', '--detach', p); old(p)
  // No remote at all: HEAD is on no remote branch, so it is kept regardless.
  const r = await sweep({ roots: [root], apply: false, log: () => {} })
  assert.ok(fs.existsSync(p)); assert.strictEqual(r.removed, 0)
})

test('a commit whose identical change is already on main counts as saved (rebased elsewhere)', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wts-')))
  const origin = path.join(root, 'origin.git'); fs.mkdirSync(origin); sh(origin, 'init', '-q', '--bare')
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo)
  const c = (cwd, m) => sh(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', m)
  sh(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a'), '1\n'); sh(repo, 'add', 'a'); c(repo, 'init')
  sh(repo, 'remote', 'add', 'origin', origin); sh(repo, 'push', '-q', 'origin', 'main'); sh(repo, 'fetch', '-q', 'origin')
  sh(repo, 'remote', 'set-head', 'origin', 'main')
  const wt = path.join(root, 'wt'); sh(repo, 'worktree', 'add', '-q', '-b', 'feat', wt, 'origin/main')
  fs.writeFileSync(path.join(wt, 'b'), 'feature\n'); sh(wt, 'add', 'b'); c(wt, 'feature')
  // The same change lands on main from another clone, under a different hash.
  const other = path.join(root, 'other'); sh(root, 'clone', '-q', '-b', 'main', origin, other)
  fs.writeFileSync(path.join(other, 'z'), 'z\n'); sh(other, 'add', 'z'); c(other, 'unrelated first')
  fs.writeFileSync(path.join(other, 'b'), 'feature\n'); sh(other, 'add', 'b'); c(other, 'feature (rebased)')
  sh(other, 'push', '-q', 'origin', 'HEAD:main'); sh(wt, 'fetch', '-q', 'origin')
  old(wt)
  const { unsavedCommits } = require('../lib/worktree-sweep')
  assert.strictEqual(await unsavedCommits(wt), 0)
  // A genuinely new change is still unsaved.
  fs.writeFileSync(path.join(wt, 'c'), 'only here\n'); sh(wt, 'add', 'c'); c(wt, 'only here')
  assert.strictEqual(await unsavedCommits(wt), 1)
})
