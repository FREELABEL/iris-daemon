/**
 * BridgeRegistry — the declarative capability table for `bridge_call` tasks.
 *
 * WHY THIS EXISTS
 * ---------------
 * There used to be two ways for the cloud to reach a user's Mac:
 *
 *   Rail A  fl-api BridgeService  ──HTTP──►  the laptop directly
 *   Rail B  NodeTaskDispatcher ──Pusher──►  the daemon
 *
 * Rail A was dead on arrival in production — it called an iris-api route that has
 * never existed (`/api/v1/compute-nodes`, 404) and required a `metadata.endpoint_url`
 * that nothing has ever written. It also assumed the laptop was publicly reachable,
 * which NAT forbids. It only ever worked in local Docker, where its fallback
 * (`host.docker.internal:3200`) happens to be the host. See bug #178670.
 *
 * Rail B is NAT-safe because the node dials OUT. But its contract was a *prompt*
 * string and its extension point was another `case` in a 4,370-line switch.
 *
 * So we keep Rail B's transport and steal Rail A's one genuinely good idea: a
 * declarative provider → function → route table. A new local data source becomes a
 * block in this file plus a route on the bridge — no switch surgery.
 *
 * HOW IT WORKS
 * ------------
 * The daemon and the bridge's HTTP server run on the same machine (same process in
 * embedded mode). So `bridge_call` does not reimplement drivers: it calls the
 * bridge's OWN localhost routes, which are already written, already tested, and
 * already what Rail A was calling. Only the transport changed.
 *
 *   cloud ──Pusher──► daemon ──127.0.0.1──► bridge route ──► driver ──► disk
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const BRIDGE_TOKEN_PATH = path.join(os.homedir(), '.iris', 'bridge-token')

function bridgePort () {
  return parseInt(process.env.A2A_PORT || process.env.BRIDGE_PORT || process.env.PORT || '3200', 10)
}

/**
 * Read the bridge token with the STATIC fs import.
 *
 * A helper elsewhere in the CLI does `require('fs')` inside a try/catch and returns
 * null the moment `require` is unavailable in that module context — silently, so the
 * caller sees an unexplained 401 instead of "not authorised". Don't repeat it.
 */
function bridgeToken () {
  try {
    if (fs.existsSync(BRIDGE_TOKEN_PATH)) {
      return fs.readFileSync(BRIDGE_TOKEN_PATH, 'utf-8').trim() || null
    }
  } catch { /* unreadable — fall through to null */ }
  return null
}

/** A file/dir probe that never throws. */
const exists = (p) => {
  try { return fs.existsSync(p) } catch { return false }
}

/** macOS 10.15+ moved bundled apps to the read-only system volume. Check both. */
const appExists = (name) =>
  exists(`/System/Applications/${name}`) || exists(`/Applications/${name}`)

/**
 * The capability table.
 *
 * `available()` must answer "can this machine actually serve this provider RIGHT NOW",
 * and must return a REASON when it cannot. A bare false is what produced months of
 * "bridge is offline" for a bridge that was running fine — the health answer has to
 * carry why, or the UI invents one.
 */
