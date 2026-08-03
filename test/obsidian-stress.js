#!/usr/bin/env node
/**
 * Obsidian driver — stress + correctness suite.
 *
 * Runs against the REAL vaults on this machine, not fixtures, plus a synthetic vault of
 * deliberately hostile notes. Fixtures would only prove the parser handles what I thought
 * to write; real vaults are where the surprises live.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')
const o = require('../drivers/obsidian')

let pass = 0
let fail = 0
const failures = []

function t(name, fn) {
  try {
    fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    failures.push({ name, error: e.message })
    console.log(`  ✗ ${name}\n      ${e.message}`)
  }
}

function section(s) {
  console.log(`\n${s}`)
}

// ── synthetic vault of hostile inputs ─────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-stress-'))
fs.mkdirSync(path.join(tmp, '.obsidian'), { recursive: true })
fs.mkdirSync(path.join(tmp, 'nested', 'deep'), { recursive: true })
fs.mkdirSync(path.join(tmp, '.trash'), { recursive: true })

const write = (rel, body) => fs.writeFileSync(path.join(tmp, rel), body, 'utf-8')

write('simple.md', '# Hello\n\nPlain note with #tag1 and #nested/tag2.\n')
write('frontmatter.md', '---\ntitle: With FM\ntags: [alpha, beta]\nstatus: active\n---\n\nBody after frontmatter.\n')
write('fm-list.md', '---\ntags:\n  - one\n  - two\n---\n\nList-style frontmatter.\n')
write('links.md', 'See [[Target Note]] and [[Other|alias]] and [[Third#heading]].\n')
write('unicode.md', '# 日本語 — émoji 🎉\n\nBody with ünïcödé and #tåg.\n')
write('empty.md', '')
write('no-close-fm.md', '---\ntitle: broken\nthis never closes\n')
write('big.md', '# Big\n\n' + 'x'.repeat(300000))
write('nested/deep/buried.md', 'Buried note mentioning vanguard.\n')
write('.trash/deleted.md', 'Should never be listed.\n')
write('malformed-fm.md', '---\n: : :\n[[[\n---\n\nStill has a body.\n')

// ── driver correctness ────────────────────────────────────────────────────────
section('Driver — vault detection')
t('detects a real vault', () => assert.strictEqual(o.isVault(tmp), true))
t('rejects a non-vault dir', () => assert.strictEqual(o.isVault(os.tmpdir()), false))
t('rejects a nonexistent path', () => assert.strictEqual(o.isVault('/nope/does/not/exist'), false))

section('Driver — listing')
const notes = o.listNotes(tmp)
t('finds notes recursively', () => assert.ok(notes.length >= 10, `got ${notes.length}`))
t('skips .trash', () => assert.ok(!notes.some((n) => n.path.includes('.trash'))))
t('walks nested folders', () => assert.ok(notes.some((n) => n.path === path.join('nested', 'deep', 'buried.md'))))
t('reports folder for nested notes', () => {
  const b = notes.find((n) => n.name === 'buried')
  assert.strictEqual(b.folder, path.join('nested', 'deep'))
})
t('reports empty folder for root notes', () => {
  assert.strictEqual(notes.find((n) => n.name === 'simple').folder, '')
})
t('respects limit', () => assert.strictEqual(o.listNotes(tmp, { limit: 3 }).length, 3))
t('scopes to a folder', () => {
  const scoped = o.listNotes(tmp, { folder: 'nested' })
  assert.ok(scoped.length >= 1 && scoped.every((n) => n.path.startsWith('nested')))
})

section('Driver — frontmatter')
t('parses scalar + inline list', () => {
  const n = o.readNote(tmp, 'frontmatter.md')
  assert.strictEqual(n.frontmatter.title, 'With FM')
  assert.deepStrictEqual(n.frontmatter.tags, ['alpha', 'beta'])
  assert.ok(!n.body.startsWith('---'), 'body should not include the frontmatter block')
})
t('parses list-style frontmatter', () => {
  assert.deepStrictEqual(o.readNote(tmp, 'fm-list.md').frontmatter.tags, ['one', 'two'])
})
t('unterminated frontmatter is not swallowed', () => {
  const n = o.readNote(tmp, 'no-close-fm.md')
  assert.ok(n.body.length > 0, 'body must survive')
})
t('malformed frontmatter still yields a body', () => {
  assert.ok(o.readNote(tmp, 'malformed-fm.md').body.includes('Still has a body'))
})
t('empty file does not throw', () => {
  const n = o.readNote(tmp, 'empty.md')
  assert.strictEqual(n.body, '')
})

section('Driver — tags and links')
t('extracts inline tags', () => {
  const tags = o.readNote(tmp, 'simple.md').tags
  assert.ok(tags.includes('tag1'), JSON.stringify(tags))
  assert.ok(tags.includes('nested/tag2'), JSON.stringify(tags))
})
t('merges frontmatter tags', () => {
  const tags = o.readNote(tmp, 'frontmatter.md').tags
  assert.ok(tags.includes('alpha') && tags.includes('beta'), JSON.stringify(tags))
})
t('extracts wikilinks incl. alias and heading forms', () => {
  const links = o.readNote(tmp, 'links.md').links
  assert.ok(links.includes('Target Note'), JSON.stringify(links))
  assert.ok(links.includes('Other'), 'alias form [[X|y]] should yield X')
  assert.ok(links.includes('Third'), 'heading form [[X#h]] should yield X')
})
t('handles unicode in body and tags', () => {
  const n = o.readNote(tmp, 'unicode.md')
  assert.ok(n.body.includes('日本語'))
  assert.ok(n.tags.includes('tåg'), JSON.stringify(n.tags))
})

section('Driver — safety')
t('rejects ../ path escape', () => {
  assert.throws(() => o.readNote(tmp, '../../etc/passwd'), /escapes the vault/i)
})
t('rejects absolute path escape', () => {
  assert.throws(() => o.readNote(tmp, '/etc/passwd'), /escapes the vault/i)
})
t('rejects sneaky nested escape', () => {
  assert.throws(() => o.readNote(tmp, 'nested/../../../../etc/hosts'), /escapes the vault/i)
})

section('Driver — large files')
t('truncates a 300KB note and flags it', () => {
  const n = o.readNote(tmp, 'big.md', { maxBody: 1000 })
  assert.strictEqual(n.body.length, 1000)
  assert.strictEqual(n.truncated, true)
})
t('does not flag truncation when it fits', () => {
  assert.strictEqual(o.readNote(tmp, 'simple.md').truncated, false)
})

section('Driver — search')
t('matches on name', () => {
  const r = o.searchNotes(tmp, 'buried')
  assert.ok(r.some((x) => x.name === 'buried' && x.matched === 'name'))
})
t('matches on body', () => {
  const r = o.searchNotes(tmp, 'vanguard')
  assert.ok(r.length >= 1 && r[0].snippet, 'expected a body hit with a snippet')
})
t('is case-insensitive', () => {
  assert.ok(o.searchNotes(tmp, 'VANGUARD').length >= 1)
})
t('empty query returns nothing', () => assert.strictEqual(o.searchNotes(tmp, '').length, 0))
t('no-match returns empty, not an error', () => {
  assert.strictEqual(o.searchNotes(tmp, 'zzzz-not-present-zzzz').length, 0)
})
t('respects search limit', () => assert.ok(o.searchNotes(tmp, 'e', { limit: 2 }).length <= 2))

// ── real vaults ───────────────────────────────────────────────────────────────
section('Real vaults on this machine')
const t0 = Date.now()
const vaults = o.discoverVaults()
const discoverMs = Date.now() - t0

t('discovers at least one real vault', () => assert.ok(vaults.length >= 1, 'none found'))
t(`discovery completes under 30s (took ${discoverMs}ms)`, () => assert.ok(discoverMs < 30000))

let totalNotes = 0
for (const v of vaults) {
  const name = path.basename(v)
  const lt0 = Date.now()
  const vNotes = o.listNotes(v, { limit: 5000 })
  const listMs = Date.now() - lt0
  totalNotes += vNotes.length

  t(`[${name}] lists ${vNotes.length} notes in ${listMs}ms`, () => {
    assert.ok(vNotes.length >= 0)
    assert.ok(listMs < 20000, `listing took ${listMs}ms`)
  })

  if (vNotes.length) {
    t(`[${name}] reads every note without throwing (sampled 25)`, () => {
      const sample = vNotes.slice(0, 25)
      for (const n of sample) o.readNote(v, n.path, { maxBody: 5000 })
    })
    const st0 = Date.now()
    const hits = o.searchNotes(v, 'the', { limit: 20 })
    t(`[${name}] search returns ${hits.length} hits in ${Date.now() - st0}ms`, () => {
      assert.ok(Date.now() - st0 < 30000)
    })
  }
}

section('Summary')
console.log(`  vaults: ${vaults.length}   notes indexed: ${totalNotes}   discovery: ${discoverMs}ms`)

fs.rmSync(tmp, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`)
}
process.exit(fail ? 1 : 0)
