'use strict'

/**
 * Self-heal a node key the hub no longer accepts (#185896).
 *
 * A machine holds two credentials: the ACCOUNT token (~/.iris/sdk/.env, written by every sign-in —
 * Desktop, `iris auth login`, `iris-login`) and the NODE key (~/.iris/config.json, used here). They
 * fail independently. A client installed fresh, signed in, and this daemon still 401'd forever:
 * signing in never touches the node key, and nothing on the machine said which command would.
 *
 * The daemon already checks for its own updates on start; it now checks its own credential the same
 * way. On a 401 at startup — and on every retry of the auth loop in daemon.js — if the machine has a
 * signed-in account, re-register this machine with that account and carry on. So "sign in" is the
 * whole fix, whenever it happens: before the daemon starts, or while it is already retrying.
 *
 * ONLY a 401 heals. A 403 is a suspended node or a non-whitelisted IP; re-registering would mint a
 * second node for one machine and route around a decision an admin made. Network errors are left to
 * the retry loop.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')

const SDK_ENV = path.join(os.homedir(), '.iris', 'sdk', '.env')

/** Account token + user id from the file every sign-in writes. Null when not signed in. */
function readAccount (envPath = SDK_ENV) {
  let text
  try { text = fs.readFileSync(envPath, 'utf-8') } catch { return null }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
  const token = text.match(/^IRIS_API_KEY=(.+)$/m)?.[1]?.trim()
  const userId = Number(text.match(/^IRIS_USER_ID=(.+)$/m)?.[1]?.trim())
  if (!token || !Number.isInteger(userId) || userId <= 0) return null
  return { token, userId }
}

/**
 * Same derivation as the CLI's machineFingerprint() (platform-hive-connect.ts) — it MUST match, so a
 * node re-registered here reclaims the row `iris hive connect` would, instead of minting a ghost.
 */
function machineFingerprint () {
  const read = (cmd) => {
    try { return execSync(cmd, { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined } catch { return undefined }
  }
  const p = os.platform()
  let raw
  if (p === 'darwin') raw = read(`ioreg -rd1 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformUUID/{print $4}'`)
  else if (p === 'linux') raw = read('cat /etc/machine-id 2>/dev/null || cat /var/lib/dbus/machine-id 2>/dev/null')
  else if (p === 'win32') raw = read('powershell -NoProfile -Command "(Get-ItemProperty HKLM:\\SOFTWARE\\Microsoft\\Cryptography).MachineGuid"')
  if (!raw) return undefined
  return crypto.createHash('sha256').update(`iris-node:${p}:${raw}`).digest('hex')
}

// Hosts that serve the web app, not the node API — every /api/v6/node-agent route 404s on them.
// A client's api_url was hand-edited to one while chasing a 401 (#185896).
const WEB_ONLY_HOSTS = ['app.heyiris.io']
const PRODUCTION_URL = 'https://freelabel.net'

/** The node API base to actually use for a configured URL. */
function nodeApiUrl (url) {
  if (!url) return PRODUCTION_URL
  return WEB_ONLY_HOSTS.some(h => String(url).includes(h)) ? PRODUCTION_URL : url
}

function isRejectedKey (err) {
  return Number(err && err.statusCode) === 401
}

/**
 * @returns {Promise<{healed: boolean, reason: string, apiKey?: string, nodeId?: string}>}
 *   Never throws — the caller decides what an unhealed 401 means.
 */
async function healNodeKey ({
  apiUrl,
  nodeName,
  previousKey,
  configPath,
  capabilities = {},
  account = readAccount(),
  fingerprint = machineFingerprint(),
  fetchImpl = fetch,
  mergeConfig = require('../lib/config-merge').mergeConfig,
  log = console
}) {
  if (!account) {
    log.warn('[daemon] Node key rejected (401) and this machine is not signed in. Sign in (the IRIS app, or: iris auth login) — the daemon will repair itself on its next retry.')
    return { healed: false, reason: 'not-signed-in' }
  }

  let res
  try {
    res = await fetchImpl(`${String(apiUrl).replace(/\/$/, '')}/api/v6/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${account.token}` },
      body: JSON.stringify({
        user_id: account.userId,
        name: nodeName || os.hostname(),
        ...(fingerprint ? { machine_fingerprint: fingerprint } : {}),
        ...(previousKey ? { previous_node_api_key: previousKey } : {}),
        capabilities,
        max_concurrent: 2
      }),
      signal: AbortSignal.timeout(15000)
    })
  } catch (err) {
    log.warn(`[daemon] Node key rejected; re-registration could not reach the hub (${err.message}). Will retry.`)
    return { healed: false, reason: 'unreachable' }
  }

  if (!res.ok) {
    // A 401 HERE means the ACCOUNT token is dead too — only a fresh sign-in fixes that.
    log.warn(res.status === 401
      ? '[daemon] Node key rejected, and the signed-in account was rejected too. Sign in again (the IRIS app, or: iris auth login --force).'
      : `[daemon] Node key rejected; re-registration failed with HTTP ${res.status}. Will retry.`)
    return { healed: false, reason: `register-${res.status}` }
  }

  const data = await res.json().catch(() => ({}))
  const apiKey = data?.credentials?.api_key
  const nodeId = data?.node?.id
  if (!apiKey) {
    log.warn('[daemon] Re-registration returned no node key. Will retry.')
    return { healed: false, reason: 'no-key' }
  }

  // Persist BEFORE using it — the key is returned exactly once. Keep the dead one beside it so a
  // mistaken heal is reversible by hand.
  mergeConfig(configPath, {
    node_api_key: apiKey,
    user_id: account.userId,
    api_url: String(apiUrl).replace(/\/$/, ''),
    ...(nodeId ? { node_id: nodeId } : {}),
    ...(previousKey && previousKey !== apiKey ? { node_api_key_previous: previousKey } : {})
  })
  log.log(`[daemon] ${previousKey ? 'Node key was rejected — re-registered' : 'Enrolled'} this machine with the signed-in account${nodeId ? ` (node ${String(nodeId).slice(0, 8)}…)` : ''}.`)
  return { healed: true, reason: 'healed', apiKey, nodeId }
}

module.exports = { healNodeKey, readAccount, isRejectedKey, machineFingerprint, nodeApiUrl }
