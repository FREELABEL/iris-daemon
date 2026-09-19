'use strict'

/**
 * Ollama engine: read next-token probabilities at a FIXED answer position.
 *
 * Measured 2026-09-19: letting the model generate first fails — qwen3 starts reasoning ("Okay, the
 * user…") and no option letter appears in the first tokens. So the assistant turn is PREFILLED
 * (empty think block + "Answer: ") and exactly one token is read. Raw mode, so the template is ours.
 */

const TEMPLATES = {
  // ChatML with an empty think block — qwen3 family.
  qwen: (user) => `<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\nAnswer: `,
  chatml: (user) => `<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\nAnswer: `
}

function create ({ host = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434', model = process.env.IRIS_DECIDE_MODEL || 'qwen3:4b', fetchImpl = fetch } = {}) {
  const template = /qwen/i.test(model) ? TEMPLATES.qwen : TEMPLATES.chatml
  return {
    name: 'ollama',
    model,
    async complete (user) {
      const res = await fetchImpl(`${host.replace(/\/$/, '')}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: template(user), raw: true, stream: false, logprobs: true, top_logprobs: 20, options: { num_predict: 1, temperature: 0 } }),
        signal: AbortSignal.timeout(120000)
      })
      if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const r = await res.json()
      const first = (r.logprobs || [])[0]
      if (!first || !Array.isArray(first.top_logprobs)) throw new Error('ollama returned no logprobs — needs Ollama >= 0.12 with logprobs support')
      return first.top_logprobs.map(c => ({ token: c.token, prob: Math.exp(c.logprob) }))
    }
  }
}

module.exports = { create, TEMPLATES }
