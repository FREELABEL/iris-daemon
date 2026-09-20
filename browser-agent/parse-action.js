/**
 * Read the model's chosen action out of whatever it replied.
 *
 * `JSON.parse(content)` with fences stripped works for a model that answers with an object and
 * nothing else. It fails for every reasoning model: measured 2026-09-20, a local qwen3:4b through
 * Ollama spent its whole reply inside a <think> block and the loop recorded six steps of
 * "Empty LLM response" — an agent that cannot use a local model is an agent that needs a cloud
 * bill to move a mouse.
 *
 * So: drop the thinking, drop any fences, and take the first balanced JSON OBJECT in what is left.
 * When there is none, return null — the caller turns that into a `fail` action rather than a guess.
 */

/** The first balanced {...} in the text, respecting strings and escapes. */
function firstObject(text) {
  const start = text.indexOf("{")
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function parseAction(content) {
  if (typeof content !== "string") return null
  let text = content.trim()
  if (!text) return null
  // Reasoning traces. An UNCLOSED <think> means the reply never got past thinking: there is no
  // action in it, and cutting at the tag would leave prose that parses to nothing anyway.
  if (text.includes("<think>")) {
    const end = text.lastIndexOf("</think>")
    text = end >= 0 ? text.slice(end + "</think>".length).trim() : ""
  }
  if (!text) return null
  if (text.startsWith("```")) text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()
  // A LIST of actions is not an action. Taking its first element would run one step of several
  // the model intended, silently — the loop asks for one action at a time.
  if (text.startsWith("[")) return null
  const obj = firstObject(text)
  if (!obj) return null
  try {
    const parsed = JSON.parse(obj)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

module.exports = { parseAction }
