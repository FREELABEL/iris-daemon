'use strict'

// The desktop app's Hive menu, launchd and cron run daemonctl with a GUI PATH that has no node.
// Every `node` call then failed: "Hive: Daemon Status" said "Not running" on a running daemon and
// "Restart" could not start it again (2026-09-18). daemonctl now finds node itself.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const CTL = path.join(__dirname, '..', 'daemonctl')
const GUI_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

// Run only daemonctl's preamble (through `export PATH`), then report which node it would use.
function nodeSeenBy (home) {
  const src = fs.readFileSync(CTL, 'utf-8')
  const preamble = src.slice(0, src.indexOf('export PATH') + 'export PATH'.length)
  return execFileSync('/bin/bash', ['-c', `${preamble}\ncommand -v node || echo NONE`], {
    env: { HOME: home, PATH: GUI_PATH }, encoding: 'utf-8'
  }).trim()
}

test('with a GUI PATH, daemonctl finds the node the installer ships', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-'))
  const bin = path.join(home, '.iris', 'runtime', 'node-v22.0.0-test', 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.symlinkSync(process.execPath, path.join(bin, 'node'))
  assert.strictEqual(nodeSeenBy(home), path.join(bin, 'node'))
})

test('the resolver runs before daemonctl first uses node', () => {
  const src = fs.readFileSync(CTL, 'utf-8')
  const firstUse = src.search(/^[^#\n]*\bnode\s/m)
  assert.ok(src.indexOf('export PATH') > -1)
  assert.ok(src.indexOf('export PATH') < firstUse, 'a `node` call runs before PATH is fixed')
})
