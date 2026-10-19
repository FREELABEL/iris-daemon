'use strict'

/**
 * agent_run — run one of the owner's IRIS agents on THIS machine (#189970, #182785, epic #189973).
 *
 * The cloud's V6 `run_on_node` tool sends an agent's own definition (identity prompt, model, tool
 * allowlist) here so a local harness answers AS that agent, with this machine's files and tools.
 * The contract is fixed server-side (fl-iris-api app/Services/V6/RunOnNode.php, protocol v1):
 *
 *   task.type            = "agent_run"
 *   task.timeout_seconds = 15..300
 *   task.config.run_on_node = { version: 1, runtime: "claude_code"|"opencode"|"local_llm",
 *                               agent: { id, name, system_prompt, model|null, tools: [..]|null },
 *                               prompt, requested_by_user_id, conversation_id }
 *   result               = { status, stdout: <final answer only>, stderr, exit_code, metadata }
 *
 * Only config.run_on_node is read. NEVER config.runtime / task.runtime: a daemon that ran the bare
 * prompt under `claude --print` would answer as the wrong agent, with none of its limits. Anything
 * this handler cannot honour exactly — unknown version, runtime not on this machine, a missing
 * field — is REFUSED with a reason, never approximated.
 *
 * TOOL ALLOWLIST → HARNESS PERMISSIONS. The allowlist names V6 cloud tools; most have no local
 * equivalent. A tool maps only where the local tool does the same job (table below); everything
 * else maps to nothing. `null` (no allowlist) is treated as an EMPTY one — the most restrictive
 * reading, never "everything". The harness never gets a tool the allowlist did not name.
 *
 *   V6 tool (any of)                                   claude_code            opencode permission
 *   web_search, search_web, google_search, serper      WebSearch              websearch: allow
 *   web_fetch, fetch_url, fetch_webpage, browse_url    WebFetch               webfetch: allow
 *   read_file, search_files, disk_search, ...          Read, Grep, Glob       read/grep/glob/list: allow
 *   write_file, edit_file                              Edit, Write            edit: allow
 *   run_iris_command                                   Bash(iris:*)           bash: { "iris *": allow }
 *   (anything else, or null)                           —                      —
 *
 * claude_code gets the list via `--tools` (the only built-ins that exist) AND `--allowedTools`
 * (pre-approved), under `--permission-mode dontAsk` (anything else is denied, never prompted).
 * opencode gets OPENCODE_PERMISSION with every key denied except the mapped ones.
 * local_llm is a plain chat completion — it has no tools, which is already the narrowest mode.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn: nodeSpawn } = require('child_process')

const TASK_TYPE = 'agent_run'
const PROTOCOL_VERSION = 1
const RUNTIMES = ['claude_code', 'opencode', 'local_llm']
const MAX_TIMEOUT_SECONDS = 300
const DEFAULT_TIMEOUT_SECONDS = 120

/** V6 tool name → local capability. Lowercased lookup. */
const TOOL_CAPABILITY = {
  web_search: 'web_search',
  search_web: 'web_search',
  google_search: 'web_search',
  serper_search: 'web_search',
  web_fetch: 'web_fetch',
  fetch_url: 'web_fetch',
  fetch_webpage: 'web_fetch',
  browse_url: 'web_fetch',
  read_file: 'read_files',
  read_files: 'read_files',
  search_files: 'read_files',
  disk_search: 'read_files',
  local_file_search: 'read_files',
  write_file: 'edit_files',
  edit_file: 'edit_files',
  run_iris_command: 'iris_cli'
}

const CLAUDE_TOOLS = {
  web_search: { tools: ['WebSearch'], allowed: ['WebSearch'] },
  web_fetch: { tools: ['WebFetch'], allowed: ['WebFetch'] },
  read_files: { tools: ['Read', 'Grep', 'Glob'], allowed: ['Read', 'Grep', 'Glob'] },
  edit_files: { tools: ['Edit', 'Write'], allowed: ['Edit', 'Write'] },
  iris_cli: { tools: ['Bash'], allowed: ['Bash(iris:*)'] }
}

