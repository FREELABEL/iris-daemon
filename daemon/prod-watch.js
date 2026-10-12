'use strict'

/**
 * Production watch → a ticket when something CHANGES, never when it merely is (#189151).
 *
 * Measured 2026-10-12: heyiris.io/api/health and freelabel.net/api/health both report
 * "status": "degraded" permanently, because one provider key answers HTTP 400. A watcher that
 * alerts on "degraded" alerts every ten minutes forever, and is muted within a day — another
 * always-red check, which is the defect the whole software-factory epic (#189146) is about.
 *
 * So this alerts on transitions only, and files one ticket per incident:
 *   http        the endpoint stopped answering 200/207
 *   component   a component that WAS healthy is not (a component bad on first sight is the
 *               baseline, recorded and never alerted — the known-bad key stays quiet)
 *   latency     slower than 3× its own recent median (and > 3 s) on two runs in a row
 * An open incident is not re-filed; when it clears it is reported as recovered.
 *
 * Pure: the script does the fetching, the filing and the state file.
 */

const OK = new Set(['ok', 'healthy', 'connected', 'key_valid', 'up', 'pass', 'true'])
const KEEP = 20

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
  const s = [...xs].sort((a, b) => a - b)
  if (!s.length) return null
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * prev: { latencies:number[], components:{name:status}, open:{key:sinceIso}, slowStreak:number }
 * sample: { http:number|null, ms:number|null, body:object|null }
 * → { state, opened:[{key, detail}], closed:[key] }
 */
function evaluate (prev, sample, { now = new Date(), factor = 3, floorMs = 3000, minSamples = 5 } = {}) {
  const p = prev || {}
  const state = {
    latencies: [...(p.latencies || [])],
    components: { ...(p.components || {}) },
    open: { ...(p.open || {}) },
    slowStreak: p.slowStreak || 0,
  }
  const bad = {} // key -> detail, for everything wrong THIS run

  const up = sample.http === 200 || sample.http === 207
  if (!up) bad.http = sample.http ? `answered HTTP ${sample.http}` : 'did not answer'

  if (up) {
    const comps = componentStatuses(sample.body)
    for (const [name, status] of Object.entries(comps)) {
      const was = state.components[name]
      const okNow = OK.has(status.toLowerCase())
      // Bad on first sight is the baseline, not news. Bad after being ok is the incident.
      if (!okNow && was !== undefined && OK.has(String(was).toLowerCase())) bad[`component:${name}`] = `${name} went from ${was} to ${status}`
      // An incident that is already open stays open while the component is still bad.
      if (!okNow && state.open[`component:${name}`]) bad[`component:${name}`] = `${name} is still ${status}`
      state.components[name] = status
    }

    if (typeof sample.ms === 'number') {
      const base = median(state.latencies)
      const slow = state.latencies.length >= minSamples && sample.ms > Math.max(factor * base, floorMs)
      state.slowStreak = slow ? state.slowStreak + 1 : 0
      if (state.slowStreak >= 2 || (slow && state.open.latency)) bad.latency = `${Math.round(sample.ms)} ms against a median of ${Math.round(base)} ms`
      // A slow sample does not move the baseline it is being judged against.
      if (!slow) state.latencies = [...state.latencies, sample.ms].slice(-KEEP)
    }
  }

  const opened = []
  for (const [key, detail] of Object.entries(bad)) {
    if (!state.open[key]) { state.open[key] = now.toISOString(); opened.push({ key, detail }) }
  }
  const closed = []
  for (const key of Object.keys(state.open)) {
    // While the endpoint is down nothing else could be measured, so only http can close.
    if (!bad[key] && (up || key === 'http')) { closed.push(key); delete state.open[key] }
  }
  return { state, opened, closed }
}

module.exports = { evaluate, componentStatuses, median }
