const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

/**
 * THE REPO IS NOT WHAT RUNS.
 *
 * launchd starts the daemon via ~/.iris/iris-daemon-wrapper.sh, which does
 * `cd ~/.iris/bridge && exec node daemon.js`. That directory is a SEPARATE checkout of this
 * same repository — different inode, independently updated. Editing a file here, committing it,
 * pushing it and restarting the daemon changes nothing about the process that actually runs.
 *
 * That cost real time on 2026-08-28: a capability probe was added, committed, pushed and the
 * daemon kickstarted, and the field still never appeared in the fleet's heartbeat. It looked
 * like a bug in the hub. The hub was fine; the running daemon had never seen the file.
 *
 * This test asks the RUNNING copy what it contains, in the same spirit as checking
 * RAILWAY_GIT_COMMIT_SHA rather than grepping a local file to confirm a deploy: the artefact
 * that executes is the only one whose contents are evidence.
 *
 * SKIPPED where there is no installed copy — CI, other people's machines, containers — because
 * a test that fails for everyone who is not this laptop is a test that gets deleted.
 */

const INSTALLED = path.join(os.homedir(), '.iris', 'bridge')
const REPO = path.join(__dirname, '..')

function installedIsSeparate () {
  try {
    if (!fs.existsSync(path.join(INSTALLED, 'daemon.js'))) return false
    return fs.statSync(INSTALLED).ino !== fs.statSync(REPO).ino
  } catch {
    return false
  }
}

describe('the installed daemon matches the repo', { skip: !installedIsSeparate() && 'no separate installed copy on this machine' }, () => {
  it('every daemon module in the repo exists in the copy that runs', () => {
    const repoModules = fs.readdirSync(path.join(REPO, 'daemon')).filter((f) => f.endsWith('.js'))
    const missing = repoModules.filter((f) => !fs.existsSync(path.join(INSTALLED, 'daemon', f)))

    assert.deepEqual(
      missing,
      [],
      `${missing.length} module(s) exist here but NOT in the daemon that actually runs ` +
        `(${INSTALLED}): ${missing.join(', ')}. The running daemon cannot use code it does not ` +
        'have — update it with: cd ~/.iris/bridge && git pull',
    )
  })

  it('the heartbeat advertises capabilities in the copy that runs, not just here', () => {
    // Specific rather than generic on purpose: this is the exact field whose absence read as a
    // hub bug for an hour. A module can be present and still not wired in.
    const installedIndex = fs.readFileSync(path.join(INSTALLED, 'daemon', 'index.js'), 'utf-8')
    assert.match(
      installedIndex,
      /probePermissions/,
      'the RUNNING daemon does not probe capabilities — the routing gate will refuse every ' +
        'script that declares requirements, and correctly so. Update ~/.iris/bridge.',
    )
  })
})
