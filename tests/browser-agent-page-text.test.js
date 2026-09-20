const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { formatDOM } = require('../browser-agent/dom-extractor')
const { historyEntry } = require('../browser-agent/history-entry')

/**
 * Measured 2026-09-20 (Round 03 on /p/agent-model-benchmark): a browser agent asked to read one
 * number out of a page failed 5 runs of 5, burning all 8 steps and 4.5 minutes each. The model was
 * not the problem — the agent never showed it the page.
 *
 *   1. the snapshot listed INTERACTIVE ELEMENTS only, so a page of prose arrived as
 *      "(no interactive elements found)";
 *   2. `extract` returned the text to the executor, and the loop recorded only its MESSAGE
 *      ("Extracted 12345 chars"), discarding the text itself.
 *
 * So "read the page" was impossible by construction, on every model, at every price.
 * Both are bounded: the whole page goes into every prompt, and an unbounded excerpt is a bill.
 */

describe('the page snapshot carries the page', () => {
  const dom = {
    url: "https://x.test/p",
    title: "A page",
    elements: [{ id: "@1", tag: "a", text: "Home", href: "/" }],
    text: "Table 01 — full results. kimi-k3 scored 67 on the mean.",
  }

  it('includes the page text, so a question about content is answerable', () => {
    const out = formatDOM(dom)
    assert.match(out, /kimi-k3 scored 67/)
    assert.match(out, /Page text/i)
  })

  it('still lists the interactive elements', () => {
    assert.match(formatDOM(dom), /@1 \[a\] "Home"/)
  })

  it('a page with no text at all says so, rather than pretending there is none to find', () => {
    const out = formatDOM({ ...dom, text: "" })
    assert.doesNotMatch(out, /Page text \(/)
  })

  it('the excerpt is bounded — the whole page goes into every prompt', () => {
    const out = formatDOM({ ...dom, text: "x".repeat(50_000) }, { textChars: 500 })
    assert.ok(out.length < 2_000, `excerpt not bounded: ${out.length} chars`)
    assert.match(out, /truncated/i)
  })

  it('a page with prose and nothing clickable is still readable', () => {
    const out = formatDOM({ url: "u", title: "t", elements: [], text: "The answer is 67." })
    assert.match(out, /The answer is 67/)
    assert.match(out, /no interactive elements/i)
  })
})

describe('what a step tells the model afterwards', () => {
  it('an extract puts the TEXT in the history, not just a byte count', () => {
    const e = historyEntry({ type: "extract", selector: "table" }, { ok: true, message: "Extracted 12345 chars", data: "kimi-k3 67 92 100" })
    assert.match(e, /kimi-k3 67 92 100/)
  })

  it('the extracted text is bounded too', () => {
    const e = historyEntry({ type: "extract" }, { ok: true, message: "Extracted 99999 chars", data: "y".repeat(5000) }, { dataChars: 300 })
    assert.ok(e.length < 600, `history entry not bounded: ${e.length}`)
  })

  it('other actions read as before — action, target, and what happened', () => {
    assert.equal(historyEntry({ type: "click", element: "@3" }, { ok: true, message: "Clicked @3" }), 'click @3 → Clicked @3')
    assert.equal(historyEntry({ type: "navigate", url: "https://x.test" }, { ok: true, message: "Navigated" }), 'navigate https://x.test → Navigated')
  })

  it('a failed step says so, so the model changes approach instead of repeating it', () => {
    assert.match(historyEntry({ type: "click", element: "@9" }, { ok: false, message: "Element @9 not found" }), /\[FAILED/)
  })
})
