'use strict'

/**
 * Deploy soak: did the deploy that just went live make production worse? Decided in code (#189152, G6).
 *
 * The ticket asked for a staging environment, a soak, a promote button and a rollback. A second
 * Railway environment costs money every month and doubles every env var to keep in sync, and
 * the question it answers — "is this commit worse than the one before it?" — can be asked of
 * production directly in the ten minutes after a deploy, against what production looked like
 * just before it. Wait for CI (now on for fl-api) is the promote gate; this is the soak and the
 * rollback.
 *
 * The baseline is production itself, measured on every run while nothing new is deploying. So a
 * component that is ALWAYS degraded (one provider key answers 400 — measured 2026-10-12) is part
 * of the baseline and never fails a soak; one that was fine before the deploy and is not after
 * it does.
 *
 * Verdicts:
 *   FAIL  the endpoint stopped answering on 3 probes in a row
 *         a component healthy in the baseline is unhealthy on the last probe AND most probes
 *         median latency over 3× the baseline median (and over 3 s)
 *   PASS  none of those across the soak
 *
 * Pure. scripts/deploy-soak.js reads deploy status from GitHub, probes, keeps state and acts.
 */

const OK = new Set(['ok', 'healthy', 'connected', 'key_valid', 'up', 'pass', 'true'])
const isOk = (s) => OK.has(String(s).toLowerCase())

function componentStatuses (body) {
  const out = {}
  if (!body || typeof body !== 'object') return out
  for (const [k, v] of Object.entries(body)) {
    if (k === 'status' || k === 'timestamp') continue
    const s = typeof v === 'object' && v !== null ? v.status : v
    if (s === undefined || s === null || typeof s === 'object') continue
    out[k] = String(s)
  }
  return out
}

function median (xs) {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b)
  if (!s.length) return null
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const up = (p) => p && (p.http === 200 || p.http === 207)

/** Fold a probe taken while nothing is deploying into the baseline. */
function updateBaseline (baseline, probe, keep = 20) {
  const b = { components: { ...((baseline && baseline.components) || {}) }, latencies: [...((baseline && baseline.latencies) || [])] }
  if (!up(probe)) return b
  Object.assign(b.components, componentStatuses(probe.body))
  if (typeof probe.ms === 'number') b.latencies = [...b.latencies, probe.ms].slice(-keep)
  return b
}

/**
 * baseline: { components:{name:status}, latencies:number[] }
 * probes:   [{ http, ms, body }] taken across the soak, in order
 * → { verdict: 'PASS'|'FAIL', reasons: string[] }
 */
function soakVerdict (baseline, probes, { downStreak = 3, factor = 3, floorMs = 3000 } = {}) {
  const reasons = []
  const ps = probes || []
  if (!ps.length) return { verdict: 'FAIL', reasons: ['no probes were taken — the soak measured nothing'] }

  let streak = 0
  let worst = 0
  for (const p of ps) { streak = up(p) ? 0 : streak + 1; worst = Math.max(worst, streak) }
  if (worst >= downStreak) reasons.push(`the endpoint did not answer 200 on ${worst} probes in a row`)

  const answered = ps.filter(up)
  const last = ps[ps.length - 1]
  if (answered.length && up(last)) {
    const lastComps = componentStatuses(last.body)
    for (const [name, was] of Object.entries((baseline && baseline.components) || {})) {
      if (!isOk(was)) continue // bad before the deploy: not this deploy's doing
      const now = lastComps[name]
      if (now === undefined || isOk(now)) continue
      const badCount = answered.filter((p) => { const s = componentStatuses(p.body)[name]; return s !== undefined && !isOk(s) }).length
      if (badCount * 2 > answered.length) reasons.push(`${name} was ${was} before the deploy and is ${now} after it (${badCount} of ${answered.length} probes)`)
    }
    const base = median((baseline && baseline.latencies) || [])
    const med = median(answered.map((p) => p.ms))
    if (base && med && med > Math.max(factor * base, floorMs)) reasons.push(`median latency ${Math.round(med)} ms against ${Math.round(base)} ms before the deploy`)
  }
  return { verdict: reasons.length ? 'FAIL' : 'PASS', reasons }
}

/**
 * What the deploy branch is doing, from GitHub commit statuses Railway posts per service.
 * statuses: [{context, state}] for the tip; context like "freelabel-eco - fl-api".
 * → 'success' | 'pending' | 'failure' | 'unknown'
 */
function deployState (statuses, context) {
  const s = (statuses || []).find((x) => x.context === context)
  if (!s) return 'unknown'
  if (s.state === 'success') return 'success'
  if (s.state === 'pending') return 'pending'
  return 'failure'
}

/**
 * The run's next step for one service.
 * prev: { sha, soaked: {sha: verdict} }   tip: { sha, state }
 * → 'baseline' (nothing new: measure) | 'soak' (new SHA is live) | 'wait' (still deploying) | 'done'
 */
function nextStep (prev, tip) {
  const soaked = (prev && prev.soaked) || {}
  if (!tip || !tip.sha) return 'wait'
  if (soaked[tip.sha]) return 'baseline'
  if (!prev || !prev.sha) return 'baseline' // first sight: this IS the baseline, not a deploy
  if (tip.sha === prev.sha) return 'baseline'
  if (tip.state === 'success') return 'soak'
  return 'wait'
}

module.exports = { soakVerdict, updateBaseline, deployState, nextStep, componentStatuses, median }