const PROVIDERS = {
  obsidian: {
    name: 'Obsidian',
    description: 'Local Obsidian vaults — markdown read straight off disk',
    available () {
      if (process.platform === 'win32') return { ok: false, reason: 'Windows is not supported yet' }
      // A vault is the resource; without one the provider is present but useless.
      try {
        const { discoverVaults } = require('../drivers/obsidian')
        const vaults = discoverVaults()
        if (!vaults.length) {
          return { ok: false, reason: 'No Obsidian vault found on this machine' }
        }
        return { ok: true, detail: `${vaults.length} vault(s)` }
      } catch (e) {
        return { ok: false, reason: `Obsidian driver unavailable: ${e.message}` }
      }
    },
    functions: {
      list_vaults: { method: 'GET', path: '/api/obsidian/vaults' },
      list_files: { method: 'GET', path: '/api/obsidian/notes' },
      read_note: { method: 'GET', path: '/api/obsidian/note' },
      search_notes: { method: 'GET', path: '/api/obsidian/search' },
    },
  },

  imessage: {
    name: 'iMessage',
    description: 'Local iMessage history via the Messages chat.db',
    available () {
      if (process.platform !== 'darwin') return { ok: false, reason: 'iMessage requires macOS' }
      const db = path.join(os.homedir(), 'Library', 'Messages', 'chat.db')
      if (!exists(db)) return { ok: false, reason: 'Messages chat.db not found' }
      // Presence of the file is NOT permission to read it — Full Disk Access is a
      // separate grant, and without it every query fails with EPERM. Probe for real.
      try {
        fs.accessSync(db, fs.constants.R_OK)
      } catch {
        return { ok: false, reason: 'No Full Disk Access for Messages — grant it in System Settings › Privacy' }
      }
      return { ok: true }
    },
    // Function names MATCH fl-api's IntegrationRegistry, which is what the UI, the CLI and
    // every agent prompt already advertise. They previously disagreed three ways — the UI
    // offered search_messages/get_messages/send_message while the rail had only
    // list_conversations/resolve_handle — so five advertised functions were uncallable
    // (#178748). The published names win; the rail conforms.
    functions: {
      list_conversations: { method: 'GET', path: '/api/imessage/conversations' },
      search_messages: { method: 'GET', path: '/api/imessage/search' },
      resolve_handle: { method: 'GET', path: '/api/imessage/resolve' },
      // WRITE. Reaches a real person's phone, so it exists only on an explicit call —
      // never on a schedule, and never from the always-on reply channel (#137256).
      send_message: { method: 'POST', path: '/api/imessage/direct-send' },
      // NB: fl-api also advertised `get_messages` -> /api/imessage/messages. That route
      // does not exist on the bridge and never has, so it is deliberately NOT declared
      // here — an honestly-absent function beats one that 404s. Drop it from fl-api too.
    },
  },

  apple_mail: {
    name: 'Apple Mail',
    description: 'Local Apple Mail.app mailboxes via AppleScript',
    available () {
      if (process.platform !== 'darwin') return { ok: false, reason: 'Apple Mail requires macOS' }
      if (!appExists('Mail.app')) return { ok: false, reason: 'Mail.app is not installed' }
      return { ok: true }
    },
    functions: {
      // `search_emails`, not `search` — matches fl-api's published name (#178748).
      search_emails: { method: 'GET', path: '/api/mail/search' },
      // WRITE — sends real mail from the user's account. Explicit calls only.
      send_email: { method: 'POST', path: '/api/mail/send' },
    },
  },

  apple_calendar: {
    name: 'Apple Calendar',
    description: 'Local macOS Calendar.app events via AppleScript',
    available () {
      if (process.platform !== 'darwin') return { ok: false, reason: 'Apple Calendar requires macOS' }
      if (!appExists('Calendar.app')) return { ok: false, reason: 'Calendar.app is not installed' }
      return { ok: true }
    },
    functions: {
      // `get_events`, not `list_events` — matches fl-api's published name (#178748).
      //
      // WARNING: this currently CANNOT succeed. The AppleScript behind it iterates every
      // calendar with a `whose` clause and takes 4m37s on a 28-calendar machine, against a
      // 30s execFile timeout (#178745). Declared because the UI already advertises it and
      // an honest named failure beats a phantom function — but it will time out until the
      // script is rewritten.
      get_events: { method: 'GET', path: '/api/calendar/events' },
      // WRITE — creates a real calendar event. Explicit calls only.
      create_event: { method: 'POST', path: '/api/calendar/create' },
    },
  },
}

/**
 * What this machine can serve, for the heartbeat.
 *
 * Reported for EVERY provider, including unavailable ones with their reason, so the
 * cloud can tell "this Mac has no vault" apart from "this Mac never reported".
 * Those are different answers and the UI must not merge them.
 */
function capabilities () {
  const out = {}
  for (const [key, provider] of Object.entries(PROVIDERS)) {
    let probe
    try {
      probe = provider.available()
    } catch (e) {
      probe = { ok: false, reason: `probe failed: ${e.message}` }
    }
    out[key] = {
      available: !!probe.ok,
      reason: probe.ok ? null : (probe.reason || 'unavailable'),
      detail: probe.detail || null,
      functions: Object.keys(provider.functions),
    }
  }
  return out
}

function listProviders () {
  return Object.keys(PROVIDERS)
}

/**
 * Execute one provider function by calling the bridge's own localhost route.
 *
 * Returns structured data. Throws with a NAMED reason on every failure path —
 * unknown provider, unavailable provider, unknown function, bridge not listening,
 * and the route's own error are five different problems and must not collapse into
 * one "bridge is offline".
 */
async function call (providerKey, functionName, args = {}) {
  const provider = PROVIDERS[providerKey]
  if (!provider) {
    throw new Error(`Unknown bridge provider "${providerKey}". Known: ${listProviders().join(', ')}`)
  }

  const probe = provider.available()
  if (!probe.ok) {
    throw new Error(`${provider.name} is not available on this machine: ${probe.reason}`)
  }

  const route = provider.functions[functionName]
  if (!route) {
    throw new Error(
      `Unknown function "${functionName}" for ${providerKey}. Available: ${Object.keys(provider.functions).join(', ')}`,
    )
  }

  const base = `http://127.0.0.1:${bridgePort()}`
  const headers = { Accept: 'application/json' }
  const token = bridgeToken()
  if (token) headers['x-bridge-key'] = token

  let url = `${base}${route.path}`
  const init = { method: route.method, headers, signal: AbortSignal.timeout(60000) }

  if (route.method === 'GET') {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(args)) {
      if (v === undefined || v === null) continue
      qs.set(k, Array.isArray(v) ? v.join(',') : String(v))
    }
    const q = qs.toString()
    if (q) url += `?${q}`
  } else {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(args)
  }

  let res
  try {
    res = await fetch(url, init)
  } catch (e) {
    // The bridge HTTP server not listening is a DIFFERENT failure from the route
    // erroring, and the caller can act on it (restart the bridge) only if we say so.
    throw new Error(`Bridge HTTP server is not listening on ${base} (${e.message})`)
  }

  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const detail = (body && (body.error || body.message)) || `HTTP ${res.status}`
    throw new Error(`${providerKey}.${functionName} failed: ${detail}`)
  }

  return body
}

module.exports = { PROVIDERS, capabilities, listProviders, call, bridgePort }
