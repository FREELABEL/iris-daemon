const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { parseAction } = require('../browser-agent/parse-action')

/**
 * Reading the model's chosen action out of whatever it actually replied.
 *
 * The loop did `JSON.parse(content)` with markdown fences stripped. Measured 2026-09-20 against a
 * local qwen3:4b through Ollama: every step failed with "Empty LLM response" — a reasoning model
 * spends its budget in a <think> block, so the JSON arrives AFTER the thinking, or not at all
 * inside a 200-token cap. The cap is the other half of the fix (BROWSER_AGENT_MAX_TOKENS).
 *
 * The rule: find the action object in the reply, whatever is wrapped around it — and when there
 * is none, say so rather than inventing one.
 */

describe('parseAction', () => {
  it('plain JSON', () => {
    assert.deepEqual(parseAction('{"type":"click","element":"@3"}'), { type: 'click', element: '@3' })
  })

  it('fenced JSON, with or without a language tag', () => {
    assert.deepEqual(parseAction('```json\n{"type":"done","result":"ok"}\n```'), { type: 'done', result: 'ok' })
    assert.deepEqual(parseAction('```\n{"type":"done"}\n```'), { type: 'done' })
  })

  it('a reasoning model: the action after a <think> block', () => {
    const reply = '<think>\nThe title is in the h1. I should read it.\n</think>\n{"type":"done","result":"Example Domain"}'
    assert.deepEqual(parseAction(reply), { type: 'done', result: 'Example Domain' })
  })

  it('an unclosed <think> that swallowed the reply is NOT an action', () => {
    assert.equal(parseAction('<think>\nI need to consider the options, first'), null)
  })

  it('prose around the object', () => {
    assert.deepEqual(parseAction('Sure! Here is the next action:\n{"type":"type","element":"@2","text":"hi"}\nHope that helps.'), {
      type: 'type',
      element: '@2',
      text: 'hi',
    })
  })

  it('a nested object is kept whole', () => {
    assert.deepEqual(parseAction('{"type":"done","result":{"title":"A","n":2}}'), { type: 'done', result: { title: 'A', n: 2 } })
  })

  it('empty, whitespace or nothing parseable → null, never a guess', () => {
    for (const r of ['', '   ', '<think>only thinking</think>', 'I cannot do that', '{"broken": ']) {
      assert.equal(parseAction(r), null, JSON.stringify(r))
    }
  })

  it('a JSON array is not an action', () => {
    assert.equal(parseAction('[{"type":"click"}]'), null)
  })
})
