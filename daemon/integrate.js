'use strict'

/**
 * The integrator: many agents' branches → one branch, decided in code (#189179, #189180).
 *
 * Parallel agents each work in their own worktree. Getting their work back into ONE branch is
 * where it goes wrong, and it is usually done by a person or by a model "merging it all". Every
 * part of that is decidable in code except one:
 *
 *   claims       did each branch touch only what it was given?          code
 *   merge order  one at a time, in the order the coordinator decided    code
 *   tests        run after EACH merge, on the combination                code
 *   gate         a failing or conflicting branch goes back with evidence code
 *   reconcile    two branches changed the same line, both meant it       a model — and only here
 *
 * So this file decides the first four and hands only the fifth to a model, with both versions
 * kept. A branch that comes back twice stops the job unfinished — the alternative is a loop that
 * keeps "fixing" the same piece forever.
 *
 * Pure: hunk parsing, the claims check, the return budget, the report. Git and processes are in
 * scripts/integrate.js.
 */

/**
 * Claims: { "<branch>": ["path", "path#symbol", ...] }. `path` alone means the whole file;
 * `path#symbol` means only edits inside that symbol. Edits with no enclosing symbol (imports, the
 * top of a file) are shared ground: allowed, and a clash there is a merge conflict, which the
 * merge step catches anyway.
 */
function normalizeClaims (raw) {
  const out = {}
  for (const [branch, list] of Object.entries(raw || {})) {
    out[branch] = (Array.isArray(list) ? list : [list]).map(String).map((c) => {
      const i = c.indexOf('#')
      return i === -1 ? { path: c, symbol: null } : { path: c.slice(0, i), symbol: c.slice(i + 1) }
    })
  }
  return out
}

/**
 * Hunks from `git diff -U0 --no-color base..branch`: each with its file, the enclosing symbol git
 * printed after the @@ (its function context), and the changed lines.
 */
function parseHunks (diffText) {
  const hunks = []
  let file = null
  let created = false
  let cur = null
  for (const line of String(diffText || '').split('\n')) {
    if (line.startsWith('diff --git ')) { created = false; continue }
    if (line === '--- /dev/null') { created = true; continue }
    if (line.startsWith('+++ ')) {
      file = line.slice(4).replace(/^b\//, '')
      if (file === '/dev/null') file = null
      continue
    }
    if (line.startsWith('--- ')) continue
    const m = line.match(/^@@ [^@]+ @@ ?(.*)$/)
    if (m) {
      cur = { file, created, context: m[1].trim(), lines: [] }
      hunks.push(cur)
      continue
    }
    if (cur && (line.startsWith('+') || line.startsWith('-'))) cur.lines.push(line.slice(1))
  }
  return hunks.filter((h) => h.file)
}

const wordIn = (name, text) => new RegExp(`(^|[^A-Za-z0-9_$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_$]|$)`).test(text)

/** The symbol a hunk belongs to, judged by git's function context, then by a definition in the hunk. */
function hunkTouches (hunk, symbol) {
  if (hunk.context && wordIn(symbol, hunk.context)) return true
  return hunk.lines.some((l) => /^\s*(def|function|class|async\s+function|const|let|var|public|private|protected|static|export)\b/.test(l) && wordIn(symbol, l))
}

function isShared (hunk) {
  // No enclosing symbol and no definition among the changed lines: the top of the file.
  return !hunk.context && !hunk.lines.some((l) => /^\s*(def|function|class|async\s+function|public|private|protected)\b/.test(l))
}

/** Edits this branch made outside its claims. An unclaimed branch is not checked (returns null). */
function claimViolations (branch, hunks, claims) {
  const mine = claims[branch]
  if (!mine) return null
  const out = []
  for (const h of hunks) {
    // A file this branch CREATED cannot be anyone else's — its own new test, say. Two branches
    // creating the same file is a merge conflict, which the merge step catches.
    if (h.created) continue
    const forFile = mine.filter((c) => c.path === h.file)
    if (forFile.some((c) => c.symbol === null)) continue // the whole file is theirs
    if (forFile.length && forFile.some((c) => hunkTouches(h, c.symbol))) continue
    if (forFile.length && isShared(h)) continue
    out.push({ file: h.file, where: h.context || '(top of file)', claimed: forFile.map((c) => c.symbol).filter(Boolean) })
  }
  // One line per file + place, however many hunks landed there.
  const seen = new Set()
  return out.filter((v) => { const k = `${v.file}|${v.where}`; if (seen.has(k)) return false; seen.add(k); return true })
}

/** The stop rule from the goal: a piece that fails its gate after two returns stops the job. */
function returnBudget (returns, branch, max = 2) {
  const n = (returns[branch] || 0) + 1
  return { count: n, exhausted: n >= max }
}

/**
 * Report over the per-branch results. status per branch: MERGED · RETURNED (claims | conflict |
 * tests) · STOPPED (returned for the max-th time). The job is DONE only if every branch merged.
 */
function report (results, { into, base }) {
  const merged = results.filter((r) => r.status === 'MERGED')
  const stopped = results.filter((r) => r.status === 'STOPPED')
  const outcome = merged.length === results.length ? 'DONE' : stopped.length ? 'STOPPED' : 'PARTIAL'
  const lines = [`${outcome === 'DONE' ? '✓' : '✗'} integrate ${outcome}: ${merged.length} of ${results.length} merged into ${into} (from ${String(base).slice(0, 10)})`]
  for (const r of results) {
    lines.push(`  ${r.status === 'MERGED' ? '✓' : '✗'} ${r.branch}  ${r.status}${r.reason ? ` — ${r.reason}` : ''}`)
    for (const d of (r.detail || []).slice(0, 6)) lines.push(`      ${d}`)
  }
  const conflicts = results.filter((r) => r.why === 'conflict')
  if (conflicts.length) lines.push(`  next: a fresh agent reconciles ${conflicts.map((c) => c.branch).join(', ')} against the plan, keeping both versions — then integrate again`)
  return { outcome, text: lines.join('\n') }
}

module.exports = { normalizeClaims, parseHunks, hunkTouches, claimViolations, returnBudget, report }
