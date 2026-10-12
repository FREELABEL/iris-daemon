'use strict'

/**
 * Fail-first: does the new test actually catch the bug? (#189149)
 *
 * A fix arrives with a test. The test passes. That proves nothing on its own — a test that
 * would also have passed BEFORE the fix is decoration, and agents write those routinely (an
 * assertion on the mock, a check the old code already satisfied). The only evidence that a
 * test guards the bug is that it FAILS on the code that had the bug and PASSES on the fix.
 *
 * So: take the tests the change added or edited, put them on the base commit's code, run them
 * — they must fail — then run them on the tip — they must pass. Four outcomes, one of them good:
 *
 *   BITES      fails on base, passes on tip        the test guards the fix
 *   TOOTHLESS  passes on base                      the test would not have caught the bug
 *   BROKEN     fails on tip                        the fix does not pass its own test
 *   NO_TESTS   the change touched no test file     nothing to judge — say so, never "pass"
 *
 * This file is the pure part (which files are tests, what the exit codes mean); the git and
 * process work is in scripts/fail-first.js.
 */

// Path shapes that mean "this file is a test", across the stacks this fleet runs:
// PHPUnit (FooTest.php, tests/), bun/jest/vitest (*.test.ts, *.spec.js), node:test (tests/*.test.js),
// pytest (test_*.py, *_test.py), go (*_test.go).
const TEST_PATTERNS = [
  /(^|\/)tests?\//i,
  /(^|\/)__tests__\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /Test\.php$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.(py|go)$/,
]

/** Which of the changed paths are tests. Deleted files are the caller's job to drop. */
function testFilesIn (paths) {
  return [...new Set((paths || []).map(String).filter(Boolean))].filter((p) => TEST_PATTERNS.some((re) => re.test(p)))
}

/**
 * The verdict from two exit codes. `null` means the run did not happen (timed out, could not
 * start) — that is never read as a pass or a fail, because a check that cannot run must not
 * report a result.
 */
function verdict ({ testFiles, baseExit, tipExit }) {
  if (!testFiles || testFiles.length === 0) {
    return { verdict: 'NO_TESTS', ok: false, why: 'the change adds or edits no test file — nothing shows the fix is guarded' }
  }
  if (baseExit === null || baseExit === undefined) {
    return { verdict: 'UNRUN', ok: false, why: 'the tests could not be run on the base commit' }
  }
  if (tipExit === null || tipExit === undefined) {
    return { verdict: 'UNRUN', ok: false, why: 'the tests could not be run on the tip commit' }
  }
  if (tipExit !== 0) {
    return { verdict: 'BROKEN', ok: false, why: `the tests fail on the tip (exit ${tipExit}) — the fix does not pass its own test` }
  }
  if (baseExit === 0) {
    return { verdict: 'TOOTHLESS', ok: false, why: 'the tests also pass on the base — they would not have caught the bug' }
  }
  return { verdict: 'BITES', ok: true, why: `fails on base (exit ${baseExit}), passes on tip — the test guards the fix` }
}

/** One line a person or a PR comment can read. */
function summary (v, { base, tip, testFiles }) {
  const mark = v.ok ? '✓' : '✗'
  const files = (testFiles || []).slice(0, 5).join(', ') + ((testFiles || []).length > 5 ? ` (+${testFiles.length - 5})` : '')
  return `${mark} fail-first ${v.verdict}: ${v.why}\n  base ${String(base).slice(0, 10)} → tip ${String(tip).slice(0, 10)}${files ? `\n  tests: ${files}` : ''}`
}

const path = require('path')

/** The CLI the rule points at, beside this file in the installed daemon. */
const FAIL_FIRST_SCRIPT = path.join(__dirname, '..', 'scripts', 'fail-first.js')
const RULE_HEAD = '## Hive rule: prove the test bites'

/**
 * The second rule a Hive coding task carries (#189149). Unlike the proof video it applies to
 * PHI tasks too: nothing leaves the node, it only runs the repo's own tests twice.
 */
function failFirstRule (scriptPath = FAIL_FIRST_SCRIPT) {
  return [
    RULE_HEAD,
    'A fix needs a test that FAILS on the code before your change and PASSES after it.',
    '1. Add or edit the test that reproduces the bug, alongside the fix, and commit both.',
    `2. Run: \`node ${scriptPath} -- <the command that runs that test>\` from the repo, on your branch.`,
    '   It puts your tests on the base commit (must fail), then runs them on your tip (must pass).',
    '3. Put its one-line verdict in your final summary. Only BITES is a pass. TOOTHLESS means the test',
    '   would not have caught the bug — strengthen it; never weaken an assertion to get BITES.',
    'Skip only when the change is not a fix (docs, a new feature with no prior behaviour), and say so.'
  ].join('\n')
}

function withFailFirstRule (prompt, { enabled = true, scriptPath = FAIL_FIRST_SCRIPT } = {}) {
  const p = String(prompt || '')
  if (!enabled || p.includes(RULE_HEAD)) return p
  return `${p}\n\n${failFirstRule(scriptPath)}`
}

/**
 * What a code_generation task's agent receives: its prompt, the proof-video rule (#188292,
 * skipped for PHI), and the fail-first rule. Opt out with config.fail_first=false.
 */
function codingPrompt (task, { phi = false } = {}) {
  const withProof = require('./pr-proof').promptForCodingTask(task, { phi })
  return withFailFirstRule(withProof, { enabled: !(task && task.config && task.config.fail_first === false) })
}

module.exports = { TEST_PATTERNS, testFilesIn, verdict, summary, FAIL_FIRST_SCRIPT, failFirstRule, withFailFirstRule, codingPrompt }
