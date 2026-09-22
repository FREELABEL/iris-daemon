/**
 * Search the page instead of reading it.
 *
 * Every failure measured on 2026-09-20 was the same shape: a window onto a long page, and no way
 * to ask WHERE something is. Shown the first 3,000 of 12,617 characters, the agent answered "not
 * found" — confidently, because what it was shown contained a table that looked like the one it
 * wanted. Told to extract, it got the first 600 characters back three times and gave up.
 *
 * A person does not read a long page from the top; they search it. This returns the matching lines
 * with their neighbours and their line numbers, so the next question can be about a place.
 */

const DEFAULT_MAX = 8
const DEFAULT_CONTEXT = 1

function findInText(text, query, opts = {}) {
  const q = String(query ?? "").trim()
  if (!q) throw new Error('find needs a "text" to look for — say what to find, e.g. {"type":"find","text":"kimi-k3"}')
  const max = opts.max ?? DEFAULT_MAX
  const context = opts.context ?? DEFAULT_CONTEXT
  const lines = String(text ?? "").split("\n")
  const needle = q.toLowerCase()

  const hits = []
  for (let i = 0; i < lines.length; i++) if (lines[i].toLowerCase().includes(needle)) hits.push(i)

  if (hits.length === 0) {
    return { matches: 0, text: `No match for "${q}" — searched ${lines.length} lines of page text.` }
  }

  const out = []
  for (const i of hits.slice(0, max)) {
    const from = Math.max(0, i - context)
    const to = Math.min(lines.length - 1, i + context)
    const block = []
    for (let n = from; n <= to; n++) block.push(`${n + 1 === i + 1 ? "→" : " "} line ${n + 1}: ${lines[n]}`)
    out.push(block.join("\n"))
  }
  const more = hits.length > max ? `\n…and ${hits.length - max} more match(es); narrow the text to see them.` : ""
  return {
    matches: hits.length,
    text: `${hits.length} match(es) for "${q}" in ${lines.length} lines:\n${out.join("\n--\n")}${more}`,
  }
}

module.exports = { findInText, DEFAULT_MAX, DEFAULT_CONTEXT }
