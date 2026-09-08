#!/usr/bin/env node
/**
 * browser_agent is an ADDITIONAL browser lane. These pin the wiring, not the browsing.
 *
 * The production debugging guide's standing lesson is that a new task type needs every layer
 * wired or it silently no-ops: the executor case, the admission gate's concurrency class, and
 * the server-side type allowlist. Miss the allowlist and the API rejects the task before any
 * node sees it — which reads as "the node isn't picking it up", not "the type isn't permitted".
 *
 * So this asserts the layers exist and, just as importantly, that adding this lane did not
 * disturb the Playwright one. `som` and `leadgen` were 18 of the last 30 production tasks.
 */
const fs = require('fs')
const path = require('path')
const assert = require('assert')

const ROOT = path.resolve(__dirname, '..')
const executor = fs.readFileSync(path.join(ROOT, 'daemon/task-executor.js'), 'utf8')
const gate = fs.readFileSync(path.join(ROOT, 'daemon/admission-gate.js'), 'utf8')

// The DECLARATION, not the comment above it that also says BROWSER_TYPES — a naive
// `.find(l => l.includes(...))` returns the comment and reports every type as missing.
const browserTypesLine = gate.split('\n').find(l => l.includes('const BROWSER_TYPES'))
// The whole case block. Slicing a fixed number of characters silently truncated it at 4000
// when the block is 4526, so a real `--bail` read as absent.
const agentCase = executor.slice(
  executor.indexOf("case 'browser_agent':"),
  executor.indexOf("case 'artisan':", executor.indexOf("case 'browser_agent':"))
)

let failed = 0
const test = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`) }
}

console.log('browser_agent executor wiring\n')

test('the executor case exists', () => {
  assert.ok(executor.includes("case 'browser_agent':"), 'no browser_agent case in task-executor')
})

test('it is in the browser concurrency class', () => {
  // Sharing a machine's browser with som/leadgen without sharing their gate would let this
  // lane launch alongside them and contend for the same display and profile.
  assert.ok(browserTypesLine, 'BROWSER_TYPES declaration not found')
  assert.ok(browserTypesLine.includes('browser_agent'), 'browser_agent missing from BROWSER_TYPES')
})

test('it refuses a task with no commands rather than running an empty batch', () => {
  // An empty batch exits 0. A task that "succeeded" having done nothing is the failure shape
  // this codebase keeps paying for.
  assert.ok(
    executor.includes('browser_agent requires config.commands'),
    'no guard for a missing command list'
  )
})

test('it bails on the first failed command by default', () => {
  // agent-browser's own default is continue-all, which reports a failure several commands away
  // from its cause when step one never loaded the page.
  assert.ok(agentCase.includes("'--bail'"), '--bail not applied by default')
})

test('a low Node version warns instead of blocking', () => {
  // agent-browser declares >=24 and demonstrably runs on 22. Rejecting on the declared range
  // would refuse working nodes.
  assert.ok(agentCase.includes('nodeMajor < 24'), 'no node version check at all')
  assert.ok(!/nodeMajor < 24[\s\S]{0,200}reject\(/.test(agentCase), 'low node still hard-rejects')
})

test('the Playwright lane is untouched', () => {
  // The whole point of building this in parallel.
  for (const t of ["case 'custom_playwright':", "case 'som':", "case 'leadgen':"]) {
    assert.ok(executor.includes(t), `${t} disappeared`)
  }
  assert.ok(
    browserTypesLine.includes('custom_playwright') && browserTypesLine.includes("'som'"),
    'playwright types dropped from the gate'
  )
})

test('it translates Playwright storageState rather than passing it through', () => {
  // Found by running it: agent-browser rejects storageState with "no cookies found in input",
  // and because the seed runs inside a --bail batch, every authenticated task would have failed
  // at command one. It accepts a flat cookie array, so the executor extracts .cookies and writes
  // that. Asserting the translation exists, because the naive version looked correct.
  assert.ok(
    agentCase.includes('parsed.cookies') && agentCase.includes('agent-browser-cookies.json'),
    'session file is passed straight through instead of being translated'
  )
})

test('a Chrome profile directory is skipped with a reason, not half-attempted', () => {
  assert.ok(agentCase.includes('isDirectory()'), 'no directory branch — a profile dir would be treated as a cookie file')
})

test('a malformed session file does not take the task with it', () => {
  // The target may not need auth at all; failing the run over an unreadable session would be
  // refusing work we could have done.
  assert.ok(
    /catch \(e\)[\s\S]{0,300}running unauthenticated/.test(agentCase),
    'a bad session file is not caught'
  )
})

test('cookies are seeded AFTER an open, not before it', () => {
  // Network.setCookies fails with "Invalid cookie fields" when no page is open — a message that
  // names the wrong thing entirely. Seeding first, which is the obvious order, fails on every
  // cold browser.
  assert.ok(
    agentCase.includes('[commands[0]].concat(preamble).concat(commands)'),
    'preamble still runs before the first open'
  )
})

test('a session with no leading open explains itself instead of emitting a doomed command', () => {
  assert.ok(
    agentCase.includes('cookies cannot be seeded'),
    'no explanation when the command list cannot carry a seed'
  )
})

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
