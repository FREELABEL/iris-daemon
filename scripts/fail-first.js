#!/usr/bin/env node
'use strict'

/**
 * Does the new test actually catch the bug? Run it on the base, then on the tip (#189149).
 *
 *   node scripts/fail-first.js -- php artisan test --filter=InvoiceTotal
 *   node scripts/fail-first.js --base origin/main -- bun test test/bug-dedupe.test.ts
 *   node scripts/fail-first.js --tests tests/Unit/FooTest.php -- vendor/bin/phpunit tests/Unit/FooTest.php
 *   node scripts/fail-first.js --json -- npm test
 *
 * Run from the repo, on the fix branch. The tests the change added or edited (base..HEAD) are
 * copied onto a throwaway checkout of the base commit and the command runs there — it must FAIL.
 * Then the same command runs on the tip — it must PASS. Dependency folders (node_modules, vendor)
 * are linked from this checkout so the base run uses the same dependencies, not none.
 *
 * Base defaults to the merge-base with origin's default branch. The throwaway checkout is always
 * removed, including on failure. Nothing is committed, pushed or written outside a temp folder.
 *
 * Exit codes: 0 BITES · 1 TOOTHLESS / BROKEN / NO_TESTS / UNRUN · 2 usage or git error.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const F = require('../daemon/fail-first')

function parseArgs (argv) {
  const dash = argv.indexOf('--')
  const own = dash === -1 ? argv : argv.slice(0, dash)
  const cmd = dash === -1 ? [] : argv.slice(dash + 1)
  const out = { cmd, tests: [] }
  for (let i = 0; i < own.length; i++) {
    const a = own[i]
    if (a === '--json' || a === '--help' || a === '-h') { out[a.replace(/^-+/, '')] = true; continue }
    if (a === '--base') { out.base = own[++i]; continue }
    if (a === '--tests') { out.tests.push(...String(own[++i] || '').split(',').filter(Boolean)); continue }
    if (a === '--timeout') { out.timeout = Number(own[++i]); continue }
    throw new Error(`unknown option ${a}`)
  }
  return out
}

function git (args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || r.stdout || '').trim()}`)
  return r.stdout.trim()
}

function defaultBase (cwd) {
  let head = 'origin/main'
  try { head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd) } catch {}
  return git(['merge-base', 'HEAD', head], cwd)
}

/** Run the command in `dir`. Returns the exit code, or null if it could not run or timed out. */
function run (cmd, dir, timeoutMs) {
  const r = spawnSync(cmd.join(' '), { cwd: dir, shell: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', timeout: timeoutMs })
  const tail = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-12).join('\n')
  if (r.error || r.status === null) return { exit: null, tail: tail || String(r.error || 'timed out') }
  return { exit: r.status, tail }
}

function main () {
  let a
  try { a = parseArgs(process.argv.slice(2)) } catch (e) { console.error(e.message); process.exit(2) }
  if (a.help || a.cmd.length === 0) {
    console.error('usage: node scripts/fail-first.js [--base <ref>] [--tests a,b] [--json] -- <test command>')
    process.exit(a.help ? 0 : 2)
  }
  const cwd = process.cwd()
  let root, base, tip, testFiles
  try {
    root = git(['rev-parse', '--show-toplevel'], cwd)
    tip = git(['rev-parse', 'HEAD'], root)
    base = a.base ? git(['rev-parse', a.base], root) : defaultBase(root)
    const changed = git(['diff', '--name-only', '--diff-filter=AMR', `${base}..${tip}`], root).split('\n')
    testFiles = a.tests.length ? a.tests : F.testFilesIn(changed)
  } catch (e) { console.error(e.message); process.exit(2) }

  const timeoutMs = (a.timeout > 0 ? a.timeout : 600) * 1000
  let baseRun = { exit: null, tail: '' }
  let tipRun = { exit: null, tail: '' }
  if (testFiles.length) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fail-first-'))
    const wt = path.join(tmp, 'base')
    try {
      git(['worktree', 'add', '--detach', wt, base], root)
      // The tip's tests, on the base's code.
      for (const f of testFiles) {
        const src = path.join(root, f)
        if (!fs.existsSync(src)) continue
        fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true })
        fs.copyFileSync(src, path.join(wt, f))
      }
      // Same dependencies, not none: a base run that fails on a missing package is not evidence.
      for (const d of ['node_modules', 'vendor']) {
        const src = path.join(root, d)
        if (fs.existsSync(src) && !fs.existsSync(path.join(wt, d))) fs.symlinkSync(src, path.join(wt, d), process.platform === 'win32' ? 'junction' : 'dir')
      }
      baseRun = run(a.cmd, wt, timeoutMs)
    } catch (e) {
      baseRun = { exit: null, tail: e.message }
    } finally {
      try { git(['worktree', 'remove', '--force', wt], root) } catch {}
      fs.rmSync(tmp, { recursive: true, force: true })
    }
    tipRun = run(a.cmd, root, timeoutMs)
  }

  const v = F.verdict({ testFiles, baseExit: baseRun.exit, tipExit: tipRun.exit })
  if (a.json) {
    console.log(JSON.stringify({ ...v, base, tip, test_files: testFiles, command: a.cmd.join(' '), base_exit: baseRun.exit, tip_exit: tipRun.exit }))
  } else {
    console.log(F.summary(v, { base, tip, testFiles }))
    if (!v.ok && v.verdict !== 'NO_TESTS') {
      const t = v.verdict === 'BROKEN' ? tipRun.tail : baseRun.tail
      if (t) console.log(t.split('\n').map((l) => '  | ' + l).join('\n'))
    }
  }
  process.exit(v.ok ? 0 : 1)
}

if (require.main === module) main()
module.exports = { parseArgs }
