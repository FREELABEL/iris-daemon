'use strict'

/**
 * phi-vault.js — the glue between a PHI task and its encrypted vault (lib/encrypted-vault.js).
 *
 * WHY A SEPARATE MODULE: the executor is 5,000 lines and every PHI rule added inline there is a
 * rule the next task type forgets. Everything a PHI task needs from vaults is here, testable
 * without a daemon:
 *
 *   gate()             before the task runs — full-disk encryption on, the bloq's vault open
 *                      (auto-created, keychain-keyed, on the first PHI task), escrow satisfied.
 *                      Any "no" is a refusal with a reason a human can act on.
 *   absorbWorkspace()  after it runs — every file it left (screenshots, result.json, recordings,
 *                      portal records, the checkpoint) is sealed into the vault, verified, and
 *                      only then deleted.
 *   checkpoint*()      a PHI portal run's checkpoint lives in its workspace (not the shared
 *                      ~/.iris/portal-runs) so it is sealed with everything else; it is restored
 *                      from the vault before a retry runs.
 *   migratePlain()     one-time: PHI task dirs kept as plaintext before vaults existed.
 *   retentionSweep()   daily crypto-shred of working copies older than HIVE_PHI_RETENTION_DAYS.
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const vaults = require('./encrypted-vault')
const disk = require('./disk-encryption')

const CHECKPOINT_SUBDIR = '.portal-runs'

function checkpointTag (runKey) {
  // Hashed: a caller-given run key could be "pull-jane-doe"; the manifest is plaintext.
  return 'ckpt:' + crypto.createHash('sha256').update(String(runKey)).digest('hex').slice(0, 32)
}

/**
 * May this PHI task run here, and into which vault? Never throws.
 * @returns {Promise<{ ok: true, entry: object, created: boolean } | { ok: false, reason: string }>}
 */
async function gate (task, { nodeId = null, cloud = null, diskReport = disk.diskEncryptionReport, platform = process.platform } = {}) {
  const report = diskReport()
  if (!report || report.encrypted !== true) {
    // Refuse only when the server says disk encryption is REQUIRED for this task
    // (config.phi_requires_disk_encryption, set from HIVE_PHI_REQUIRE_DISK_ENCRYPTION). Otherwise
    // run and warn: during rollout, refusing here would stop every PHI task on every machine the
    // moment its daemon upgrades. The vault still encrypts the task's outputs at rest either way.
    const cfg = (task && task.config) || {}
    if (cfg.phi_requires_disk_encryption === true) return { ok: false, reason: disk.refusalReason(report, platform) }
    console.warn(`[phi-vault] full-disk encryption not confirmed on this node — running PHI task anyway (not yet required). ${disk.refusalReason(report, platform)}`)
  }

  let resolved
  try {
    resolved = vaults.resolveForTask(task, { nodeId, phi: true })
  } catch (e) {
    return { ok: false, reason: e.code === 'partition' ? e.message : `phi_vault_unavailable: ${e.message}` }
  }
  const { entry, created, dek } = resolved

  try { vaults.dekFor(entry) } catch (e) { return { ok: false, reason: `phi_vault_locked: ${e.message}` } }

  let escrow = entry.escrow || { status: 'pending' }
  if (!['escrowed', 'not_required'].includes(escrow.status) && cloud) {
    escrow = await vaults.escrowVault(entry.name, {
      dek,
      bloqId: entry.bloq_id,
      taskId: task.id || null,
      fetchTargets: (q) => cloud.get(`/api/v6/node-agent/vaults/escrow-targets?${new URLSearchParams(Object.entries(q).filter(([, v]) => v != null)).toString()}`),
      postWraps: (vaultId, body) => cloud.post(`/api/v6/node-agent/vaults/${vaultId}/escrow-wraps`, body),
    })
  }
  if (dek) dek.fill(0)
  // FAIL CLOSED (hive-crypto.php "fail_closed"): until the server has confirmed escrow is either
  // done or not required, patient data does not go into a vault whose key nobody else holds.
  if (!['escrowed', 'not_required'].includes(escrow.status)) {
    return { ok: false, reason: `phi_vault_escrow_pending: vault "${entry.name}" could not be escrowed as your escrow policy requires (${escrow.reason || 'no reason given'}). An admin must configure hive-crypto.escrow_keys (HIVE_ESCROW_PUBKEY_*) or the tenant's escrow policy in fl-iris-api config/hive-crypto.php; the next PHI task retries.` }
  }
  return { ok: true, entry: vaults.getEntry(entry.name), created }
}

