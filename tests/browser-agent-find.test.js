const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { findInText } = require('../browser-agent/find-in-text')

/**
 * Why the agent could not answer from a long page, in three measurements (2026-09-20):
 *   - it was never shown page text at all → fixed;
 *   - shown 3,000 chars of 12,617, it answered "not found" confidently, because what it WAS shown
 *     contained a models table (a different round's) and looked complete;
 *   - told explicitly to extract, it got the first 600 chars of 12,387 back, three times, and gave up.
 *
 * Every one of those is the same shape: a window onto a page, and no way to ask WHERE something is.
 * A person does not read a long page top to bottom; they search it. `find` is that.
 */

const PAGE = [
  'FREELABEL / AGENT MODEL BENCHMARK',
  'Round 01 — groundedness & reliability',
  'Model Floor Mean Peak',
  'mimo-v2.5-pro 77 92 100',
  'kimi-k3 67 67 67',
  'hy3 unusable',
].join('\n')

describe('finding a thing on the page', () => {
  it('returns the line that matches, with its neighbours for context', () => {
    const r = findInText(PAGE, 'kimi-k3')
    assert.match(r.text, /kimi-k3 67 67 67/)
    assert.match(r.text, /mimo-v2.5-pro/) // the line before
    assert.equal(r.matches, 1)
  })

  it('says where it is, so the agent can ask for more around it', () => {
    assert.match(findInText(PAGE, 'kimi-k3').text, /line 5/i)
  })

  it('is case-insensitive — a heading may be upper case', () => {
    assert.equal(findInText(PAGE, 'ROUND 01').matches, 1)
  })

  it('no match is an answer, not an error, and says the page was searched', () => {
    const r = findInText(PAGE, 'gpt-9')
    assert.equal(r.matches, 0)
    assert.match(r.text, /no match|not found/i)
    assert.match(r.text, /\d+ lines?|searched/i)
  })

  it('a query matching everything is capped, and says how many it found', () => {
    const many = Array.from({ length: 200 }, (_, i) => `row ${i} value`).join('\n')
    const r = findInText(many, 'value', { max: 5 })
    assert.equal(r.matches, 200)
    assert.ok(r.text.split('\n').length < 30, 'not capped')
    assert.match(r.text, /200/)
  })

  it('an empty query is refused rather than matching every line', () => {
    assert.throws(() => findInText(PAGE, '   '), /what to find|empty/i)
  })
})
