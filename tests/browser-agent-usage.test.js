const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { addUsage, emptyUsage } = require('../browser-agent/usage')

/**
 * What a browser-agent run COST — the number a benchmark reports and a bill is made of.
 *
 * The loop called chat/completions once per step and threw the `usage` block away, so a run's
 * price could only be guessed from step count. A step is not a unit of cost: steps differ by an
 * order of magnitude in prompt size (the DOM goes in every time).
 *
 * The rule these hold: tokens are ADDED UP from what the API reported, and a response that
 * reports nothing is counted as a call with UNKNOWN tokens — never as zero, which would read as
 * "this step was free".
 */

describe('browser-agent token accounting', () => {
  it('adds up what each call reported', () => {
    let u = emptyUsage()
    u = addUsage(u, { prompt_tokens: 1200, completion_tokens: 40 })
    u = addUsage(u, { prompt_tokens: 1800, completion_tokens: 55 })
    assert.deepEqual(u, { calls: 2, promptTokens: 3000, completionTokens: 95, callsWithoutUsage: 0 })
  })

  it('a response with no usage block is a call with UNKNOWN tokens, not a free one', () => {
    const u = addUsage(emptyUsage(), undefined)
    assert.equal(u.calls, 1)
    assert.equal(u.callsWithoutUsage, 1)
    assert.equal(u.promptTokens, 0)
  })

  it('a partial usage block contributes what it has', () => {
    const u = addUsage(emptyUsage(), { prompt_tokens: 500 })
    assert.equal(u.promptTokens, 500)
    assert.equal(u.completionTokens, 0)
    assert.equal(u.callsWithoutUsage, 0)
  })

  it('a non-numeric field does not poison the total with NaN', () => {
    const u = addUsage(emptyUsage(), { prompt_tokens: 'lots', completion_tokens: 10 })
    assert.equal(u.promptTokens, 0)
    assert.equal(u.completionTokens, 10)
    assert.equal(Number.isNaN(u.promptTokens), false)
  })

  it('an empty run reports zero calls — and says nothing about tokens', () => {
    assert.deepEqual(emptyUsage(), { calls: 0, promptTokens: 0, completionTokens: 0, callsWithoutUsage: 0 })
  })
})
