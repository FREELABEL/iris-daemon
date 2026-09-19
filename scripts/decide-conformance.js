#!/usr/bin/env node
'use strict'

/**
 * IRIS Decide conformance — run on any machine to prove the decider works THERE (#186261).
 *   node scripts/decide-conformance.js [--runs 5] [--model qwen3:4b] [--json]
 * Exits non-zero if accuracy < 100% on the labelled set or any answer changes between runs.
 * A decider that is right once and different the next time is the bug this exists to remove (#185826).
 */

const { decide } = require('../decide')
const { create } = require('../decide/engines/ollama')

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d }
const RUNS = Number(arg('--runs', 5))
const MODEL = arg('--model', process.env.IRIS_DECIDE_MODEL || 'qwen3:4b')
const JSON_OUT = process.argv.includes('--json')

const BEAT = 'Beat: the US defense industry — procurement, contracts and military technology. Audience: defense contractors and program managers.'
const CASES = [
  ['Pentagon awards $2.1B contract for next-generation drone interceptors', true],
  ['Defense Business Brief: AI manufacturing; Skild AI raises $1.4B for robot brains', true], // the #185826 shape
  ['Army issues RFP for tactical radios with a 2027 delivery window', true],
  ['Lockheed Martin shares rise after F-35 sustainment deal', true],
  ['Navy delays frigate program over shipyard labor shortages', true],
  ['Congress passes continuing resolution freezing new defense starts', true],
  ['Taylor Swift announces new album tour dates', false],
  ['Recipe: the best sourdough starter for beginners', false],
  ['Local high school wins state basketball title', false],
  ['New iPhone case colors revealed for fall', false],
  ['City council debates downtown parking meters', false],
  ['Celebrity chef opens second restaurant in Austin', false]
]

;(async () => {
  const engine = create({ model: MODEL })
  const rows = []
  const latencies = []
  for (const [headline, expected] of CASES) {
    const values = []
    const confs = []
    for (let i = 0; i < RUNS; i++) {
      const r = await decide({ state: `${BEAT}\nHeadline: ${headline}`, questions: { on_beat: { type: 'boolean', instructions: "Would a reader in this audience need this BECAUSE of the beat? Being defense-adjacent is not enough." } } }, { engine })
      values.push(r.answers.on_beat.value)
      confs.push(r.answers.on_beat.confidence)
      latencies.push(r.meta.latency_ms)
    }
    const stable = values.every(v => v === values[0])
    rows.push({ headline, expected, got: values[0], correct: stable && values[0] === expected, stable, confidence: +confs[0].toFixed(4), confidence_drift: +(Math.max(...confs) - Math.min(...confs)).toFixed(5) })
  }
  latencies.sort((a, b) => a - b)
  const warm = latencies.slice(1)
  const report = {
    model: MODEL,
    runs_per_case: RUNS,
    cases: rows.length,
    accuracy: rows.filter(r => r.correct).length / rows.length,
    stable: rows.filter(r => r.stable).length / rows.length,
    latency_ms: { p50: warm[Math.floor(warm.length * 0.5)], p95: warm[Math.floor(warm.length * 0.95)] },
    rows
  }
  if (JSON_OUT) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`IRIS Decide conformance — ${MODEL}, ${RUNS} runs x ${rows.length} cases`)
    for (const r of rows) console.log(`  ${r.correct ? 'ok  ' : 'FAIL'} ${r.stable ? '' : '[UNSTABLE] '}${r.got === true ? 'on ' : r.got === false ? 'off' : '?  '} p=${r.confidence} drift=${r.confidence_drift}  ${r.headline}`)
    console.log(`accuracy ${(report.accuracy * 100).toFixed(0)}% · stable ${(report.stable * 100).toFixed(0)}% · latency p50 ${report.latency_ms.p50} ms, p95 ${report.latency_ms.p95} ms`)
  }
  process.exit(report.accuracy === 1 && report.stable === 1 ? 0 : 1)
})().catch(e => { console.error(`conformance could not run: ${e.message}`); process.exit(2) })
