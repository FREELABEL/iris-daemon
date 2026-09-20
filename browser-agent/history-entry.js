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
  if (result?.data) {
    const data = typeof result.data === 'string' ? result.data : JSON.stringify(result.data)
    const shown = data.slice(0, limit)
    line += `\n${shown}${data.length > limit ? ' …[truncated]' : ''}`
  }
  if (result && result.ok === false) line += ' [FAILED - try a different approach]'
  return line
}

module.exports = { historyEntry, DEFAULT_DATA_CHARS }
