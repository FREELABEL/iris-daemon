'use strict'
/**
 * Which host a production node falls back to when its API host stops answering (#189649).
 *
 * freelabel.net and heyiris.io serve the same node API (identical 401 body from
 * /api/v6/node-agent/tasks/pending, checked 2026-11-20) through DIFFERENT routes: freelabel.net
 * resolves straight to the origin, heyiris.io goes through Cloudflare. So one can answer while the
 * other does not — which is what happened on 2026-10-14/15, when freelabel.net timed out, heyiris.io
 * answered, and every node with no fallback (all of production) failed cloud auth every 5 minutes.
 *
 * CloudClient already fails over after 3 connection errors and switches back when the primary
 * recovers; it was simply never given a fallback outside local mode. This supplies one.
 *
 * Returns null when there is no sensible pair (a custom or local host): a wrong fallback is worse
 * than none, because it would send a client's node key to a host they never configured.
 */
const PAIRS = {
  'freelabel.net': 'https://heyiris.io',
  'www.freelabel.net': 'https://heyiris.io',
  'heyiris.io': 'https://freelabel.net',
  'www.heyiris.io': 'https://freelabel.net'
}

function defaultFallback (apiUrl) {
  let host
  try { host = new URL(String(apiUrl)).hostname.toLowerCase() } catch { return null }
  return PAIRS[host] || null
}

/**
 * The fallback to use: an explicit one (flag, env, config) always wins; otherwise local mode
 * falls back to production (unchanged behaviour), and production gets the paired host.
 */
function resolveFallback ({ explicit, mode, apiUrl, productionUrl }) {
  if (explicit) return explicit
  if (mode === 'local') return productionUrl
  return defaultFallback(apiUrl)
}

module.exports = { defaultFallback, resolveFallback }
