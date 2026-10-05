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
const { requestJson } = require('./http-json')
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
/**
 * Vault discovery is expensive (a filesystem walk) and its answer is nearly static, so the
 * heartbeat probe caches it. 5 minutes: long enough that the 30s heartbeat stops paying for
 * it, short enough that creating a vault shows up without a restart.
 */
let vaultProbeCache = null
const VAULT_PROBE_TTL_MS = 5 * 60 * 1000

/**
 * Whether this node's local model server answers. probeLocalLlm is async (an HTTP GET) and
 * available() must be sync, so the answer is cached and refreshed in the background — at most
 * once a minute, never on the request path. Before the first probe returns, the answer is
 * "unknown", which is not "unavailable": the call is allowed, and chat() names the reason if
 * the server is not there.
 */
let llmProbe = { at: 0, result: null, inflight: null }
const LLM_PROBE_TTL_MS = 60 * 1000

function localLlmAvailable () {
  const now = Date.now()
  if (!llmProbe.inflight && now - llmProbe.at > LLM_PROBE_TTL_MS) {
    llmProbe.inflight = require('./local-llm').probeLocalLlm()
      .then((p) => {
        llmProbe.result = p.available
          ? { ok: true, detail: `${p.server}: ${p.model_count} model(s)` }
          : { ok: false, reason: `No local model server answering at ${p.base_url}` }
        llmProbe.at = Date.now()
      })
      .catch(() => {})
      .finally(() => { llmProbe.inflight = null })
  }
  return llmProbe.result || { ok: true, detail: 'not probed yet' }
}