/** The sink cloud-client uses to seal the task's result (attachPhiVault). */
function resultSink (entry, taskId) {
  return {
    async putResult (buf) {
      const { fileId } = await vaults.putBuffer(entry, buf, { name: 'phi-result.json', kind: 'phi-result', tag: `task:${taskId}`, taskId })
      return `vault:${entry.name}/${fileId}`
    },
  }
}

/** Where a PHI portal run keeps its checkpoint while it runs: inside the workspace. */
function checkpointDir (workspaceDir) {
  return path.join(workspaceDir, CHECKPOINT_SUBDIR)
}

/** Before a PHI portal run: put the latest sealed checkpoint for this run key back on disk. */
async function checkpointRestore (entry, runKey, workspaceDir) {
  const ids = vaults.findByTag(entry, checkpointTag(runKey))
  if (!ids.length) return false
  const out = path.join(checkpointDir(workspaceDir), runKey, 'checkpoint.json')
  await vaults.exportObject(entry, ids[ids.length - 1], out)
  return true
}

/**
 * After a PHI task: seal the whole workspace. The checkpoint gets its run-key tag (and replaces
 * the previous one for that key, so retries do not pile up copies of the same progress).
 */
async function absorbWorkspace (entry, workspaceDir, { taskId, runKey = null } = {}) {
  if (!workspaceDir || !fs.existsSync(workspaceDir)) return { absorbed: 0, bytes: 0, failed: [] }
  const ckptRel = runKey ? path.join(CHECKPOINT_SUBDIR, runKey, 'checkpoint.json') : null
  const previous = runKey ? vaults.findByTag(entry, checkpointTag(runKey)) : []
  const res = await vaults.absorbDir(entry, workspaceDir, {
    taskId,
    tagFor: (rel) => (ckptRel && rel === ckptRel ? checkpointTag(runKey) : null),
  })
  if (runKey && !res.failed.some(f => f.path === ckptRel) && vaults.findByTag(entry, checkpointTag(runKey)).length > previous.length) {
    for (const id of previous) vaults.shredObject(entry, id)
  }
  return res
}

/**
 * ONE-TIME MIGRATION of PHI task dirs kept as plaintext before vaults (#187918 left them as
 * <tasksDir>/<id>/ with a phi-result.json). Same encrypt → verify → delete order as absorbDir, so
 * a failure leaves the plaintext exactly where it was. They go into one `phi-migrated` vault that
 * no task can open (their bloq is unknown); a human exports from it on the node. created_at is
 * the MIGRATION time, so the 30-day window starts now rather than shredding old data the moment
 * this daemon upgrades.
 */
async function migratePlain (tasksDir, { nodeId = null, running = () => false } = {}) {
  const out = { tasks: 0, absorbed: 0, bytes: 0, failed: 0 }
  let ids = []
  try { ids = fs.readdirSync(tasksDir) } catch { return out }
  const phiDirs = ids.filter(id => !running(id) && fs.existsSync(path.join(tasksDir, id, 'phi-result.json')))
  if (!phiDirs.length) return out
  let entry
  try { entry = vaults.getEntry('phi-migrated') } catch {
    entry = vaults.createVault({ name: 'phi-migrated', nodeId, phi: true, migrated: true }).entry
  }
  for (const id of phiDirs) {
    const r = await vaults.absorbDir(entry, path.join(tasksDir, id), { taskId: id, kind: 'migrated' })
    out.tasks++
    out.absorbed += r.absorbed
    out.bytes += r.bytes
    out.failed += r.failed.length
  }
  return out
}

/**
 * Daily retention sweep + its audit event. The event is counts only — vault name, file count,
 * bytes, window — never an object name, task, or anything a robot saw.
 */
async function retentionSweep ({ cloud = null, days, now } = {}) {
  const rows = vaults.sweepRetention({ days, now })
  if (rows.length && cloud) {
    try {
      await cloud.post('/api/v6/node-agent/vaults/audit', { event: 'retention_sweep', vaults: rows })
    } catch (e) {
      console.warn(`[vaults] retention sweep audit not delivered (${e.message}) — the shred itself is done`)
    }
  }
  return rows
}

module.exports = { gate, resultSink, checkpointDir, checkpointRestore, checkpointTag, absorbWorkspace, migratePlain, retentionSweep }
