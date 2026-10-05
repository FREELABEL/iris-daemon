'use strict'

/**
 * vault-routes.js — the daemon's HTTP surface for `iris hive vaults …` (encrypted vaults).
 *
 * Mounted under the bridge prefix, behind the daemon's bridge auth like every other local route.
 * WHY THE DAEMON AND NOT THE CLI PROCESS: a passphrase vault's key exists only in the memory of
 * the process that unlocked it, and the process that must read it is the daemon running the PHI
 * task. So unlock has to happen IN the daemon. Everything returned is a summary — names, bloq,
 * node, locked, size — never contents and never object names.
 */

const vaults = require('./encrypted-vault')
const phiVault = require('./phi-vault')

function status (e) {
  return ({ not_found: 404, exists: 409, locked: 423, bad_passphrase: 403, passphrase_required: 400, invalid_name: 422, weak_passphrase: 422, shred_failed: 500 })[e && e.code] || 500
}

function escrowHooks (cloud) {
  return {
    fetchTargets: (q) => cloud.get(`/api/v6/node-agent/vaults/escrow-targets?${new URLSearchParams(Object.entries(q).filter(([, v]) => v != null)).toString()}`),
    postWraps: (vaultId, body) => cloud.post(`/api/v6/node-agent/vaults/${vaultId}/escrow-wraps`, body),
  }
}

function mount (app, prefix, { cloud = () => null, nodeId = () => null } = {}) {
  const fail = (res, e) => res.status(status(e)).json({ error: e.code || 'vault_error', message: e.message })

  app.get(`${prefix}/vaults`, (req, res) => {
    try { res.json({ node_id: nodeId(), retention_days: vaults.retentionDays(), vaults: vaults.listVaults() }) } catch (e) { fail(res, e) }
  })

  app.post(`${prefix}/vaults`, async (req, res) => {
    try {
      const b = req.body || {}
      if (b.node && nodeId() && String(b.node) !== String(nodeId())) {
        return res.status(409).json({ error: 'wrong_node', message: `this daemon is node ${nodeId()}; create the vault on node ${b.node} itself (its key never leaves the machine it is created on)` })
      }
      const { entry, dek } = vaults.createVault({ name: b.name, bloqId: b.bloq_id ?? null, nodeId: nodeId(), passphrase: b.passphrase || null, phi: b.phi !== false })
      const c = cloud()
      if (c) await vaults.escrowVault(entry.name, { dek, bloqId: entry.bloq_id, ...escrowHooks(c) })
      dek.fill(0)
      res.status(201).json({ vault: vaults.summary(vaults.getEntry(entry.name)) })
    } catch (e) { fail(res, e) }
  })

  app.post(`${prefix}/vaults/:name/unlock`, async (req, res) => {
    try {
      const v = vaults.unlock(req.params.name, (req.body || {}).passphrase || null)
      // A passphrase vault created by a CLI process could not escrow then — do it now we hold the key.
      const c = cloud()
      if (c && !['escrowed', 'not_required'].includes(v.escrow)) await vaults.escrowVault(req.params.name, escrowHooks(c))
      res.json({ vault: vaults.summary(vaults.getEntry(req.params.name)) })
    } catch (e) { fail(res, e) }
  })

  app.post(`${prefix}/vaults/:name/lock`, (req, res) => {
    try { res.json({ vault: vaults.lock(req.params.name) }) } catch (e) { fail(res, e) }
  })

  app.delete(`${prefix}/vaults/:name`, async (req, res) => {
    try {
      const r = vaults.destroy(req.params.name)
      const c = cloud()
      if (c) {
        // Counts only. The shred is done whether or not this lands.
        c.post('/api/v6/node-agent/vaults/audit', { event: 'destroyed', vaults: [{ vault: r.vault, vault_id: r.vault_id, files: r.files, bytes: r.bytes }] })
          .catch(err => console.warn(`[vaults] destroy audit not delivered: ${err.message}`))
      }
      res.json({ destroyed: r })
    } catch (e) { fail(res, e) }
  })

  app.post(`${prefix}/vaults/sweep`, async (req, res) => {
    try { res.json({ shredded: await phiVault.retentionSweep({ cloud: cloud() }) }) } catch (e) { fail(res, e) }
  })
}

module.exports = { mount, status }