const PROVIDERS = {
  // An agent turn against this node's own model server (Ollama by default). The cloud sends the
  // conversation and the tools; the node calls 127.0.0.1 and returns the assistant message. Lets a
  // platform agent run on a model that never leaves the building — PATTY on iris-hive-001
  // (EPIC #187884). timeoutMs: a 14B model on CPU took 40–75s per answer on 2026-10-03, past the
  // 60s every other route gets.
  local_llm: {
    name: 'Local models',
    description: "This node's OpenAI-compatible model server — Ollama by default",
    available: localLlmAvailable,
    functions: {
      chat: { method: 'POST', path: '/api/local-llm/chat', timeoutMs: 10 * 60 * 1000 },
    },
  },
  obsidian: {
    name: 'Obsidian',
    description: 'Local Obsidian vaults — markdown read straight off disk',
    available () {
      if (process.platform === 'win32') return { ok: false, reason: 'Windows is not supported yet' }
      // A vault is the resource; without one the provider is present but useless.
      //
      // MEMOISED: this runs on EVERY heartbeat — every 30s, permanently, on every node —
      // and discoverVaults() walks 7 candidate roots to depth 3. Measured at 130-306ms a
      // call, so ~0.5s of filesystem walking per minute per machine forever, to answer a
      // question whose answer changes about twice a year. It also made GET /api/obsidian/
      // vaults slower for real callers, since they queue behind it (#178757).
      try {
        const now = Date.now()
        if (vaultProbeCache && now - vaultProbeCache.at < VAULT_PROBE_TTL_MS) {
          return vaultProbeCache.result
        }
        const { discoverVaults } = require('../drivers/obsidian')
        const vaults = discoverVaults()
        const result = vaults.length
          ? { ok: true, detail: `${vaults.length} vault(s)` }
          : { ok: false, reason: 'No Obsidian vault found on this machine' }
        vaultProbeCache = { at: now, result }
        return result
      } catch (e) {
        // Never cache a failure: a transient permission blip would otherwise pin the
        // provider "unavailable" for the whole TTL, which is the silent-wrong-answer
        // shape this whole effort exists to avoid.
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

  sessions: {
    name: 'AI sessions',
    description: 'Claude Code and opencode sessions on this machine — list and transcript, read-only',
    available () {
      // Either provider's storage is enough; a machine with neither has nothing to read.
      const claude = path.join(os.homedir(), '.claude', 'projects')
      const opencode = path.join(os.homedir(), '.local', 'share', 'opencode', 'storage', 'session')
      if (exists(claude) || exists(opencode)) return { ok: true, detail: exists(claude) ? 'Claude Code' : 'opencode' }
      return { ok: false, reason: 'No Claude Code or opencode session storage on this machine' }
    },
    functions: {
      // Read-only by construction: these routes only read transcripts off disk. Sending a message
      // into a live session is deliberately NOT here — see the epic's step 6.
      list: { method: 'GET', path: '/api/sessions/claude-code' },
      history: { method: 'GET', path: '/api/sessions/history' },
    },
  },

  imessage: {
    name: 'iMessage',
    description: 'Local iMessage history via the Messages chat.db',
    available () {
      if (process.platform !== 'darwin') return { ok: false, reason: 'iMessage requires macOS' }
      const db = path.join(os.homedir(), 'Library', 'Messages', 'chat.db')
      if (!exists(db)) return { ok: false, reason: 'Messages chat.db not found' }
      // Presence of the file is NOT permission to read it — Full Disk Access is a separate
      // grant. This probe used to be `fs.accessSync(db, R_OK)`, which reads as a real check
      // and is not one: access(2) tests unix permission BITS, and TCC leaves those intact
      // while denying the open(). The file is mode 0600 and owned by the user either way, so
      // R_OK returned success on a machine that could not read a single row (#182007).
      //
      // cli/lib/permissions.ts states the rule this violates: "a probe that does not actually
      // touch the file cannot tell 'granted' from 'never asked'." So touch it — open() is the
      // syscall TCC actually denies.
      let fd
      try {
        fd = fs.openSync(db, 'r')
        fs.readSync(fd, Buffer.alloc(1), 0, 1, 0)
      } catch (e) {
        if (e && (e.code === 'EPERM' || e.code === 'EACCES')) {
          return { ok: false, reason: 'No Full Disk Access for Messages — grant it in System Settings › Privacy, then RESTART the daemon (TCC is read at process start)' }
        }
        return { ok: false, reason: `Messages chat.db unreadable: ${(e && e.code) || 'unknown error'}` }
      } finally {
        if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* already gone */ } }
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
      // #182121 — live read of THIS node's local @heyiris mentions log. Secondary to
      // the cross-machine Atlas dataset (#182118): useful for "what has this specific
      // laptop captured right now", not the primary aggregation path (it fails
      // whenever the node is offline, which is exactly what the cloud push solves).
      get_mentions: { method: 'GET', path: '/api/imessage/mentions' },
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
      // READ — which addresses this Mac can send AS. Must be routable from the CLOUD, not just
      // from a local BRIDGE_URL: it is what makes a sender's apple_mail binding checkable, and a
      // check that only runs on the developer's laptop is the "works here, dead in production"
      // failure this rail exists to remove.
      list_accounts: { method: 'GET', path: '/api/mail/accounts' },
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

  // MCP servers this node has ALLOWED, advertised by name so the fleet can route work to a
  // node that has the one it needs — the same shape as a Hive Script's declared requirements.
  // Names and descriptions only: the commands stay on the machine. The fleet needs to know
  // WHICH servers a node offers; it has no business knowing how they are launched.
  try {
    out.mcp = require('./mcp-registry').advertisement()
  } catch (e) {
    // Never let this take the heartbeat down — a node that stops heartbeating reads as
    // OFFLINE, which is a far worse lie than an absent capability.
    out.mcp = { available: false, reason: `mcp registry probe failed: ${e.message}`, detail: null, functions: [] }
  }

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
  let body
  if (route.method === 'GET') {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(args)) {
      if (v === undefined || v === null) continue
      qs.set(k, Array.isArray(v) ? v.join(',') : String(v))
    }
    const q = qs.toString()
    if (q) url += `?${q}`
  } else {
    body = args
  }

  // node:http, not fetch(): fetch's hidden 300s headers timeout capped every route at five
  // minutes whatever timeoutMs said — local_llm.chat died at exactly 5m00s (daemon/http-json.js).
  let res
  try {
    res = await requestJson({ method: route.method, url, headers, body, timeoutMs: route.timeoutMs || 60000 })
  } catch (e) {
    // The bridge HTTP server not listening is a DIFFERENT failure from the route
    // erroring, and the caller can act on it (restart the bridge) only if we say so.
    if (/ECONNREFUSED|ECONNRESET|socket hang up/i.test(e.message)) {
      throw new Error(`Bridge HTTP server is not listening on ${base} (${e.message})`)
    }
    throw new Error(`${providerKey}.${functionName} failed: ${e.message}`)
  }

  if (res.status < 200 || res.status >= 300) {
    const b = res.body
    const detail = (b && (b.error || b.message)) || `HTTP ${res.status}`
    throw new Error(`${providerKey}.${functionName} failed: ${detail}`)
  }

  return res.body
}

module.exports = { PROVIDERS, capabilities, listProviders, call, bridgePort }
