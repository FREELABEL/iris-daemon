/**
 * What a browser-agent run spent, added up from what the API actually reported.
 *
 * The loop makes one chat/completions call per step, and a step is NOT a unit of cost: the whole
 * DOM goes into every prompt, so two runs with the same step count can differ by an order of
 * magnitude. A benchmark that reports steps is not reporting price.
 *
 * A response that carries no `usage` block is recorded as a call with UNKNOWN tokens
 * (`callsWithoutUsage`), never as zero — a zero would read as a free step and quietly understate
 * the bill. Prices live with the caller: they change, and a table baked in here goes stale silently.
 */

function emptyUsage() {
  return { calls: 0, promptTokens: 0, completionTokens: 0, callsWithoutUsage: 0 }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function addUsage(total, usage) {
  const has = usage && (typeof usage.prompt_tokens === 'number' || typeof usage.completion_tokens === 'number')
  return {
    calls: total.calls + 1,
    promptTokens: total.promptTokens + num(usage?.prompt_tokens),
    completionTokens: total.completionTokens + num(usage?.completion_tokens),
    callsWithoutUsage: total.callsWithoutUsage + (has ? 0 : 1),
  }
}

module.exports = { emptyUsage, addUsage }
