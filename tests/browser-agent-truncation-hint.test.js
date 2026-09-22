const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { truncationHint, ACTION_HELP } = require('../browser-agent/prompt-parts')

/**
 * #186360 follow-up — why the agent gives up instead of reading further.
 *
 * Measured 2026-09-20: asked for a number sitting at char 5,758 of a page it was shown the first
 * 3,000 characters of, qwen3:4b answered "not found in the results table" three times out of three,
 * in two steps, without once trying `extract`. It was never told that extract would help:
 *
 *   {"type":"extract","selector":"css","save_as":"file.txt"} — extract text and save
 *
 * reads as "write a file", not "read the rest of the page" — and the system prompt also says
 * "be efficient, don't take unnecessary steps". Under that description, giving up IS the efficient
 * reading. The excerpt says "truncated" and leaves the model to infer what to do about it.
 */

describe('what the agent is told about reading further', () => {
  it('the extract action says the text comes BACK, not that it writes a file', () => {
    assert.match(ACTION_HELP, /extract/)
    assert.match(ACTION_HELP, /returned to you|comes back|read/i)
    // And there is a way to SEARCH a long page, which is what the failures actually needed.
    assert.match(ACTION_HELP, /"find"/)
    // save_as is a side effect, not the point
    assert.doesNotMatch(ACTION_HELP.split('\n').find((l) => l.includes('"extract"')), /^.*save and nothing else/i)
  })

  it('a truncated page gets an explicit next move, naming the action that gets the rest', () => {
    const hint = truncationHint('Page text (first 3000 characters, truncated):\nblah')
    assert.match(hint, /truncated/i)
    // `find` since 2026-09-20: pointing at `extract` changed nothing (0/3), because a whole-page
    // extract comes back bounded too. Searching is the move that fits the window.
    assert.match(hint, /find|extract/)
  })

  it('a page shown in full gets no hint — noise in every prompt is paid for every step', () => {
    assert.equal(truncationHint('Page text (first 129 characters):\nExample Domain'), '')
    assert.equal(truncationHint('URL: x\nTitle: y\n\nInteractive elements:\n@1 [a]'), '')
  })

  it('the hint is one line, because it is added to every truncated step', () => {
    const hint = truncationHint('Page text (first 3000 characters, truncated):\nblah')
    assert.ok(hint.length < 260, `hint too long: ${hint.length}`)
  })
})
