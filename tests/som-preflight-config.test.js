// The som_batch preflight (#190301). It looked for som-config.js only inside a freelabel checkout,
// so on iris-hive-001 (bundled som/ dir, no checkout) it printed "using inline fallback —
// som-config.js not found" 6 times a run and skipped the real eligibility check.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { somConfigCandidates, getSomPreflightCheck } = require('../daemon/task-executor')

test('the bundled som/som-config.js is looked at first', () => {
  const [first] = somConfigCandidates(null)
  assert.strictEqual(first, path.join(__dirname, '..', 'som', 'som-config.js'))
  assert.ok(fs.existsSync(first))
})

test('a freelabel checkout is still a fallback', () => {
  const c = somConfigCandidates('/x/freelabel')
  assert.strictEqual(c[1], path.join('/x/freelabel', 'tests', 'e2e', 'som-config.js'))
})

test('with no checkout the real preflight loads, not the inline fallback', () => {
  const check = getSomPreflightCheck()
  assert.strictEqual(check, require('../som/som-config').preflightCheck)
})
