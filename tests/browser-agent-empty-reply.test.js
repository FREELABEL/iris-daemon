const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { emptyReplyMessage } = require('../browser-agent/parse-action')

/**
 * Measured 2026-09-20: qwen3:4b answered step 1 (a blank page) using 704 of its 1200 reply tokens,
 * then returned EMPTY on every later step — the page text made its thinking longer than the budget,
 * so it never reached the JSON. The loop said "Empty LLM response" fourteen times and burned 4.5
 * minutes. The operator cannot act on that sentence; they can act on "it used the whole budget".
 */

describe('what an empty reply says', () => {
  it('budget exhausted: names the setting and the number that proves it', () => {
    const m = emptyReplyMessage({ completion_tokens: 1200 }, 1200)
    assert.match(m, /1200/)
    assert.match(m, /BROWSER_AGENT_MAX_TOKENS/)
    assert.match(m, /thinking|budget/i)
  })

  it('close to the cap counts as exhausted — models stop a token or two short', () => {
    assert.match(emptyReplyMessage({ completion_tokens: 1196 }, 1200), /BROWSER_AGENT_MAX_TOKENS/)
  })

  it('empty with tokens to spare is a different fault, and does not blame the budget', () => {
    const m = emptyReplyMessage({ completion_tokens: 12 }, 1200)
    assert.doesNotMatch(m, /BROWSER_AGENT_MAX_TOKENS/)
    assert.match(m, /empty/i)
  })

  it('no usage reported at all: still says what happened, claims nothing it cannot know', () => {
    const m = emptyReplyMessage(undefined, 1200)
    assert.match(m, /empty/i)
    assert.doesNotMatch(m, /1200 of 1200/)
  })
})
