/**
 * The parts of the prompt that tell the agent what it can do, and what to do next.
 *
 * Measured 2026-09-20: asked for a number at char 5,758 of a page it had been shown the first
 * 3,000 characters of, qwen3:4b answered "not found in the results table" three times out of
 * three, in two steps, and never tried `extract`. The action list described extract as
 *
 *     {"type":"extract","selector":"css-selector","save_as":"file.txt"} — extract text and save
 *
 * which reads as "write a file", while the system prompt also says "be efficient, don't take
 * unnecessary steps". Under that description giving up IS the efficient move. The excerpt said
 * "truncated" and left the model to work out the rest.
 */

/** The action list. `extract` now says where the text goes: back to the model. */
const ACTION_HELP = `{"type": "click", "element": "@N"}                    — click an interactive element
{"type": "type", "element": "@N", "text": "..."}      — type text into an input
{"type": "press", "key": "Enter"}                      — press a keyboard key
{"type": "scroll", "direction": "down"}                — scroll the page (down/up)
{"type": "navigate", "url": "https://..."}             — go to a URL
{"type": "find", "text": "kimi-k3"}                    — SEARCH the page for a word or number; the matching lines and their line numbers come back to you. Use this FIRST on a long page instead of reading it from the top.
{"type": "extract", "selector": "css-selector"}        — READ text from the page; it is returned to you on the next step. Omit the selector for the whole page, or target one part ("table", "main"). Add "save_as": "file.txt" to also write a file.
{"type": "screenshot", "save_as": "result.png"}        — take a screenshot
{"type": "wait", "seconds": 2}                         — wait for page to load
{"type": "done", "result": "..."}                      — task completed
{"type": "fail", "reason": "..."}                      — task cannot be completed`

/**
 * One line, only when the page state was cut short: what the agent is looking at is not all there
 * is, and the action that fetches the rest. Added to every truncated step, so it stays one line.
 */
function truncationHint(domText) {
  return /truncated/i.test(String(domText ?? ""))
    ? 'NOTE: the page text above is TRUNCATED. If your answer is not in it, use {"type":"find","text":"..."} to search the whole page for what you need before answering.'
    : ""
}

module.exports = { ACTION_HELP, truncationHint }
