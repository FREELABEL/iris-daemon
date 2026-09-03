'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { readOpencodeModel, readGitBranch } = require('../daemon/opencode-session-meta')

function tmp (p = 'ocmeta-') { return fs.mkdtempSync(path.join(os.tmpdir(), p)) }

test('reads the model from the NEWEST message', () => {
  const d = tmp()
  fs.writeFileSync(path.join(d, 'msg_001.json'), JSON.stringify({ model: { providerID: 'old', modelID: 'old-model' } }))
  fs.writeFileSync(path.join(d, 'msg_002.json'), JSON.stringify({ model: { providerID: 'iris', modelID: 'iris-ai' } }))
  assert.strictEqual(readOpencodeModel(d), 'iris/iris-ai')
  fs.rmSync(d, { recursive: true, force: true })
})

test('it reads ONE file, not all of them', () => {
  // The real cost guard. A measured session had 272 message files; reading them per session
  // on a heartbeat is the recursive-sync-walk failure that wedged a node for 26 hours.
  const d = tmp()
  for (let i = 0; i < 300; i++) {
    fs.writeFileSync(path.join(d, `msg_${String(i).padStart(4, '0')}.json`), JSON.stringify({ model: { providerID: 'p', modelID: `m${i}` } }))
  }
  const realRead = fs.readFileSync
  let reads = 0
  fs.readFileSync = (...a) => { reads++; return realRead(...a) }
  try {
    assert.strictEqual(readOpencodeModel(d), 'p/m299', 'must pick the newest')
    assert.strictEqual(reads, 1, `read ${reads} files; must read exactly 1`)
  } finally {
    fs.readFileSync = realRead
    fs.rmSync(d, { recursive: true, force: true })
  }
})

test('a string model passes through', () => {
  const d = tmp()
  fs.writeFileSync(path.join(d, 'a.json'), JSON.stringify({ model: 'claude-opus-5' }))
  assert.strictEqual(readOpencodeModel(d), 'claude-opus-5')
  fs.rmSync(d, { recursive: true, force: true })
})

test('missing / empty / unreadable all return null rather than throwing', () => {
  // A missing field must never take down the session listing that carries it.
  assert.strictEqual(readOpencodeModel(null), null)
  assert.strictEqual(readOpencodeModel('/does/not/exist'), null)
  const d = tmp(); assert.strictEqual(readOpencodeModel(d), null, 'empty dir')
  fs.writeFileSync(path.join(d, 'bad.json'), 'not json{{')
  assert.strictEqual(readOpencodeModel(d), null, 'malformed json')
  fs.writeFileSync(path.join(d, 'zz.json'), JSON.stringify({ role: 'user' }))
  assert.strictEqual(readOpencodeModel(d), null, 'no model key')
  fs.rmSync(d, { recursive: true, force: true })
})

test('reads a branch from .git/HEAD without spawning git', () => {
  const d = tmp('gitbranch-')
  fs.mkdirSync(path.join(d, '.git'))
  fs.writeFileSync(path.join(d, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  assert.strictEqual(readGitBranch(d), 'main')
  fs.writeFileSync(path.join(d, '.git', 'HEAD'), 'ref: refs/heads/feature/some-thing\n')
  assert.strictEqual(readGitBranch(d), 'feature/some-thing', 'slashes in branch names must survive')
  fs.rmSync(d, { recursive: true, force: true })
})

test('a DETACHED head is null, not a fake branch name', () => {
  // "not on a branch" is not a branch. Inventing one would be worse than admitting we do
  // not have it — the same absence-vs-value confusion as the session status bug.
  const d = tmp('gitdetached-')
  fs.mkdirSync(path.join(d, '.git'))
  fs.writeFileSync(path.join(d, '.git', 'HEAD'), '9f8fb884a1b2c3d4e5f60718293a4b5c6d7e8f90\n')
  assert.strictEqual(readGitBranch(d), null)
  fs.rmSync(d, { recursive: true, force: true })
})

test('a non-repo directory is null, not an error', () => {
  const d = tmp('nogit-')
  assert.strictEqual(readGitBranch(d), null)
  assert.strictEqual(readGitBranch(null), null)
  assert.strictEqual(readGitBranch('/does/not/exist'), null)
  fs.rmSync(d, { recursive: true, force: true })
})

test('against this machine\'s real repo', () => {
  // An end-to-end check against a directory that genuinely is a git checkout.
  const b = readGitBranch(path.join(__dirname, '..'))
  assert.ok(b === null || typeof b === 'string', 'must be a string or null, never undefined')
})

test('handles the ASSISTANT message shape — modelID/providerID at top level', () => {
  // Two shapes live in the same directory. Measured on real data: user messages nest under
  // `model`, assistant messages put modelID/providerID at the top with no `model` key.
  // Handling only the nested form returned null for every session whose newest message was
  // an assistant reply — most of them.
  const d = tmp()
  fs.writeFileSync(path.join(d, 'msg_a.json'), JSON.stringify({ role: 'user', model: { providerID: 'iris', modelID: 'iris-ai' } }))
  fs.writeFileSync(path.join(d, 'msg_b.json'), JSON.stringify({ role: 'assistant', modelID: 'claude-opus-5', providerID: 'anthropic' }))
  assert.strictEqual(readOpencodeModel(d), 'anthropic/claude-opus-5')
  fs.rmSync(d, { recursive: true, force: true })
})

test('a partial shape still yields what it has', () => {
  const d = tmp()
  fs.writeFileSync(path.join(d, 'm.json'), JSON.stringify({ modelID: 'gpt-4o-mini' }))
  assert.strictEqual(readOpencodeModel(d), 'gpt-4o-mini')
  fs.rmSync(d, { recursive: true, force: true })
})

test('does not double the provider prefix', () => {
  // Live data: providerID "iris" with modelID "iris/iris-ai". Blind concatenation produced
  // "iris/iris/iris-ai" — a value that looks like a model and matches nothing.
  const d = tmp()
  fs.writeFileSync(path.join(d, 'm.json'), JSON.stringify({ providerID: 'iris', modelID: 'iris/iris-ai' }))
  assert.strictEqual(readOpencodeModel(d), 'iris/iris-ai')
  fs.rmSync(d, { recursive: true, force: true })
})

test('still prefixes when the modelID does NOT carry the provider', () => {
  const d = tmp()
  fs.writeFileSync(path.join(d, 'm.json'), JSON.stringify({ providerID: 'anthropic', modelID: 'claude-opus-5' }))
  assert.strictEqual(readOpencodeModel(d), 'anthropic/claude-opus-5')
  fs.rmSync(d, { recursive: true, force: true })
})
