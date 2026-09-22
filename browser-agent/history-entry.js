/**
 * What one step tells the model on the next turn.
 *
 * The loop used to record `result.message` only — so an `extract` became "Extracted 12345 chars"
 * and the text it found was dropped on the floor. Combined with a snapshot that listed only
 * clickable elements, the agent could never see a word of a page: measured 2026-09-20, five runs
 * of five failed to read one number out of a table, each burning the full step budget.
 *
 * Bounded on purpose. History is replayed into every later prompt, so an unbounded excerpt is
 * paid for once per remaining step.
 */

const DEFAULT_DATA_CHARS = Number(process.env.BROWSER_AGENT_DATA_CHARS) || 600

function historyEntry(action, result, opts = {}) {
  const limit = opts.dataChars ?? DEFAULT_DATA_CHARS
  let line = String(action?.type ?? 'action')
  if (action?.element) line += ` ${action.element}`
  if (action?.text) line += ` "${String(action.text).slice(0, 30)}"`
  if (action?.url) line += ` ${action.url}`
  line += ` → ${result?.message ?? ''}`
  let repeated = false
  if (result?.data) {
    const data = typeof result.data === 'string' ? result.data : JSON.stringify(result.data)
    const shown = data.slice(0, limit)
    line += `\n${shown}`
    if (data.length > limit) {
      // "…[truncated]" alone made the same whole-page extract look worth repeating: the model got
      // the same first 600 chars three times and ran out of steps (measured 2026-09-20). Say what
      // to do instead.
      line += ` …[truncated — ${data.length} chars in total; narrow it with a selector, e.g. {"type":"extract","selector":"table"}]`
    }
    // The SAME action returning the SAME text is not progress, and the model cannot see that from
    // one entry at a time.
    const prior = Array.isArray(opts.history) ? opts.history : []
    repeated = prior.some((h) => typeof h === 'string' && h.startsWith(line.split('\n')[0]) && h.includes(shown.slice(0, 80)))
  }
  if (repeated) line += '\n[same result as an earlier step — try something different]' 
  if (result && result.ok === false) line += ' [FAILED - try a different approach]'
  return line
}

module.exports = { historyEntry, DEFAULT_DATA_CHARS }
