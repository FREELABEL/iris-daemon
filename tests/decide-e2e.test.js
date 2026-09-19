'use strict'

// IRIS Decide END-TO-END against the real local model (#186261). Skips — loudly — when Ollama or the
// model is not available, so CI without a model stays green without pretending it ran.
// Proves on real inference: correct answers on labelled cases, identical answers across 5 runs,
// all three question types composed in one request, and latency.

const { test } = require('node:test')
const assert = require('node:assert')
const { decide } = require('../decide')
const { create } = require('../decide/engines/ollama')

const MODEL = process.env.IRIS_DECIDE_MODEL || 'qwen3:4b'
const BEAT = 'Beat: the US defense industry — procurement, contracts and military technology.'

async function modelAvailable () {
  try {
    const r = await fetch((process.env.OLLAMA_HOST || 'http://127.0.0.1:11434') + '/api/tags', { signal: AbortSignal.timeout(2000) })
    return (await r.json()).models.some(m => m.name === MODEL)
  } catch { return false }
}

test('e2e: labelled headlines, deterministic across 5 runs, composable in one request', async (t) => {
  if (!(await modelAvailable())) { t.skip(`Ollama with ${MODEL} not available — e2e NOT run`); return }
  const engine = create({ model: MODEL })
  const cases = [
    ['Pentagon awards $2.1B contract for next-generation drone interceptors', true],
    ['Skild AI raises $1.4B to build robot brains for defense manufacturing', true],
    ['Taylor Swift announces new album tour dates', false],
    ['Recipe: the best sourdough starter for beginners', false]
  ]
  for (const [headline, onBeat] of cases) {
    const runs = []
    for (let i = 0; i < 5; i++) {
      runs.push(await decide({ state: `${BEAT}\nHeadline: ${headline}`, questions: { on_beat: { type: 'boolean', instructions: "Is this headline on the newsroom's beat?" } } }, { engine }))
    }
    const values = runs.map(r => r.answers.on_beat.value)
    assert.deepStrictEqual(values, Array(5).fill(onBeat), `wrong or unstable on: ${headline} → ${values}`)
    const confs = runs.map(r => r.answers.on_beat.confidence)
    assert.ok(Math.max(...confs) - Math.min(...confs) < 0.01, `confidence drifted: ${confs}`)
  }

  const r = await decide({
    state: `${BEAT}\nHeadline: Pentagon awards $2.1B contract for next-generation drone interceptors`,
    questions: {
      on_beat: { type: 'boolean', instructions: "Is this headline on the newsroom's beat?" },
      desk: { type: 'choice', instructions: 'Which desk should cover it?', options: ['procurement', 'technology', 'policy', 'personnel'], allow_none: true },
      urgency: { type: 'score', instructions: 'How urgent is it for readers?', levels: ['none', 'low', 'medium', 'high', 'breaking'] }
    }
  }, { engine })
  assert.strictEqual(r.answers.on_beat.value, true)
  assert.ok(['procurement', 'technology'].includes(r.answers.desk.value), `desk: ${r.answers.desk.value}`)
  assert.ok(r.answers.urgency.expected >= 1, `urgency expected: ${r.answers.urgency.expected}`)
  t.diagnostic(`composed request: ${JSON.stringify({ desk: r.answers.desk.value, urgency: r.answers.urgency.label, expected: +r.answers.urgency.expected.toFixed(2), latency_ms: r.meta.latency_ms })}`)
})
