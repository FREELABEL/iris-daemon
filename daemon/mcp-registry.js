'use strict'

/**
 * Which MCP servers may this node run?
 *
 * THE ANSWER IS A LOCAL FILE, AND THAT IS THE WHOLE SECURITY MODEL. A task names a server;
 * it never supplies a command. So the cloud can ask this machine to run `argent`, and can
 * only do that if this machine's owner already wrote `argent` into ~/.iris/mcp-servers.json.
 *
 * The alternative — letting the task carry {command, args} — was rejected. The daemon does
 * already run arbitrary shell for `sandbox_execute`, so the capability is not new, but that
 * path goes through planScriptExecution(), which can contain it or refuse. A long-lived MCP
 * server process would bypass that entirely, so it would be a strictly wider hole reached by
 * a strictly quieter route.
 *
 * UNKNOWN NAME IS A REFUSAL, NOT A FALLBACK. There is no "try it anyway" branch.
 *
 * File shape (all fields but `command` optional):
 *
 *   {
 *     "argent": {
 *       "command": "npx",
 *       "args": ["-y", "@swmansion/argent@0.24.0", "mcp"],
 *       "env": { "FOO": "bar" },
 *       "description": "iOS/Android/TV device control"
 *     }
 *   }
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

const CONFIG_PATH = process.env.IRIS_MCP_SERVERS_FILE ||
  path.join(os.homedir(), '.iris', 'mcp-servers.json')

/** A name a task may reference. Deliberately narrow — it ends up in a spawn lookup. */
const NAME_OK = /^[a-z0-9][a-z0-9_-]{0,63}$/i

/**
 * @returns {{servers: object, error: string|null, path: string}}
 *   `error` non-null means we could not READ the list, which is different from the list
 *   being empty — one is a broken node, the other is a node that has opted out. Callers
 *   must not flatten those together.
 */
function loadRegistry (file = CONFIG_PATH) {
  if (!fs.existsSync(file)) {
    return { servers: {}, error: null, path: file }
  }
  let raw
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch (e) {
    return { servers: {}, error: `cannot read ${file}: ${e.message}`, path: file }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    // A malformed file must NOT read as "no servers configured". That would silently
    // disable every MCP tool on the node the moment someone left a trailing comma.
    return { servers: {}, error: `${file} is not valid JSON: ${e.message}`, path: file }
  }

  // Accept both the bare map and the `mcpServers` wrapper other clients use, so a file
  // copied from Claude Desktop or Cursor works without being rewritten.
  const map = (parsed && typeof parsed === 'object' && parsed.mcpServers && typeof parsed.mcpServers === 'object')
    ? parsed.mcpServers
    : parsed

  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    return { servers: {}, error: `${file} must be an object of server-name -> config`, path: file }
  }

  const servers = {}
  for (const [name, cfg] of Object.entries(map)) {
    if (!NAME_OK.test(name)) continue
    if (!cfg || typeof cfg !== 'object') continue
    if (typeof cfg.command !== 'string' || !cfg.command.trim()) continue
    servers[name] = {
      command: cfg.command,
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
      env: (cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)) ? cfg.env : {},
      description: typeof cfg.description === 'string' ? cfg.description : null
    }
  }
  return { servers, error: null, path: file }
}

/**
 * Resolve a task's server name to something spawnable.
 * @returns {{ok: true, name: string, server: object} | {ok: false, reason: string}}
 */
function resolveServer (name, file = CONFIG_PATH) {
  const wanted = String(name || '').trim()
  if (!wanted) return { ok: false, reason: 'no MCP server name given' }

  const { servers, error, path: p } = loadRegistry(file)
  if (error) {
    // Say the list is broken rather than "not allowed" — those send an operator to
    // completely different places.
    return { ok: false, reason: `MCP server list unreadable — ${error}` }
  }

  const known = Object.keys(servers)
  if (!servers[wanted]) {
    return {
      ok: false,
      reason: known.length
        ? `MCP server '${wanted}' is not allowed on this node. Allowed: ${known.join(', ')}. Add it to ${p}.`
        : `no MCP servers are configured on this node. Add one to ${p} to allow it.`
    }
  }
  return { ok: true, name: wanted, server: servers[wanted] }
}

/** What this node advertises on its heartbeat. Names and descriptions only — never commands. */
function advertisement (file = CONFIG_PATH) {
  const { servers, error } = loadRegistry(file)
  const names = Object.keys(servers)
  return {
    available: !error && names.length > 0,
    reason: error || (names.length ? null : 'no MCP servers configured on this node'),
    detail: names.length ? `${names.length} server(s)` : null,
    // The commands stay on the machine. The fleet needs to know WHICH servers a node offers
    // so work can be routed to it; it has no business knowing how they are launched.
    functions: names
  }
}

module.exports = { loadRegistry, resolveServer, advertisement, CONFIG_PATH, NAME_OK }
