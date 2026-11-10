// The daemon's own /health carries the commit (#192109).
//
// `iris daemon update` restarts the daemon and then polls http://127.0.0.1:3200/health for the
// NEW commit, rolling back if it never appears. Where the bridge (index.js) owns that port, its
// /health has the commit. Where the daemon runs alone — a Windows node's scheduled task runs only
// `node daemon.js` — the daemon's own /health answered, without it, and every update rolled back.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

test('the daemon /health response includes versionFields()', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'index.js'), 'utf-8')
  const route = /app\.get\(`\$\{prefix\}\/health`[\s\S]*?res\.json\(\{([\s\S]*?)\}\)\s*\}\)/.exec(src)
  assert.ok(route, 'could not find the daemon /health route — did it move?')
  assert.match(route[1], /\.\.\.versionFields\(\)/, 'the daemon /health must spread versionFields() (daemon_commit)')
})

test('versionFields() reports the manifest commit', () => {
  const vm = require('../lib/version-manifest')
  const os = require('os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-ver-'))
  const sha = 'a'.repeat(40)
  fs.writeFileSync(path.join(dir, vm.MANIFEST_NAME), JSON.stringify({ commit: sha, files: {} }))
  assert.strictEqual(vm.createReporter(dir).report().daemon_commit, sha)
  fs.rmSync(dir, { recursive: true, force: true })
})