/** Every opencode permission key we know of. All start denied; unknown keys are ignored by opencode. */
const OPENCODE_DENY_ALL = {
  edit: 'deny',
  bash: 'deny',
  webfetch: 'deny',
  websearch: 'deny',
  read: 'deny',
  grep: 'deny',
  glob: 'deny',
  list: 'deny',
  task: 'deny',
  todowrite: 'deny',
  external_directory: 'deny',
  doom_loop: 'deny'
}

const OPENCODE_GRANTS = {
  web_search: { websearch: 'allow' },
  web_fetch: { webfetch: 'allow' },
  read_files: { read: 'allow', grep: 'allow', glob: 'allow', list: 'allow' },
  edit_files: { edit: 'allow' },
  iris_cli: { bash: { 'iris *': 'allow', '*': 'deny' } }
}

/** The local capabilities an allowlist grants. null / non-array → none. */
function allowlistCapabilities (tools) {
  if (!Array.isArray(tools)) return []
  const caps = new Set()
  for (const t of tools) {
    const cap = TOOL_CAPABILITY[String(t).trim().toLowerCase()]
    if (cap) caps.add(cap)
  }
  return [...caps].sort()
}

/** claude_code: { tools: "--tools" value, allowed: "--allowedTools" entries }. */
function claudeToolFlags (tools) {
  const t = new Set()
  const a = new Set()
  for (const cap of allowlistCapabilities(tools)) {
    CLAUDE_TOOLS[cap].tools.forEach((x) => t.add(x))
    CLAUDE_TOOLS[cap].allowed.forEach((x) => a.add(x))
  }
  return { tools: [...t], allowed: [...a] }
}

/** opencode: the OPENCODE_PERMISSION object. */
function opencodePermission (tools) {
  const perm = { ...OPENCODE_DENY_ALL }
  for (const cap of allowlistCapabilities(tools)) Object.assign(perm, OPENCODE_GRANTS[cap])
  return perm
}

/**
 * Validate a task against protocol v1 and this machine. Returns { spec } or { error }.
 * @param {object} task
 * @param {string[]} available runtimes this node can run right now
 */
function validateAgentRun (task, available) {
  if (!task || task.type !== TASK_TYPE) return { error: `not an ${TASK_TYPE} task` }
  const ron = task.config && task.config.run_on_node
  if (!ron || typeof ron !== 'object' || Array.isArray(ron)) {
    return { error: 'agent_run refused: config.run_on_node is missing — this daemon runs an agent only from its full definition, never a bare prompt' }
  }
  if (ron.version !== PROTOCOL_VERSION) {
    return { error: `agent_run refused: run_on_node protocol version ${JSON.stringify(ron.version)} is not supported by this daemon (it speaks version ${PROTOCOL_VERSION})` }
  }
  if (!RUNTIMES.includes(ron.runtime)) {
    return { error: `agent_run refused: unknown runtime ${JSON.stringify(ron.runtime)} (expected one of ${RUNTIMES.join(', ')})` }
  }
  if (!Array.isArray(available) || !available.includes(ron.runtime)) {
    return { error: `agent_run refused: runtime "${ron.runtime}" is not available on this machine (available: ${(available || []).join(', ') || 'none'})` }
  }
  const agent = ron.agent
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return { error: 'agent_run refused: run_on_node.agent is missing' }
  const missing = []
  if (agent.id === undefined || agent.id === null || agent.id === '') missing.push('agent.id')
  if (typeof agent.name !== 'string') missing.push('agent.name')
  if (typeof agent.system_prompt !== 'string' || !agent.system_prompt.trim()) missing.push('agent.system_prompt')
  if (!('model' in agent)) missing.push('agent.model')
  if (!('tools' in agent)) missing.push('agent.tools')
  if (agent.tools !== null && agent.tools !== undefined && !Array.isArray(agent.tools)) missing.push('agent.tools (must be a list or null)')
  if (agent.model !== null && agent.model !== undefined && typeof agent.model !== 'string') missing.push('agent.model (must be a string or null)')
  if (typeof ron.prompt !== 'string' || !ron.prompt.trim()) missing.push('prompt')
  if (ron.requested_by_user_id === undefined || ron.requested_by_user_id === null) missing.push('requested_by_user_id')
  if (typeof ron.conversation_id !== 'string' || !ron.conversation_id) missing.push('conversation_id')
  if (missing.length) return { error: `agent_run refused: run_on_node payload is missing or malformed: ${missing.join(', ')}` }

  let timeout = Number(task.timeout_seconds)
  if (!Number.isFinite(timeout) || timeout <= 0) timeout = DEFAULT_TIMEOUT_SECONDS
  timeout = Math.min(Math.floor(timeout), MAX_TIMEOUT_SECONDS)

  return {
    spec: {
      runtime: ron.runtime,
      agent: {
        id: agent.id,
        name: agent.name,
        system_prompt: agent.system_prompt,
        model: agent.model || null,
        tools: Array.isArray(agent.tools) ? agent.tools.map(String) : null
      },
      prompt: ron.prompt,
      requestedBy: ron.requested_by_user_id,
      conversationId: ron.conversation_id,
      timeoutSeconds: timeout
    }
  }
}

