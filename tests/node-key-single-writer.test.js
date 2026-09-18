'use strict'

// ONE writer of the node key (#185896).
//
// A client's machine held a key the hub had never heard of. The cause was not one bug but a count:
// eleven places across two repos minted node keys — five installer blocks, a PowerShell installer,
// daemonctl twice, `iris hive connect`, and the daemon — through two different endpoints, nine of
// them without a machine fingerprint. Any one of them drifting stranded a machine, and nothing
// failed when a twelfth was added.
//
// The daemon now owns enrollment (daemon/node-key-heal.js). This test fails the moment anything
// else in this repo calls a key-minting endpoint, so the count cannot quietly grow back.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const OWNER = 'daemon/node-key-heal.js'
// Hub endpoints that RETURN a new node key.
const MINT = /\/api\/v1\/hive\/register-node|\/api\/v6\/nodes['"`]\s*,\s*\{[^}]*method:\s*['"]POST/s
const SKIP_DIRS = new Set(['node_modules', 'tests', '.git', 'daemon-data', 'som', 'playwright-report', 'test-results'])

function walk (dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(js|cjs|mjs|sh)$/.test(e.name) || ['daemonctl', 'bridgectl'].includes(e.name)) out.push(p)
  }
  return out
}

function stripComments (src) {
  return src
    .split('\n')
    .filter(l => !/^\s*(#|\/\/|\*|\/\*)/.test(l))
    .join('\n')
}

test('only the daemon mints node keys', () => {
  const minters = walk(ROOT)
    .filter(f => !path.basename(f).startsWith('test-')) // dev harnesses that register throwaway nodes
    .filter(f => MINT.test(stripComments(fs.readFileSync(f, 'utf-8'))))
    .map(f => path.relative(ROOT, f))
  assert.deepStrictEqual(minters, [OWNER], `node keys must have ONE writer. Found: ${minters.join(', ')}`)
})

test('the guard can see a minting call (so a pass above means something)', () => {
  assert.ok(MINT.test(stripComments(fs.readFileSync(path.join(ROOT, OWNER), 'utf-8'))))
  assert.ok(MINT.test('curl -d x "https://raichu.heyiris.io/api/v1/hive/register-node"'))
  assert.ok(!MINT.test('# issued per machine by /hive/register-node'.replace(/^#.*$/m, '')))
})
