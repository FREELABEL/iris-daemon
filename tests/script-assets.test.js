const { describe, it } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { planAssetWrite } = require('../daemon/script-assets')

/**
 * M6.2, node side — writing a script's assets into its working directory.
 *
 * The server already validates paths on upload. THIS VALIDATES THEM AGAIN, and that is not
 * redundancy for its own sake: this is the code that actually reaches a filesystem. The
 * server's rules could be relaxed, an older server could be on the other end, or the response
 * could be tampered with in transit — and any of those turns "the server checked" into a
 * sentence nobody can rely on at the moment a file is written.
 */
describe('planAssetWrite — where a downloaded asset is allowed to land', () => {
  const root = '/tmp/work'

  it('resolves a normal path inside the workspace', () => {
    const p = planAssetWrite(root, 'assets/logo.png')
    assert.equal(p.ok, true)
    assert.equal(p.absolute, path.join(root, 'assets/logo.png'))
  })

  /**
   * The whole reason this function exists. Every one of these escapes the workspace if the
   * path is simply joined.
   */
  it('refuses anything that escapes the workspace', () => {
    for (const bad of [
      '../escape.txt', 'a/../../escape', '/etc/passwd', '~/.ssh/authorized_keys',
      'a/./../../b', '..', 'assets/../../../x',
    ]) {
      assert.equal(planAssetWrite(root, bad).ok, false, `must refuse: ${bad}`)
    }
  })

  it('refuses empty, absolute and absurd paths', () => {
    for (const bad of ['', '.', '/', 'a'.repeat(300), 'a\0b']) {
      assert.equal(planAssetWrite(root, bad).ok, false, `must refuse: ${JSON.stringify(bad)}`)
    }
  })

  /**
   * A SYMLINKED WORKSPACE MUST NOT WIDEN THE CHECK. On macOS /tmp is a symlink to
   * /private/tmp, so a naive startsWith against an unresolved root can compare two different
   * spellings of the same directory and get the wrong answer in both directions.
   */
  it('compares resolved paths, not string prefixes', () => {
    const p = planAssetWrite('/tmp/work', 'ok.txt')
    assert.equal(p.ok, true)
    // A sibling directory that shares a string prefix must still be refused.
    assert.equal(planAssetWrite('/tmp/work', '../work-evil/x').ok, false)
  })

  it('reports the reason, so a refusal can be logged usefully', () => {
    const p = planAssetWrite(root, '../x')
    assert.equal(p.ok, false)
    assert.match(p.reason, /workspace/i)
  })
})
