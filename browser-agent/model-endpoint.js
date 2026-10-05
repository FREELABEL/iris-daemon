'use strict'

/**
 * Where the browser agent's model calls go, and with whose credential. (#187917)
 *
 * WHAT THIS REPLACED. decideAction() used to POST the whole page — fenced, but verbatim — to
 * `OPENAI_API_BASE || https://api.openai.com/v1` with the node's own OPENAI_API_KEY. That path
 * never touches fl-iris-api, so the PHI egress guard (ModelProxyController: PHI-safe rerouting,
 * report/enforce per provider) could not see a portal robot sending a patient chart to OpenAI.
 * `iris ocr` had already been moved behind the proxy; this was the remaining hole.
 *
 * THE RULE NOW:
 *   - DEFAULT is the IRIS model proxy (POST {proxy}/chat/completions) with the node's IRIS
 *     credential. The proxy resolves the node key to its owner, applies billing and the PHI
 *     guard. A PHI task also says so (`X-Iris-Phi: 1`) so the guard applies even when the user
 *     has no "recent PHI read" on record — the robot's read happened on the node, not in the API.
 *   - DIRECT provider mode exists only when the operator explicitly asks for it
 *     (BROWSER_AGENT_PROVIDER=direct), and is REFUSED for a PHI task — unless the base URL is
 *     loopback (a local model on this machine), because then nothing leaves the node at all,
 *     which is strictly better than the proxy.
 *   - No way to tell? Proxy. Not knowing whether a task is PHI must never be the reason it
 *     skipped the guard.
 */

const { isPhiTask } = require('../lib/phi-task')

const DEFAULT_IRIS_API = 'https://freelabel.net'

function isLoopback (url) {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '')
    return h === 'localhost' || h === '::1' || /^127\./.test(h)
  } catch {
    return false
  }
}

function defaultTokenResolver () {
  try {
    return require('../lib/resolve-iris-token').resolveIrisToken().token
  } catch {
    return null
  }
}

/**
 * @param {object} [opts]
 * @param {object} [opts.env]   process.env by default
 * @param {object} [opts.task]  the task (its config may carry the PHI flag)
 * @param {() => string|null} [opts.resolveToken]  fallback IRIS credential (user's SDK token)
 * @returns {{ mode: 'proxy'|'direct', url: string, headers: object, phi: boolean }}
 */
function resolveModelEndpoint ({ env = process.env, task = {}, resolveToken = defaultTokenResolver } = {}) {
  const phi = env.IRIS_TASK_PHI === '1' || isPhiTask(task)
  const wantsDirect = String(env.BROWSER_AGENT_PROVIDER || '').toLowerCase() === 'direct'

  if (wantsDirect) {
    const base = (env.OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '')
    if (phi && !isLoopback(base)) {
      throw new Error(
        `Refused: BROWSER_AGENT_PROVIDER=direct would send a PHI task's page content to ${base} ` +
        'without the IRIS PHI egress guard (#187917). Unset it to use the IRIS model proxy, ' +
        'or point OPENAI_API_BASE at a model running on this machine.'
      )
    }
    const apiKey = env.OPENAI_API_KEY
    if (!apiKey && !isLoopback(base)) throw new Error('OPENAI_API_KEY not set (BROWSER_AGENT_PROVIDER=direct)')
    return {
      mode: 'direct',
      phi,
      url: `${base}/chat/completions`,
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    }
  }

  const proxyBase = (env.IRIS_MODEL_PROXY_URL ||
    `${(env.IRIS_API_URL || DEFAULT_IRIS_API).replace(/\/$/, '')}/api/v6/openai`).replace(/\/$/, '')
  const token = env.IRIS_MODEL_PROXY_TOKEN || resolveToken()
  if (!token) {
    throw new Error(
      'No IRIS credential for the model proxy: run `iris auth login` or start the task from the ' +
      'daemon (it passes the node key). Direct provider calls are opt-in — BROWSER_AGENT_PROVIDER=direct.'
    )
  }
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'iris-daemon-browser-agent',
  }
  if (phi) headers['X-Iris-Phi'] = '1'
  if (env.TASK_ID) headers['X-Iris-Task-Id'] = String(env.TASK_ID).slice(0, 64)
  return { mode: 'proxy', phi, url: `${proxyBase}/chat/completions`, headers }
}

module.exports = { resolveModelEndpoint, isLoopback }
