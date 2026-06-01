#!/usr/bin/env node
'use strict'
//
// Fresh-install gate: every relative require() in the shipped daemon code must
// resolve to a file that ACTUALLY EXISTS in the repo.
//
// This is the test that would have caught #117200: task-executor.js shipped
// `require('./tmux-manager')` but tmux-manager.js was never `git add`ed, so every
// client clone crashed on startup with "Cannot find module './tmux-manager'".
//
// Pure static analysis — no side effects, no network, no daemon boot. Fast + flake-free.
//
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const RESOLVE_EXTS = ['', '.js', '.cjs', '.mjs', '.json', '.node']
const INDEX_CANDIDATES = ['/index.js', '/index.cjs', '/index.json']

function listJsFiles (dir, recurse) {
  const out = []
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (recurse) out.push(...listJsFiles(full, true))
    } else if (/\.(c?js|mjs)$/.test(e.name)) {
      out.push(full)
    }
  }
  return out
}

function resolves (fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec)
  for (const ext of RESOLVE_EXTS) {
    const p = base + ext
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return true
  }
  for (const idx of INDEX_CANDIDATES) {
    if (fs.existsSync(base + idx)) return true
  }
  return false
}

// Scan: all of daemon/ recursively, plus root-level entry scripts.
const files = [
  ...listJsFiles(path.join(ROOT, 'daemon'), true),
  ...fs.readdirSync(ROOT)
    .filter((f) => /\.(c?js|mjs)$/.test(f))
    .map((f) => path.join(ROOT, f))
]

// Matches require('./x'), require("../x/y") — relative specifiers only.
const RE_REQUIRE = /require\(\s*(['"])(\.\.?\/[^'"]+)\1\s*\)/g

const failures = []
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8')
  let m
  while ((m = RE_REQUIRE.exec(src))) {
    const spec = m[2]
    if (!resolves(file, spec)) {
      failures.push(`${path.relative(ROOT, file)} → require('${spec}') does NOT resolve`)
    }
  }
}

if (failures.length) {
  console.error('✗ Broken relative require(s) — these crash a fresh client install:')
  for (const f of failures) console.error('  - ' + f)
  console.error(`\n${failures.length} broken require(s). Did you forget to \`git add\` a file?`)
  process.exit(1)
}
console.log(`✓ All relative requires resolve across ${files.length} scanned file(s) — no missing-file crashes.`)
