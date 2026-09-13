/**
 * #184597 family — name the prerequisite instead of echoing a failed command.
 *
 * Git stopped being an INSTALL requirement on 2026-09-13 (the installers and
 * `iris node install` fetch over HTTPS). It is still a RUNTIME requirement for
 * reference-repo indexing and exchange tasks, and before this guard those failed with
 *
 *     Command failed: git clone https://...
 *
 * which contains the word but never says Git is missing or where to get it.
 */
const assert = require('assert')
const path = require('path')
const { execFileSync } = require('child_process')

let pass = 0, fail = 0
const check = (name, fn) => {
  try { fn(); console.log('  ✓ ' + name); pass++ }
  catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); fail++ }
}

const guardPath = path.join(__dirname, '..', 'lib', 'require-git.js')

console.log('WITH git present (this machine)')
{
  const { gitAvailable, requireGit, _resetGitCache } = require(guardPath)
  _resetGitCache()
  check('gitAvailable() is true', () => assert.strictEqual(gitAvailable(), true))
  check('requireGit does not throw', () => requireGit('Indexing a reference repository'))
}

console.log('')
console.log('WITHOUT git (PATH stripped in a child process — the real client case)')
{
  // Run the guard in a child with no git on PATH. Mocking `execFileSync` would test
  // the mock; emptying PATH tests the thing.
  const script = `
    const { gitAvailable, requireGit } = require(${JSON.stringify(guardPath)})
    let out = { available: gitAvailable(), message: null, code: null }
    try { requireGit('Indexing a reference repository') }
    catch (e) { out.message = e.message; out.code = e.code; out.feature = e.feature }
    console.log(JSON.stringify(out))
  `
  const res = execFileSync(process.execPath, ['-e', script], {
    env: { PATH: '/nonexistent', HOME: process.env.HOME }, encoding: 'utf8',
  })
  const r = JSON.parse(res.trim().split('\n').pop())

  check('gitAvailable() is false', () => assert.strictEqual(r.available, false))
  check('it throws', () => assert.ok(r.message))
  check('code is GIT_MISSING', () => assert.strictEqual(r.code, 'GIT_MISSING'))
  check('names the FEATURE that needed it', () => assert.ok(/Indexing a reference repository/.test(r.message)))
  check('says Git is not installed', () => assert.ok(/Git is not installed/i.test(r.message)))
  check('gives somewhere to get it', () => assert.ok(/git-scm\.com/.test(r.message)))
  // The sentence clients have been acting on wrongly: they think the whole product
  // needs Git, because that is what the installer used to tell them.
  check('says the REST of IRIS does not need Git', () => assert.ok(/Nothing else about this node requires Git/i.test(r.message)))
  check('is not just an echoed command', () => assert.ok(!/^Command failed/.test(r.message)))
}

console.log('')
console.log(`── ${pass} passed · ${fail} failed ──`)
process.exit(fail === 0 ? 0 : 1)
