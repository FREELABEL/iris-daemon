#!/usr/bin/env node
'use strict'
//
// Fresh-install gate (companion to check-requires.js): the npm-script-backed Hive
// tasks the daemon dispatches must actually be SHIPPABLE — the package.json must
// declare the script AND the file it runs must exist in the package.
//
// Catches the class where the daemon runs `npm run discover:import-yt-feed` but the
// script + som/yt-feed.js were never committed, so `discover` dies on every client
// with "No discover scripts found" — same forgotten-add family as #117200.
//
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const pkg = require(path.join(ROOT, 'package.json'))
const scripts = pkg.scripts || {}

// Scripts the daemon hard-depends on for client-portable (Class-A-able / bundled) tasks.
// Add an entry here when a task type starts dispatching `npm run <script>`.
const REQUIRED = [
  'discover:import-yt-feed', // daemon `discover` task — YouTube feed import
]

const failures = []
for (const name of REQUIRED) {
  const cmd = scripts[name]
  if (!cmd) {
    failures.push(`package.json is missing script "${name}" — the daemon runs \`npm run ${name}\``)
    continue
  }
  // If the script shells `node <file>`, that file must be in the package.
  const m = cmd.match(/node\s+(\.?\/?[^\s]+\.[cm]?js)/)
  if (m) {
    const file = path.join(ROOT, m[1])
    if (!fs.existsSync(file)) {
      failures.push(`script "${name}" runs "${m[1]}" but that file is missing from the package`)
    }
  }
}

if (failures.length) {
  console.error('✗ Task-script gaps — these tasks fail on a fresh client install:')
  for (const f of failures) console.error('  - ' + f)
  console.error(`\n${failures.length} gap(s). Did you forget to commit a script/file?`)
  process.exit(1)
}
console.log(`✓ All ${REQUIRED.length} required task script(s) present, with their files.`)
