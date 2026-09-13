/**
 * Bridge auth policy — the ONE list of routes that skip X-Bridge-Key.
 *
 * This file exists because the list used to be written twice: once in index.js
 * and once inline in tests/bridge-security.test.js. Two copies of a security
 * predicate is not a test, it is a coincidence — the suite could pass green
 * while the running daemon exempted a route the test had never heard of. Both
 * now import this, so "what the test asserts" and "what the daemon opens" are
 * the same object and cannot drift.
 *
 * Adding a route here makes it reachable by ANYTHING that can open the port,
 * including a non-browser caller over the tailnet once `iris hive vpn serve`
 * publishes it. CORS does not constrain those. Add only routes that are safe
 * to hand to a stranger.
 */

// Exact paths. No request body, no identity, no data belonging to the operator.
const OPEN_PATHS = new Set([
  '/health',
  '/.well-known/security.txt',
  '/api/config',
  '/api/environment',
  '/api/discover',
  '/api/ollama/models',
  '/daemon/health',
  '/daemon/capacity',
  '/daemon/profile'
])

// Prefixes. Each needs its OWN authentication — "open" here means "the bridge
// key is not the thing checking it", never "nothing checks it".
const OPEN_PREFIXES = [
  '/daemon/mesh/' // mesh routes authenticate with X-Mesh-Key
]

module.exports = { OPEN_PATHS, OPEN_PREFIXES }
