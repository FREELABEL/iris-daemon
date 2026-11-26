'use strict'

/**
 * The coding-agent registry (#194315): registry/coding-agents.yaml, loaded, checked, and asked.
 *
 * One table instead of three. The daemon's session report, the CLI's ACP list and Desktop's marks
 * each kept their own list of agents, under different names (claude vs claude_code, gemini vs
 * gemini_cli), so a new agent was three edits in three repos and one of them was always missed.
 *
 * A registry that loads with a mistake in it is worse than none — two agents claiming one alias
 * would route sessions to whichever came first, silently — so load() refuses a bad file and says why.
 */

const fs = require('fs')
const path = require('path')
const YAML = require('yaml')

const FILE = path.join(__dirname, '..', 'registry', 'coding-agents.yaml')
const STATUS = new Set(['supported', 'list_only', 'acp_only', 'planned'])
const CAN = new Set(['list', 'history', 'live', 'message', 'answer'])
const ID = /^[a-z][a-z0-9_]*$/

/** Every problem in the parsed file, as sentences. Empty means it is usable. */
function problemsOf (doc) {
  const out = []
  if (!doc || doc.version !== 1) out.push('version must be 1')
  const agents = (doc && doc.agents) || []
  if (!Array.isArray(agents) || !agents.length) return [...out, 'agents must be a non-empty list']
  const ids = new Map()
  const aliases = new Map()
  for (const [i, a] of agents.entries()) {
    const at = a && a.id ? a.id : `agents[${i}]`
    if (!a || typeof a.id !== 'string' || !ID.test(a.id)) { out.push(`${at}: id must be snake_case`); continue }
    if (ids.has(a.id)) out.push(`${a.id}: id is used twice`)
    ids.set(a.id, a)
    if (typeof a.name !== 'string' || !a.name) out.push(`${a.id}: name is missing`)
    if (!STATUS.has(a.status)) out.push(`${a.id}: status "${a.status}" is not one of ${[...STATUS].join(', ')}`)
    for (const al of [a.id, ...(Array.isArray(a.aliases) ? a.aliases : [])]) {
      const k = String(al).toLowerCase()
      const owner = aliases.get(k)
      if (owner && owner !== a.id) out.push(`alias "${k}" belongs to both ${owner} and ${a.id}`)
      aliases.set(k, a.id)
    }
    const s = a.sessions || {}
    for (const c of s.can || []) if (!CAN.has(c)) out.push(`${a.id}: sessions.can has unknown "${c}"`)
    const collected = a.status === 'supported' || a.status === 'list_only'
    if (collected && !s.collector) out.push(`${a.id}: status ${a.status} needs sessions.collector`)
    if (!collected && s.collector) out.push(`${a.id}: status ${a.status} must not have a collector — mark it supported or list_only`)
    if (collected && !a.verified) out.push(`${a.id}: a collected agent must say where its facts were verified`)
  }
  if (doc.acp_provider && aliases.has(String(doc.acp_provider).toLowerCase())) {
    out.push(`acp_provider "${doc.acp_provider}" must not also be an agent alias`)
  }
  return out
}

/** Load and check the registry. Throws with every problem listed, never a partial table. */
function load (file = FILE) {
  const doc = YAML.parse(fs.readFileSync(file, 'utf8'))
  const problems = problemsOf(doc)
  if (problems.length) throw new Error(`coding-agents.yaml is not usable:\n  - ${problems.join('\n  - ')}`)
  const byAlias = new Map()
  for (const a of doc.agents) for (const al of [a.id, ...(a.aliases || [])]) byAlias.set(String(al).toLowerCase(), a)
  return { doc, agents: doc.agents, byAlias, acpProvider: doc.acp_provider || 'acp' }
}

let cached = null
const registry = () => (cached = cached || load())

/**
 * The agent a reported provider name belongs to. `acpAgent` is the agent under an ACP session.
 * An unknown name still gets a row — { id: null, name: <as reported> } — so a new agent shows up
 * with its own name instead of disappearing, and the gap is visible.
 */
function agentOf (provider, acpAgent, reg = registry()) {
  const p = String(provider || '').toLowerCase()
  if (p === reg.acpProvider.toLowerCase() && acpAgent) return agentOf(acpAgent, null, reg)
  const a = reg.byAlias.get(p)
  return a ? { id: a.id, name: a.name, mark: a.mark || 'other', status: a.status } : { id: null, name: provider || 'unknown', mark: 'other', status: 'unknown' }
}

/**
 * What the session report asks the bridge for: one entry per collector route, plus ACP.
 * `name` is the id the fleet stores (claude_code, not claude-code). Two agents may share a
 * collector (IRIS Desktop is opencode underneath); it is asked once, under the first agent's id.
 */
function collectors (reg = registry()) {
  const seen = new Set()
  const out = []
  for (const a of reg.agents) {
    const slug = a.sessions && a.sessions.collector
    if (!slug || seen.has(slug)) continue
    seen.add(slug)
    out.push({ slug, name: a.id })
  }
  out.push({ slug: reg.acpProvider, name: reg.acpProvider })
  return out
}

/** The registry as served to the CLI and Desktop: what they need, nothing about this machine. */
function publicView (reg = registry()) {
  return {
    version: reg.doc.version,
    acp_provider: reg.acpProvider,
    agents: reg.agents.map((a) => ({
      id: a.id, name: a.name, vendor: a.vendor || null, aliases: a.aliases || [], mark: a.mark || 'other', status: a.status,
      can: (a.sessions && a.sessions.can) || [], acp: a.acp || null, verified: Boolean(a.verified)
    }))
  }
}

module.exports = { FILE, load, problemsOf, agentOf, collectors, publicView }