/** The agent's identity, as the harness's system/instructions input. */
function systemPromptFor (spec) {
  const name = spec.agent.name ? spec.agent.name : `agent #${spec.agent.id}`
  return `${spec.agent.system_prompt.trim()}\n\n` +
    `<run_context>\nYou are running as the IRIS agent "${name}" (id ${spec.agent.id}) on the owner's own machine, ` +
    `at the request of user ${spec.requestedBy} (conversation ${spec.conversationId}). ` +
    'Answer the request directly; your final message is returned to the caller verbatim.\n</run_context>'
}

/** A Claude model id or alias the claude CLI can take; anything else (gpt-*, etc.) is dropped. */
function claudeModel (model) {
  if (!model) return null
  const m = String(model).trim()
  return /^(claude-[\w.-]+|opus|sonnet|haiku|fable)$/i.test(m) ? m : null
}

/** opencode wants provider/model; a bare id cannot be routed, so it is dropped. */
function opencodeModel (model) {
  if (!model) return null
  const m = String(model).trim()
  return /^[\w.-]+\/[\w.:#/-]+$/.test(m) ? m : null
}

/**
 * The exact process to run. Pure: everything it needs is passed in.
 * @returns {{ cmd, args, env, stdin, files: {path, content}[], model: string|null, parse: 'text'|'opencode_json'|'chat_json' }}
 */
function buildRuntimeCommand (spec, opts = {}) {
  const system = systemPromptFor(spec)
  const workDir = opts.workDir || os.tmpdir()

  if (spec.runtime === 'claude_code') {
    const sysFile = path.join(workDir, 'agent-system-prompt.md')
    const { tools, allowed } = claudeToolFlags(spec.agent.tools)
    const model = claudeModel(spec.agent.model)
    const args = [
      '--print',
      '--output-format', 'text',
      '--system-prompt-file', sysFile,
      '--tools', tools.join(','),
      '--permission-mode', 'dontAsk',
      '--strict-mcp-config',
      '--no-session-persistence'
    ]
    if (allowed.length) args.push('--allowedTools', allowed.join(','))
    if (model) args.push('--model', model)
    // The prompt goes on STDIN: argv is visible to every user in `ps` and capped by ARG_MAX.
    return { cmd: opts.claudeBin || 'claude', args, env: {}, stdin: spec.prompt, files: [{ path: sysFile, content: system }], model, parse: 'text' }
  }

  if (spec.runtime === 'opencode') {
    // OpenCode has no system-prompt flag, and `iris run` may answer from a background service
    // that never sees this folder's AGENTS.md — so the identity travels at the head of the message.
    const model = opencodeModel(spec.agent.model)
    const message = `<agent_instructions>\n${system}\n</agent_instructions>\n\n${spec.prompt}`
    const bin = opts.opencodeBin || 'opencode'
    const args = ['run', '--format', 'json']
    // `iris run` (the IRIS build of OpenCode) answers from a shared background service by default,
    // which never sees this process's OPENCODE_PERMISSION. --standalone runs a private server that
    // does — without it the allowlist mapping below would be decoration.
    if (path.basename(bin) === 'iris') args.push('--standalone')
    if (model) args.push('--model', model)
    args.push(message)
    return {
      cmd: bin,
      args,
      env: { OPENCODE_PERMISSION: JSON.stringify(opencodePermission(spec.agent.tools)) },
      stdin: null,
      files: [],
      model,
      parse: 'opencode_json'
    }
  }

  // local_llm — the node's own OpenAI-compatible server; the URL is the node's, never the task's.
  const localLlm = require('./local-llm')
  const known = Array.isArray(opts.localModels) ? opts.localModels : []
  const model = spec.agent.model && known.includes(spec.agent.model) ? spec.agent.model : null
  const cfg = localLlm.resolveLocalLlmConfig({ config: model ? { model } : {} }, opts.env || process.env)
  const body = localLlm.buildChatBody({ prompt: spec.prompt, config: { system_prompt: system } }, cfg)
  return { cmd: 'curl', args: localLlm.buildCurlArgs(cfg), env: {}, stdin: JSON.stringify(body), files: [], model: cfg.model, parse: 'chat_json', llm: cfg }
}

/**
 * The final answer from `opencode run --format json` ({type:"text", part:{text}} per finished text
 * part): the text of the LAST one. Returns { answer, error } — error from an {type:"error"} event.
 */
function parseOpencodeJson (raw) {
  let last = null
  let sawJson = false
  let error = null
  for (const line of String(raw || '').split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    let ev
    try { ev = JSON.parse(s) } catch { continue }
    sawJson = true
    if (ev.type === 'error' && ev.error) {
      const e = ev.error
      error = (e.data && e.data.message) || e.message || e.name || JSON.stringify(e)
    }
    const part = ev.part || ev.properties?.part || null
    const text = ev.type === 'text' && part && typeof part.text === 'string' ? part.text : null
    if (text !== null && text.trim()) last = text
  }
  if (last !== null) return { answer: last.trim(), error }
  return { answer: sawJson ? '' : String(raw || '').trim(), error }
}

/**
 * Run an agent_run task. Never throws: every outcome is a result payload.
 * deps: { available: string[], spawn, workDir, env, localModels, claudeBin, opencodeBin, onSpawn(child), killGraceMs,
 *         secondMs (test seam: ms per timeout second) }
 */
async function runAgentRun (task, deps = {}) {
  const started = Date.now()
  const v = validateAgentRun(task, deps.available)
  if (v.error) {
    return { status: 'failed', error: v.error, stdout: '', stderr: v.error, output: '', exit_code: null, duration_ms: 0, metadata: { exit_code: null, refused: true } }
  }
  const spec = v.spec
  const workDir = deps.workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'agent-run-'))
  const plan = buildRuntimeCommand(spec, { ...deps, workDir })
  for (const f of plan.files) fs.writeFileSync(f.path, f.content, { mode: 0o600 })

  const meta = {
    runtime: spec.runtime,
    agent_id: spec.agent.id,
    model: plan.model,
    tool_capabilities: allowlistCapabilities(spec.agent.tools),
    conversation_id: spec.conversationId,
    timeout_seconds: spec.timeoutSeconds
  }
  const spawn = deps.spawn || nodeSpawn
  const out = []
  const err = []
  let timedOut = false

  const code = await new Promise((resolve) => {
    let child
    try {
      child = spawn(plan.cmd, plan.args, {
        cwd: workDir,
        env: { ...(deps.env || process.env), ...plan.env },
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (e) {
      err.push(`could not start ${plan.cmd}: ${e.message}`)
      return resolve(null)
    }
    if (typeof deps.onSpawn === 'function') { try { deps.onSpawn(child) } catch { /* bookkeeping only */ } }
    let done = false
    const finish = (c) => { if (!done) { done = true; clearTimeout(timer); resolve(c) } }
    const timer = setTimeout(() => {
      timedOut = true
      try { require('./child-lifecycle').killWithEscalation(child, deps.killGraceMs ?? 5000) } catch { /* already gone */ }
      finish(null)
    }, spec.timeoutSeconds * (deps.secondMs || 1000))
    if (child.stdout) child.stdout.on('data', (d) => out.push(d.toString()))
    if (child.stderr) child.stderr.on('data', (d) => err.push(d.toString()))
    child.on('error', (e) => { err.push(e.code === 'ENOENT' ? `${plan.cmd} is not installed on this machine` : e.message); finish(null) })
    child.on('close', (c) => finish(c))
    // Always close stdin — a harness waiting for EOF never exits (#188351).
    try { require('./child-lifecycle').closeStdin(child, plan.stdin) } catch { /* closed early; close/error reports it */ }
  })

  const raw = out.join('')
  const stderr = err.join('').trim()
  const base = { stderr, duration_ms: Date.now() - started, metadata: { ...meta, exit_code: code } }

  if (timedOut) {
    const msg = `agent_run timed out after ${spec.timeoutSeconds}s (${spec.runtime})`
    return { ...base, status: 'timeout', error: msg, stdout: '', output: '', exit_code: null }
  }
  if (code !== 0) {
    const why = stderr || raw.trim().slice(-500) || 'no output'
    return { ...base, status: 'failed', error: `${spec.runtime} exited with code ${code}: ${why.slice(0, 500)}`, stdout: '', output: '', exit_code: code }
  }

  let answer
  if (plan.parse === 'chat_json') {
    const r = require('./local-llm').parseLocalLlmResponse(raw)
    if (r.error) return { ...base, status: 'failed', error: `local model (${plan.model}) failed: ${r.error}`, stdout: '', output: '', exit_code: code }
    answer = r.content === null ? raw.trim() : String(r.content).trim()
  } else if (plan.parse === 'opencode_json') {
    const r = parseOpencodeJson(raw)
    if (!r.answer && r.error) return { ...base, status: 'failed', error: `opencode failed: ${String(r.error).slice(0, 500)}`, stdout: '', output: '', exit_code: code }
    answer = r.answer
  } else {
    answer = raw.trim()
  }
  if (!answer) {
    return { ...base, status: 'failed', error: `${spec.runtime} finished without an answer`, stdout: '', output: '', exit_code: code }
  }
  return { ...base, status: 'completed', stdout: answer, output: answer, exit_code: 0 }
}

/**
 * Which runtimes this machine can run, found the same way the executor will spawn them
 * (PATH plus ~/.iris/bin). local_llm counts only when the local model server answered with models.
 * deps: { env, home, exists(p) -> bool (executable), localModels: report|null }
 */
function detectRuntimes (deps = {}) {
  const { onPath } = require('./agent-cli')
  const home = deps.home || os.homedir()
  const env = deps.env || process.env
  const PATH = [path.join(home, '.iris', 'bin'), env.PATH || ''].filter(Boolean).join(path.delimiter)
  const scoped = { ...env, PATH }
  const found = {}
  const claude = onPath('claude', scoped, deps.exists)
  if (claude) found.claude_code = claude
  const opencode = onPath('opencode', scoped, deps.exists) || onPath('iris', scoped, deps.exists)
  if (opencode) found.opencode = opencode
  const lm = deps.localModels
  if (lm && lm.available === true && Array.isArray(lm.models) && lm.models.length > 0) found.local_llm = 'curl'
  return found
}

/** The heartbeat field: { version, runtimes } — runtimes only those detected here. */
function runOnNodeCapability (found) {
  return { version: PROTOCOL_VERSION, runtimes: RUNTIMES.filter((r) => found && found[r]) }
}

module.exports = {
  TASK_TYPE,
  PROTOCOL_VERSION,
  RUNTIMES,
  MAX_TIMEOUT_SECONDS,
  allowlistCapabilities,
  claudeToolFlags,
  opencodePermission,
  validateAgentRun,
  buildRuntimeCommand,
  parseOpencodeJson,
  runAgentRun,
  detectRuntimes,
  runOnNodeCapability
}
