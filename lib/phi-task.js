'use strict'

/**
 * phi-task.js — "is this task inside a PHI boundary, and what may leave the node if it is?"
 *
 * WHY THIS EXISTS (#187917 / #187918, GAP J "portal robots on machines we own"). A portal robot
 * reads patient data off a screen. Two things carried what it saw off the machine regardless of
 * any PHI policy:
 *   - the browser agent sent page text straight to api.openai.com with the node's own key, so
 *     fl-iris-api's PHI egress guard never saw the call (#187917);
 *   - every task result shipped stdout, stderr, the output files (screenshots, result.json with
 *     the step history) and — for custom_playwright with a lead — the .webm recording (#187918).
 *
 * HOW A TASK IS KNOWN TO BE PHI. fl-iris-api stamps `config.phi = true` on the task it hands a
 * node when the task declares it or its bloq sits inside a contains_phi boundary (PhiScope walks
 * the parent chain; the daemon cannot). `config` is covered by the task's HMAC signature, so the
 * flag is the server's word, not something a page or a script can strip. `config.contains_phi`
 * and a top-level `phi` are accepted too, because either spelling means the same thing and a
 * false negative here is the expensive direction.
 *
 * Node built-ins only (CommonJS) so the browser-agent subprocess and the daemon share one answer.
 */

const { safeSummary } = require('./portal-checkpoint')

/**
 * Why a PHI task was REFUSED before it ran (lib/phi-vault.js gate). A code from this fixed list is
 * the one piece of "why" that may leave the node for a PHI task: it is chosen by daemon code, not
 * by a robot or a page, so it cannot quote a patient. The server maps each code to fixed text
 * (fl-iris-api NodeTaskPhi::REFUSALS) — the operator learns "turn on FileVault", not "failed".
 */
const PHI_REFUSAL_CODES = ['phi_requires_disk_encryption', 'phi_vault_locked', 'phi_vault_escrow_pending', 'vault_partition_denied', 'phi_vault_unavailable']

function refusalCode (reason) {
  const m = /^([a-z_]+):/.exec(String(reason || ''))
  return m && PHI_REFUSAL_CODES.includes(m[1]) ? m[1] : null
}

function truthy (v) {
  return v === true || v === 1 || v === '1' || v === 'true'
}

/** @param {object|null|undefined} task */
function isPhiTask (task) {
  if (!task || typeof task !== 'object') return false
  const cfg = task.config && typeof task.config === 'object' ? task.config : {}
  return truthy(task.phi) || truthy(cfg.phi) || truthy(cfg.contains_phi)
}

/**
 * The ONLY fields a PHI task's result may carry off the node (#187918 "stdout limited to a
 * declared result schema"). Everything else — output, stdout, stderr, files, free-text error —
 * stays in the local result file named by `local_ref`.
 *
 * `error` becomes a fixed code: an exception message from a portal robot routinely quotes the
 * page ("could not find patient 'Jane Doe'"), so there is no safe way to forward it verbatim.
 */
function phiSafeResult (result = {}, { localRef = null } = {}) {
  const status = typeof result.status === 'string' ? result.status : 'failed'
  const md = result.metadata && typeof result.metadata === 'object' ? result.metadata : {}
  const exitCode = Number.isInteger(result.exit_code) ? result.exit_code : (Number.isInteger(md.exit_code) ? md.exit_code : null)
  const withheld = ['output', 'stdout', 'stderr', 'files', 'error', 'data']
    .filter(k => result[k] !== undefined && result[k] !== null && result[k] !== '' && !(Array.isArray(result[k]) && result[k].length === 0))

  const portalRun = safeSummary(result.data && result.data.portal_run)
  const safe = {
    status,
    duration_ms: Number.isFinite(result.duration_ms) ? result.duration_ms : null,
    exit_code: exitCode,
    // Structured, non-free-text: booleans, integers, and a path on THIS machine.
    data: {
      phi: true,
      success: status === 'completed' || status === 'completed_with_warnings',
      exit_code: exitCode,
      local_ref: localRef,
      // #187919: a portal run's per-record progress — counts and indexes, re-validated here so a
      // name or an MRN a script slipped into it cannot ride along. "Record 26 of 50 failed" is
      // what the operator needs to retry, and it says nothing about a patient.
      ...(portalRun ? { portal_run: portalRun } : {}),
    },
    metadata: {
      phi: true,
      local_ref: localRef,
      withheld,
      exit_code: exitCode,
      executed_by_node_id: md.executed_by_node_id ?? null,
      executed_by_node_name: md.executed_by_node_name ?? null,
      ...(typeof md.internal_status === 'string' ? { internal_status: md.internal_status } : {}),
      ...(PHI_REFUSAL_CODES.includes(md.phi_refusal) ? { phi_refusal: md.phi_refusal } : {}),
    },
  }
  if (status !== 'completed' && status !== 'completed_with_warnings') {
    safe.error = PHI_REFUSAL_CODES.includes(md.phi_refusal)
      ? `phi_refused:${md.phi_refusal}`
      : 'phi_task_failed: details kept on the node'
  }
  return safe
}

module.exports = { isPhiTask, phiSafeResult, PHI_REFUSAL_CODES, refusalCode }
