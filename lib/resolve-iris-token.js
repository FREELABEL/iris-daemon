/**
 * resolve-iris-token.js — Single source of truth for resolving the fl-api / iris-api
 * auth token (and user id) from every place the daemon and its helper scripts know about.
 *
 * The standalone scripts (social-stats-sync, social-feed-sync, venue-enrich-outreach)
 * used to read ONLY `process.env.FL_RAICHU_API_TOKEN`. On a fresh client machine that var
 * is never set — the token lives in ~/.iris/sdk/.env (written by `iris auth login`) or
 * ~/.iris/config.json (node_api_key, written by the installer). The daemon already resolves
 * from all of these via resolveDaemonIdentity(); this module gives the scripts the same
 * resolution so they stop dying with "No API token" on the other machine (#134870/#133855).
 *
 * Zero dependencies (CommonJS) so it can be required from any script.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

/**
 * Resolve { token, userId } from, in priority order:
 *   1. explicit override (e.g. an `api_token=` CLI param)
 *   2. env vars: FL_RAICHU_API_TOKEN, FL_API_TOKEN, IRIS_API_KEY, HEYIRIS_TOKEN
 *   3. ~/.iris/sdk/.env  → FL_API_TOKEN | IRIS_API_KEY  (and IRIS_USER_ID)
 *   4. ~/.iris/config.json → node_api_key | api_key      (and user_id)
 *
 * @param {object} [opts]
 * @param {string|null} [opts.override] explicit token (wins if truthy)
 * @returns {{ token: string|null, userId: string|null, source: string }}
 */
function resolveIrisToken (opts = {}) {
  const override = opts.override || null
  if (override) return { token: override, userId: null, source: 'override' }

  let token = process.env.FL_RAICHU_API_TOKEN ||
              process.env.FL_API_TOKEN ||
              process.env.IRIS_API_KEY ||
              process.env.HEYIRIS_TOKEN ||
              null
  let userId = process.env.IRIS_USER_ID || process.env.HEYIRIS_USER_ID || null
  let source = token ? 'env' : null

  // ~/.iris/sdk/.env (written by `iris auth login`)
  if (!token || !userId) {
    try {
      const sdkEnv = path.join(os.homedir(), '.iris', 'sdk', '.env')
      if (fs.existsSync(sdkEnv)) {
        const raw = fs.readFileSync(sdkEnv, 'utf8')
        if (!token) {
          const m = raw.match(/^FL_API_TOKEN=(.+)$/m) || raw.match(/^IRIS_API_KEY=(.+)$/m)
          if (m) { token = m[1].trim(); source = 'sdk-env' }
        }
        if (!userId) {
          const mu = raw.match(/^IRIS_USER_ID=(.+)$/m)
          if (mu) userId = mu[1].trim()
        }
      }
    } catch { /* ignore */ }
  }

  // ~/.iris/config.json (written by the installer / daemon)
  if (!token || !userId) {
    try {
      const cfgFile = path.join(os.homedir(), '.iris', 'config.json')
      if (fs.existsSync(cfgFile)) {
        const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
        if (!token && (cfg.node_api_key || cfg.api_key)) {
          token = cfg.node_api_key || cfg.api_key
          source = 'config-json'
        }
        if (!userId) userId = cfg.user_id || cfg.userId || null
      }
    } catch { /* ignore */ }
  }

  return {
    token: token || null,
    userId: userId ? String(userId) : null,
    source: source || 'none',
  }
}

module.exports = { resolveIrisToken }
