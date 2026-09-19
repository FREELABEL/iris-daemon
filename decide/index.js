'use strict'

/**
 * IRIS Decide — typed decisions, never prose (#186261).
 *
 * Same composability as TypeSafe Jev / SimpleJev: send one STATE and several QUESTIONS; each
 * question is a `choice`, `score` or `boolean`; each answer is the picked value plus the probability
 * of every option and a confidence — computed from the model's next-token probabilities at a fixed
 * answer position, so the model never writes free text and cannot answer outside the options.
 *
 * Why here and not a vendor: the engine runs where the data is (a Hive node, or a service we own),
 * so PHI never leaves, and the same input returns the same answer (#185826 flipped verdicts).
 *
 *   const { decide } = require('./decide')
 *   await decide({
 *     state: 'Beat: US defense industry.\nHeadline: …',
 *     questions: {
 *       on_beat: { type: 'boolean', instructions: 'Is this headline on the beat?' },
 *       desk:    { type: 'choice', options: ['procurement', 'tech', 'policy'], allow_none: true },
 *       urgency: { type: 'score', levels: ['none', 'low', 'medium', 'high', 'breaking'] },
 *     },
 *   })
 *   // → { answers: { on_beat: { value: true, probabilities: {true: .99, false: .01}, confidence: .99 }, … },
 *   //     meta: { engine, model, latency_ms } }
 *
 * NEVER for maths, writing, or irreversible actions — code computes, LLMs create, Decide decides.
 */

const { fenceState } = require('./fence')

const MAX_OPTIONS = 26 // letters A–Z; a question with more options must be split (stated limit).
const NONE = '__none__'

/** Normalise a question to {kind, labels[], values[]} or throw a clear error. */
function normaliseQuestion (name, q) {
  if (!q || typeof q !== 'object') throw new Error(`question "${name}": must be an object`)
  const text = String(q.instructions || q.question || '').trim()
  if (q.type === 'boolean') {
    return { name, text: text || name, kind: 'boolean', labels: ['yes', 'no'], values: [true, false] }
  }
  if (q.type === 'choice') {
    const opts = Array.isArray(q.options) ? q.options.map(String) : []
    if (opts.length < 2) throw new Error(`question "${name}": choice needs at least 2 options`)
    const labels = q.allow_none ? [...opts, 'none of these'] : opts
    if (labels.length > MAX_OPTIONS) throw new Error(`question "${name}": at most ${MAX_OPTIONS} options (got ${labels.length}) — split it`)
    return { name, text: text || name, kind: 'choice', labels, values: q.allow_none ? [...opts, NONE] : opts }
  }
  if (q.type === 'score') {
    const levels = Array.isArray(q.levels) && q.levels.length ? q.levels.map(String) : ['0', '1', '2', '3', '4']
    if (levels.length < 2 || levels.length > MAX_OPTIONS) throw new Error(`question "${name}": score needs 2–${MAX_OPTIONS} levels`)
    return { name, text: text || name, kind: 'score', labels: levels, values: levels.map((_, i) => i) }
  }
  throw new Error(`question "${name}": unknown type "${q.type}" (use choice, score or boolean)`)
}

/** The exact prompt an engine completes. The answer letter must be the very next token. */
function buildPrompt (state, nq, criteria) {
  const letters = nq.labels.map((_, i) => String.fromCharCode(65 + i))
  const menu = nq.labels.map((l, i) => `${letters[i]}) ${l}`).join('\n')
  const extra = criteria ? `\nCriteria: ${criteria}` : ''
  return {
    letters,
    user: `${state}\n\nQuestion: ${nq.text}${extra}\n${menu}\nAnswer with one letter only.`
  }
}

/** Letter probabilities from an engine's top tokens → normalised over the offered letters only. */
function lettersToProbabilities (topTokens, letters) {
  const mass = Object.fromEntries(letters.map(l => [l, 0]))
  for (const { token, prob } of topTokens) {
    const t = String(token).trim().replace(/[).:]$/, '').toUpperCase()
    if (t in mass) mass[t] += prob
  }
  const total = Object.values(mass).reduce((a, b) => a + b, 0)
  if (total <= 0) return null // the model put no weight on ANY offered option — refuse, don't guess
  return Object.fromEntries(letters.map(l => [l, mass[l] / total]))
}

function shapeAnswer (nq, letterProbs) {
  const probs = {}
  nq.labels.forEach((label, i) => { probs[String(nq.values[i])] = letterProbs[String.fromCharCode(65 + i)] })
  let best = 0
  nq.values.forEach((_, i) => { if (probs[String(nq.values[i])] > probs[String(nq.values[best])]) best = i })
  const answer = { value: nq.values[best], label: nq.labels[best], probabilities: probs, confidence: probs[String(nq.values[best])] }
  if (nq.kind === 'score') {
    answer.expected = nq.values.reduce((s, v) => s + v * probs[String(v)], 0) // probability-weighted level
  }
  if (answer.value === NONE) answer.value = null
  return answer
}

/**
 * @param {{state:string, questions:Object<string,object>, untrusted?:boolean}} req
 * @param {{engine?:object}} opts  engine = { name, model, complete(userPrompt, letters) → [{token, prob}] }
 */
async function decide (req, opts = {}) {
  if (!req || typeof req.state !== 'string') throw new Error('decide: state (string) is required')
  const entries = Object.entries(req.questions || {})
  if (entries.length === 0) throw new Error('decide: at least one question is required')
  const engine = opts.engine || require('./engines/ollama').create()
  const nqs = entries.map(([name, q]) => [normaliseQuestion(name, q), q.criteria])
  // Scraped text is data, never instructions (#185962): fence it unless the caller vouches for it.
  const state = req.untrusted === false ? req.state : fenceState(req.state)

  const started = Date.now()
  const answers = {}
  // Same STATE prefix for every question, so engines that cache prompt prefixes pay for it once.
  for (const [nq, criteria] of nqs) {
    const { user, letters } = buildPrompt(state, nq, criteria)
    const top = await engine.complete(user, letters)
    const letterProbs = lettersToProbabilities(top, letters)
    if (!letterProbs) {
      answers[nq.name] = { value: null, error: 'no probability on any offered option', probabilities: {}, confidence: 0 }
      continue
    }
    answers[nq.name] = shapeAnswer(nq, letterProbs)
  }
  return { answers, meta: { engine: engine.name, model: engine.model, latency_ms: Date.now() - started } }
}

module.exports = { decide, normaliseQuestion, buildPrompt, lettersToProbabilities, shapeAnswer, MAX_OPTIONS }
