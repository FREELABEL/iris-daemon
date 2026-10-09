'use strict'

/**
 * file-search-guard.js — what a file search may send off this machine (#188665).
 *
 * A file search answers with PATHS, and a path is not harmless on a healthcare machine:
 * "~/Documents/Jane Doe - intake.pdf" names a patient. The search engines run locally; this
 * decides what of their answer leaves the node as the task result.
 *
 * Three rules, strictest first:
 *   1. IRIS's own patient-data storage — the encrypted vaults and the task folders PHI tasks write
 *      to — is never in a result, on any machine, not even as a name.
 *   2. A search task the server marked as PHI (`config.phi`, signed with the task, see
 *      lib/phi-task.js) sends back a COUNT, never a file name.
 *   3. A machine marked as handling patient data (`phi_node: true` in ~/.iris/config.json, or
 *      IRIS_PHI_NODE=1) does the same for every search.
 *
 * The count still goes back so that "nothing found" is never confused with "names withheld".
 * Searching ON the machine (iris locate from that machine) shows the names: nothing leaves it.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { isPhiTask } = require('./phi-task')

const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true'

function readNodeConfig () {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.iris', 'config.json'), 'utf-8')) } catch { return {} }
}

/** Is this machine marked as one that handles patient data? */
function phiNode ({ nodeConfig = readNodeConfig(), env = process.env } = {}) {
  return truthy(nodeConfig && nodeConfig.phi_node) || truthy(env.IRIS_PHI_NODE)
}

/** Folders whose contents are IRIS's patient-data storage. */
function privateRoots ({ home = os.homedir(), env = process.env } = {}) {
  return [
    env.IRIS_VAULTS_DIR || path.join(home, '.iris', 'vaults'),
    path.join(home, '.iris', 'daemon-data', 'tasks'),
  ].map((p) => path.resolve(p))
}

/** Is `p` inside one of them? A path prefix, not a substring: ~/.iris/vaultsX is not a vault. */
function isPrivatePath (p, opts = {}) {
  const abs = path.resolve(String(p || ''))
  return privateRoots(opts).some((root) => abs === root || abs.startsWith(root + path.sep))
}

const isRealPath = (r) => r && typeof r.match === 'string' && !r.match.startsWith('(')

/**
 * The rows that may leave this machine for one file search.
 * @param {Array} rows   hive_search file rows ({ source:'files', match, preview, ... })
 * @param {object} opts  { task, home, env, nodeConfig }
 */
function guardFileResults (rows, { task = null, home = os.homedir(), env = process.env, nodeConfig } = {}) {
  const list = (rows || []).filter((r) => !(isRealPath(r) && isPrivatePath(r.match, { home, env })))
  const withhold = isPhiTask(task) || phiNode({ nodeConfig: nodeConfig === undefined ? readNodeConfig() : nodeConfig, env })
  if (!withhold) return list
  const count = list.filter(isRealPath).length
  return [{
    source: 'files',
    match: '(names withheld)',
    preview: `${count} match${count === 1 ? '' : 'es'} — names kept on this machine because it handles patient data. Run iris locate on that machine to see them.`,
    date: null,
    count,
    phi: true,
  }]
}

/**
 * Every row of a hive_search answer — files, iMessage, Hive inbox. On a patient-data search each
 * source becomes one count: a message preview ("Jane, your results are in") or an inbox file name
 * identifies a patient as surely as a file path does.
 */
function guardSearchResults (rows, opts = {}) {
  const order = []
  const bySource = new Map()
  for (const r of rows || []) {
    const src = (r && r.source) || 'files'
    if (!bySource.has(src)) { bySource.set(src, []); order.push(src) }
    bySource.get(src).push(r)
  }
  const out = []
  for (const src of order) {
    const guarded = guardFileResults(bySource.get(src), opts)
    out.push(...guarded.map((r) => (r.phi ? { ...r, source: src, preview: r.preview.replace(/^(\d+) match(es)?/, (m) => `${m} in ${src === 'files' ? 'files' : src}`) } : r)))
  }
  return out
}

module.exports = { guardFileResults, guardSearchResults, phiNode, isPrivatePath, privateRoots }
