/**
 * Agent Loop — the core observe → think → act cycle.
 *
 * Extracts DOM state, sends it to an LLM, parses the response as an action,
 * executes via Playwright, repeats until done or max steps.
 */

const { extractDOM, formatDOM } = require('./dom-extractor')
const { executeAction } = require('./action-executor')

const DEFAULT_MAX_STEPS = 15
const DEFAULT_MODEL = 'gpt-4o-mini'

/**
 * Call the OpenAI-compatible API to decide the next action.
 */
async function decideAction(task, domText, stepHistory, step, model) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY not set')

  const systemPrompt = `You are a browser automation agent. You control a real browser to complete tasks.

RULES:
- Respond with ONLY a single JSON object — no markdown, no explanation
- Take ONE action at a time
- When the task is complete, use {"type": "done", "result": "description of what was accomplished"}
- If you're stuck or the task is impossible, use {"type": "fail", "reason": "why"}
- Be efficient — don't take unnecessary steps
- If a previous action FAILED, try a different approach (e.g. press Enter instead of clicking a button, or use navigate instead of clicking a link)
- After typing in a search box, prefer pressing Enter over clicking a search button
- Never repeat the exact same failed action more than once

AVAILABLE ACTIONS:
{"type": "click", "element": "@N"}                    — click an interactive element
{"type": "type", "element": "@N", "text": "..."}      — type text into an input
{"type": "press", "key": "Enter"}                      — press a keyboard key
{"type": "scroll", "direction": "down"}                — scroll the page (down/up)
{"type": "navigate", "url": "https://..."}             — go to a URL
{"type": "extract", "selector": "css-selector", "save_as": "file.txt"} — extract text and save
{"type": "screenshot", "save_as": "result.png"}        — take a screenshot
{"type": "wait", "seconds": 2}                         — wait for page to load
{"type": "done", "result": "..."}                      — task completed
{"type": "fail", "reason": "..."}                      — task cannot be completed`

  const userMessage = `TASK: ${task.prompt || task.title || 'Complete the browser task'}

CURRENT PAGE STATE (step ${step + 1}):
${domText}

${stepHistory.length > 0 ? `PREVIOUS ACTIONS:\n${stepHistory.map((h, i) => `  ${i + 1}. ${h}`).join('\n')}\n` : ''}
What is the next action? Respond with ONE JSON object only.`

  const baseUrl = process.env.OPENAI_API_BASE || 'https://api.openai.com/v1'
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.1,
      max_tokens: 200,
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`LLM API error ${response.status}: ${err}`)
  }

  const data = await response.json()
  const content = data.choices?.[0]?.message?.content?.trim()
  if (!content) throw new Error('Empty LLM response')

  // Parse JSON from response (strip markdown fences if present)
  let cleaned = content
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  }

  try {
    return JSON.parse(cleaned)
  } catch (e) {
    console.error(`[agent] Failed to parse LLM response: ${content}`)
    return { type: 'fail', reason: `Could not parse LLM response: ${content.slice(0, 100)}` }
  }
}

/**
 * Run the agent loop.
 * @param {import('playwright').Page} page
 * @param {object} task - { prompt, title, config }
 * @param {object} options - { maxSteps, model, outputDir }
 * @returns {{ success: boolean, result?: string, error?: string, steps: number, history: string[] }}
 */
async function agentLoop(page, task, options = {}) {
  const maxSteps = options.maxSteps || task.config?.max_steps || DEFAULT_MAX_STEPS
  const model = options.model || task.config?.model || process.env.BROWSER_AGENT_MODEL || DEFAULT_MODEL
  const outputDir = options.outputDir || process.env.OUTPUT_DIR

  const history = []
  console.log(`[agent] Starting loop — max ${maxSteps} steps, model: ${model}`)
  console.log(`[agent] Task: ${task.prompt || task.title}`)

  for (let step = 0; step < maxSteps; step++) {
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: true })
    console.log(`\n[agent] [${timestamp}] Step ${step + 1}/${maxSteps}`)

    // OBSERVE
    let dom
    try {
      // Wait briefly for any pending navigation/renders
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
      dom = await extractDOM(page)
      console.log(`[agent] Page: ${dom.url} — ${dom.elements.length} elements`)
    } catch (e) {
      console.error(`[agent] DOM extraction failed: ${e.message}`)
      history.push(`Step ${step + 1}: DOM extraction failed — ${e.message}`)
      continue
    }

    const domText = formatDOM(dom)

    // THINK
    let action
    try {
      action = await decideAction(task, domText, history, step, model)
      console.log(`[agent] Action: ${JSON.stringify(action)}`)
    } catch (e) {
      console.error(`[agent] LLM decision failed: ${e.message}`)
      history.push(`Step ${step + 1}: LLM error — ${e.message}`)
      // Retry on next step
      continue
    }

    // ACT
    try {
      const result = await executeAction(page, action, dom, outputDir)
      const entry = `${action.type}${action.element ? ' ' + action.element : ''}${action.text ? ' "' + action.text.slice(0, 30) + '"' : ''}${action.url ? ' ' + action.url : ''} → ${result.message}`
      history.push(entry)
      console.log(`[agent] Result: ${result.message}`)

      if (result.done) {
        if (result.result) {
          return { success: true, result: result.result, steps: step + 1, history }
        }
        if (result.error) {
          return { success: false, error: result.error, steps: step + 1, history }
        }
      }

      if (!result.ok) {
        console.warn(`[agent] Action failed: ${result.message}`)
        // Append failure context so LLM can adapt on next step
        history[history.length - 1] += ' [FAILED - try a different approach]'
      }

      // Brief pause between actions
      await page.waitForTimeout(500)

    } catch (e) {
      console.error(`[agent] Action execution error: ${e.message}`)
      history.push(`Step ${step + 1}: ${action.type} failed — ${e.message}`)
    }
  }

  return { success: false, error: `Max steps (${maxSteps}) reached`, steps: maxSteps, history }
}

module.exports = { agentLoop }
