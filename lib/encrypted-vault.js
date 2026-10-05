'use strict'

/**
 * encrypted-vault.js — partitioned, encrypted Hive vaults for what PHI tasks KEEP on a node.
 *
 * WHY THIS EXISTS. #187918 made "what the robot saw stays where the robot ran" true: a PHI task's
 * full result, screenshots, workspace and portal checkpoint stay on the node. But they stayed as
 * plain 0600 files under ~/.iris — readable by anything running as that user, by a backup, by
 * whoever has the laptop. And nothing ever deleted them. This module is the other half:
 *
 *   PARTITIONED  Each vault has its OWN 32-byte data key (DEK), is bound to this node and
 *                optionally to ONE bloq. A task for bloq X can only open a vault bound to X
 *                (canOpen) — clinic A's robot can never be handed clinic B's vault.
 *   ENCRYPTED    Every object is AES-256-GCM under its own file key (FEK), streamed in 1 MiB
 *                chunks so a 200 MB recording never sits in memory. Each chunk's AAD binds vault
 *                id, object id, chunk index and a FINAL flag, so chunks cannot be reordered,
 *                swapped between objects, or truncated without the read failing.
 *   SHREDDABLE   An object's FEK lives in its own small key file sealed under the DEK. Deleting
 *                that file (crypto-shred) makes the object unrecoverable even from a copy of the
 *                ciphertext — and it works on a LOCKED vault, because it needs no key, which is
 *                what lets the retention sweep run unattended. Destroying a vault deletes its DEK
 *                from the OS keystore, which takes every object with it.
 *
 * KEYS. Default: the DEK is held by the OS keystore the node credential vault already uses
 * (lib/node-vault.js backends — Keychain / libsecret / DPAPI / 0600 file) under its own account
 * name, so unattended robots work after a reboot. `--passphrase`: the DEK is wrapped by scrypt of
 * a passphrase and only ever held in THIS process's memory after `unlock`, so a restart leaves it
 * locked until a human unlocks it.
 *
 * WHAT IS PLAINTEXT ON DISK, ON PURPOSE: registry.json (vault names, ids, bloq/node binding, key
 * source, timestamps) and each vault's manifest.json (object ids, sizes, created_at, a tag like
 * `task:<uuid>`). No contents, no file names — names a robot chose ("jane-doe.png") are sealed
 * inside the object's key file. created_at must be readable without a key so the retention sweep
 * can age data in a locked vault.
 */

const crypto = require('crypto')
const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const nodeVault = require('./node-vault')

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const CHUNK = 1024 * 1024
const MAGIC = Buffer.from('IRV1')
const TAG_LEN = 16
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const DEFAULT_RETENTION_DAYS = 30

// Passphrase-vault DEKs after `unlock`. Process memory ONLY — never written anywhere — which is
// the whole meaning of "stays locked until a human unlocks after restart".
const unlocked = new Map()

class VaultError extends Error {
  constructor (code, message) { super(message); this.code = code }
}

function rootDir () {
  return process.env.IRIS_VAULTS_DIR || path.join(os.homedir(), '.iris', 'vaults')
}

function mkdir700 (dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(dir, 0o700) } catch { /* windows: ACLs */ }
  return dir
}

function writeJsonAtomic (file, obj) {
  mkdir700(path.dirname(file))
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

function readJson (file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

// ─── Registry (names + bindings, never contents) ─────────────────────────────

function registryPath () { return path.join(rootDir(), 'registry.json') }
function readRegistry () { const r = readJson(registryPath(), null); return r && r.vaults ? r : { version: 1, vaults: {} } }
function writeRegistry (r) { writeJsonAtomic(registryPath(), r) }

function vaultPath (entry) { return path.join(rootDir(), entry.id) }
function manifestPath (entry) { return path.join(vaultPath(entry), 'manifest.json') }
function readManifest (entry) { const m = readJson(manifestPath(entry), null); return m && m.objects ? m : { objects: {} } }
function writeManifest (entry, m) { writeJsonAtomic(manifestPath(entry), m) }
function keyAccount (entry) { return `vault-dek:${entry.id}` }
function passFile (entry) { return path.join(vaultPath(entry), 'dek.pass.json') }

function validName (name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new VaultError('invalid_name', 'vault name must be 1-64 chars of letters, digits, ".", "_" or "-"')
  return name
}

function getEntry (name) {
  const e = readRegistry().vaults[validName(name)]
  if (!e) throw new VaultError('not_found', `no vault named "${name}" on this node — create it with: iris hive vaults create ${name} --encrypted`)
  return e
}

function updateEntry (name, patch) {
  const r = readRegistry()
  if (!r.vaults[name]) throw new VaultError('not_found', `no vault named "${name}"`)
  r.vaults[name] = { ...r.vaults[name], ...patch }
  writeRegistry(r)
  return r.vaults[name]
}

function normBloq (v) {
  if (v === undefined || v === null || v === '') return null
  return String(v)
}

// ─── Small sealed records (key files, passphrase wrap) ───────────────────────

function sealRecord (key, obj, aad) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()])
  return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') }
}

function openRecord (key, rec, aad) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(rec.iv, 'base64'))
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(Buffer.from(rec.tag, 'base64'))
  return JSON.parse(Buffer.concat([d.update(Buffer.from(rec.ct, 'base64')), d.final()]).toString('utf8'))
}

function passKek (passphrase, salt, p = SCRYPT) {
  return crypto.scryptSync(String(passphrase).normalize('NFKC'), salt, 32, p)
}

// ─── Keys ────────────────────────────────────────────────────────────────────

/** The vault's DEK, or a VaultError saying exactly why it cannot be opened. */
function dekFor (entry) {
  if (entry.locked) throw new VaultError('locked', `vault "${entry.name}" is locked — unlock it with: iris hive vaults unlock ${entry.name}`)
  if (entry.key_source === 'passphrase') {
    const k = unlocked.get(entry.id)
    if (!k) throw new VaultError('locked', `vault "${entry.name}" is passphrase-protected and locked since this daemon started — unlock it with: iris hive vaults unlock ${entry.name}`)
    return k
  }
  const backend = nodeVault.backends[entry.backend]
  const k = backend ? backend.get(keyAccount(entry)) : null
  if (!k || k.length !== 32) throw new VaultError('key_missing', `vault "${entry.name}" has no key in the ${entry.backend} keystore on this machine — it was destroyed, or this is a different OS user`)
  return k
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Create a vault. Returns { entry, dek } — the DEK is handed back ONLY so the caller can wrap it
 * to escrow right now (escrowVault); it is not kept anywhere but the keystore / memory.
 */
function createVault ({ name, bloqId = null, nodeId = null, passphrase = null, phi = false, migrated = false } = {}) {
  validName(name)
  const reg = readRegistry()
  if (reg.vaults[name]) throw new VaultError('exists', `a vault named "${name}" already exists on this node`)
  const id = crypto.randomUUID() // a UUID because the server's key-wrap table keys transfers by char(36)
  const now = new Date().toISOString()
  const dek = crypto.randomBytes(32)
  const entry = {
    id,
    name,
    node_id: nodeId != null ? String(nodeId) : null,
    bloq_id: normBloq(bloqId),
    key_source: passphrase ? 'passphrase' : 'keychain',
    backend: null,
    phi: !!phi,
    migrated: !!migrated,
    locked: false,
    created_at: now,
    last_write_at: null,
    escrow: { policy: null, status: 'pending', reason: 'not yet attempted', targets: [] },
  }
  mkdir700(path.join(rootDir(), id, 'objects'))
  mkdir700(path.join(rootDir(), id, 'keys'))
  if (passphrase) {
    if (String(passphrase).length < 8) throw new VaultError('weak_passphrase', 'passphrase must be at least 8 characters')
    const salt = crypto.randomBytes(16)
    const rec = sealRecord(passKek(passphrase, salt), { dek: dek.toString('base64') }, `iris-vault-pass|${id}`)
    writeJsonAtomic(passFile(entry), { ...rec, kdf: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64') })
    unlocked.set(id, dek) // the creator just typed it: unlocked for this process
  } else {
    entry.backend = nodeVault.backendFor()
    nodeVault.backends[entry.backend].set(dek, keyAccount(entry))
  }
  writeManifest(entry, { objects: {} })
  reg.vaults[name] = entry
  writeRegistry(reg)
  return { entry, dek }
}

/**
 * Wrap the DEK to platform escrow when the tenant's policy says so (fl-iris-api EscrowPolicy,
 * via GET /v6/node-agent/vaults/escrow-targets). The SERVER decides the target set and re-checks
 * it when the wraps come back (TransferEnvelopeService::recordWraps) — the node cannot opt out.
 *
 *   forbidden            → nothing is wrapped; status not_required.
 *   permitted, no keys   → nothing is wrapped; status not_required.
 *   required / keys set  → one ihw.v1 wrap per escrow holder, transfer id = vault id.
 *   any failure          → status pending (+ reason). Under `required` a PHI task refuses to
 *                          write into a pending vault — fail closed, never silently unescrowed.
 */
async function escrowVault (name, { dek = null, fetchTargets, postWraps, bloqId, taskId } = {}) {
  const entry = getEntry(name)
  if (entry.escrow && ['escrowed', 'not_required'].includes(entry.escrow.status)) return entry.escrow
  const { wrapDek } = require('./envelope')
  let escrow
  try {
    const res = await fetchTargets({ vault_id: entry.id, bloq_id: bloqId ?? entry.bloq_id, task_id: taskId || null })
    const targets = (res && Array.isArray(res.targets) ? res.targets : []).filter(t => t && (t.type === 'escrow' || String(t.id || '').startsWith('escrow:')))
    const policy = res && res.policy
    if (!policy) throw new Error((res && (res.message || res.error)) || 'server returned no escrow policy')
    if (policy === 'forbidden' || targets.length === 0) {
      escrow = { policy, status: 'not_required', reason: res.policy_reason || res.reason || null, targets: [] }
    } else {
      const key = dek || dekFor(entry)
      const wraps = targets.map(t => {
        const w = wrapDek(key, Buffer.from(t.public_key, 'base64'), entry.id, t.id)
        return { target_type: 'escrow', target_id: t.id, eph_public: w.eph_public.toString('base64'), nonce: w.nonce.toString('base64'), wrapped_dek: w.ciphertext.toString('base64'), tag: w.tag.toString('base64') }
      })
      await postWraps(entry.id, { bloq_id: bloqId ?? entry.bloq_id, task_id: taskId || null, wraps })
      escrow = { policy, status: 'escrowed', reason: res.policy_reason || null, targets: targets.map(t => t.id) }
    }
  } catch (e) {
    escrow = { policy: (entry.escrow && entry.escrow.policy) || null, status: 'pending', reason: String(e.message || e).slice(0, 300), targets: [] }
  }
  updateEntry(name, { escrow })
  return escrow
}

function unlock (name, passphrase = null) {
  const entry = getEntry(name)
  if (entry.key_source === 'passphrase') {
    if (!passphrase) throw new VaultError('passphrase_required', `vault "${name}" needs its passphrase to unlock`)
    const rec = readJson(passFile(entry), null)
    if (!rec) throw new VaultError('key_missing', `vault "${name}" has no passphrase key file — it was destroyed`)
    let dek
    try {
      dek = Buffer.from(openRecord(passKek(passphrase, Buffer.from(rec.salt, 'base64'), { N: rec.N, r: rec.r, p: rec.p, maxmem: SCRYPT.maxmem }), rec, `iris-vault-pass|${entry.id}`).dek, 'base64')
    } catch { throw new VaultError('bad_passphrase', `wrong passphrase for vault "${name}"`) }
    unlocked.set(entry.id, dek)
  }
  if (entry.locked) updateEntry(name, { locked: false })
  return summary(getEntry(name))
}

/** Passphrase vault: forget the DEK. Keychain vault: refuse automatic opening until unlocked. */
function lock (name) {
  const entry = getEntry(name)
  const k = unlocked.get(entry.id)
  if (k) { k.fill(0); unlocked.delete(entry.id) }
  if (entry.key_source !== 'passphrase') updateEntry(name, { locked: true })
  return summary(getEntry(name))
}

/**
 * Destroy = crypto-shred. The DEK is deleted FIRST and confirmed gone before anything else is
 * touched: if the keystore refuses, we stop with the ciphertext intact rather than report a
 * shred that did not happen. Returns non-identifying counts for the audit event.
 */
function destroy (name) {
  const entry = getEntry(name)
  const { files, bytes } = sizeOf(entry)
  if (entry.key_source === 'passphrase') {
    try { fs.unlinkSync(passFile(entry)) } catch (e) { if (e.code !== 'ENOENT') throw e }
    if (fs.existsSync(passFile(entry))) throw new VaultError('shred_failed', `could not delete the key for vault "${name}" — nothing was removed`)
  } else {
    const backend = nodeVault.backends[entry.backend]
    if (backend) {
      backend.del(keyAccount(entry))
      const still = backend.get(keyAccount(entry))
      if (still && still.length) throw new VaultError('shred_failed', `the ${entry.backend} keystore still holds the key for vault "${name}" — nothing was removed`)
    }
  }
  const k = unlocked.get(entry.id)
  if (k) { k.fill(0); unlocked.delete(entry.id) }
  fs.rmSync(vaultPath(entry), { recursive: true, force: true })
  const r = readRegistry()
  delete r.vaults[name]
  writeRegistry(r)
  return { vault: name, vault_id: entry.id, files, bytes }
}

function sizeOf (entry) {
  const objs = Object.values(readManifest(entry).objects)
  return { files: objs.length, bytes: objs.reduce((a, o) => a + (o.size || 0), 0) }
}

function isLocked (entry) {
  return !!entry.locked || (entry.key_source === 'passphrase' && !unlocked.has(entry.id))
}

/** What `list` and the heartbeat show. Never contents, never object names. */
function summary (entry) {
  const { files, bytes } = sizeOf(entry)
  return {
    name: entry.name,
    id: entry.id,
    encrypted: true,
    bloq_id: entry.bloq_id,
    node_id: entry.node_id,
    key_source: entry.key_source,
    locked: isLocked(entry),
    phi: !!entry.phi,
    migrated: !!entry.migrated,
    files,
    bytes,
    created_at: entry.created_at,
    last_write_at: entry.last_write_at,
    escrow: entry.escrow ? entry.escrow.status : null,
  }
}

function listVaults () {
  return Object.values(readRegistry().vaults).map(summary).sort((a, b) => a.name.localeCompare(b.name))
}

// ─── Partition: which vault may a task open ──────────────────────────────────

/**
 * THE PARTITION RULE. A task may open a vault only when:
 *   - the vault is bound to the task's bloq (both unbound counts as a match — a bloq-less task
 *     never sees a bloq's vault, and a bloq task never sees an unbound one);
 *   - the vault is bound to this node, or unbound to any node;
 *   - it is not a migration vault (those hold pre-vault data of unknown bloq — humans only).
 * config.bloq_id is in the task's HMAC-signed config, so a script cannot change which it gets.
 */
function canOpen (entry, task, nodeId = null) {
  if (!entry) return { ok: false, reason: 'no such vault' }
  if (entry.migrated) return { ok: false, reason: `vault "${entry.name}" holds migrated data of unknown bloq — tasks cannot open it` }
  const taskBloq = normBloq(task && task.config && task.config.bloq_id)
  if (normBloq(entry.bloq_id) !== taskBloq) {
    return { ok: false, reason: `vault "${entry.name}" is bound to ${entry.bloq_id ? `bloq ${entry.bloq_id}` : 'no bloq'}, and this task is for ${taskBloq ? `bloq ${taskBloq}` : 'no bloq'}` }
  }
  if (entry.node_id && nodeId != null && String(nodeId) !== entry.node_id) {
    return { ok: false, reason: `vault "${entry.name}" is bound to node ${entry.node_id}, not this node (${nodeId})` }
  }
  return { ok: true }
}

function autoName (task) {
  const b = normBloq(task && task.config && task.config.bloq_id)
  return b ? `phi-bloq-${b.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 50)}` : 'phi-unbound'
}

/**
 * The vault a task writes into, or null for a non-PHI task that named none. A PHI task with no
 * vault for its bloq gets one created (keychain-keyed, so it works unattended) — no flag needed.
 * @returns {{ entry: object, created: boolean, dek: Buffer|null }|null}
 */
function resolveForTask (task, { nodeId = null, phi = false } = {}) {
  const cfg = (task && task.config) || {}
  const reg = readRegistry()
  if (cfg.vault) {
    const entry = reg.vaults[cfg.vault]
    if (!entry) throw new VaultError('not_found', `task names vault "${cfg.vault}", which does not exist on this node`)
    const ok = canOpen(entry, task, nodeId)
    if (!ok.ok) throw new VaultError('partition', `vault_partition_denied: ${ok.reason}`)
    return { entry, created: false, dek: null }
  }
  if (!phi) return null
  const candidates = Object.values(reg.vaults).filter(e => e.phi && canOpen(e, task, nodeId).ok)
  const preferred = candidates.find(e => e.name === autoName(task)) || candidates.sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
  if (preferred) return { entry: preferred, created: false, dek: null }
  let name = autoName(task)
  if (reg.vaults[name]) name = `${name}-${crypto.randomBytes(3).toString('hex')}` // taken by a vault this task may not open
  const { entry, dek } = createVault({ name, bloqId: cfg.bloq_id, nodeId, phi: true })
  return { entry, created: true, dek }
}

// ─── Objects: streaming AES-256-GCM ──────────────────────────────────────────

function objPath (entry, id) { return path.join(vaultPath(entry), 'objects', `${id}.bin`) }
function keyPath (entry, id) { return path.join(vaultPath(entry), 'keys', `${id}.key`) }
function chunkAad (entry, id, i, final) { return Buffer.from(`iris-vault|${entry.id}|${id}|${i}|${final ? 1 : 0}`) }
function chunkNonce (base, i) { const n = Buffer.alloc(12); base.copy(n, 0); n.writeUInt32BE(i, 8); return n }

async function encryptStream (entry, id, fek, readChunk, out) {
  const base = crypto.randomBytes(8)
  await out.write(Buffer.concat([MAGIC, base]))
  let i = 0
  let cur = await readChunk()
  for (;;) {
    const next = cur.length === CHUNK ? await readChunk() : Buffer.alloc(0)
    const final = next.length === 0
    const c = crypto.createCipheriv('aes-256-gcm', fek, chunkNonce(base, i), { authTagLength: TAG_LEN })
    c.setAAD(chunkAad(entry, id, i, final))
    const ct = Buffer.concat([c.update(cur), c.final()])
    const len = Buffer.alloc(4); len.writeUInt32BE(ct.length, 0)
    await out.write(Buffer.concat([len, ct, c.getAuthTag()]))
    if (final) break
    cur = next
    i++
  }
}

/** Decrypt an object chunk by chunk, handing each plaintext chunk to `sink`. Throws on any tamper. */
async function decryptStream (entry, id, sink) {
  const rec = readJson(keyPath(entry, id), null)
  if (!rec) throw new VaultError('shredded', `object ${id} has no key (shredded)`)
  const meta = openRecord(dekFor(entry), rec, `iris-vault-key|${entry.id}|${id}`)
  const fek = Buffer.from(meta.fek, 'base64')
  const fh = await fsp.open(objPath(entry, id), 'r')
  try {
    const head = Buffer.alloc(12)
    await fh.read(head, 0, 12, 0)
    if (!head.subarray(0, 4).equals(MAGIC)) throw new VaultError('corrupt', `object ${id} is not a vault object`)
    const base = head.subarray(4, 12)
    const total = (await fh.stat()).size
    let pos = 12
    let i = 0
    for (;;) {
      const lenBuf = Buffer.alloc(4)
      const { bytesRead } = await fh.read(lenBuf, 0, 4, pos)
      if (bytesRead < 4) throw new VaultError('truncated', `object ${id} ends before its final chunk`)
      const len = lenBuf.readUInt32BE(0)
      if (len > CHUNK + 64) throw new VaultError('corrupt', `object ${id} has an oversized chunk`)
      const body = Buffer.alloc(len + TAG_LEN)
      const r = await fh.read(body, 0, len + TAG_LEN, pos + 4)
      if (r.bytesRead < len + TAG_LEN) throw new VaultError('truncated', `object ${id} is truncated`)
      pos += 4 + len + TAG_LEN
      // FINAL is derived from where the file ends, and is inside each chunk's AAD: cut the file at
      // any chunk boundary and the new last chunk fails authentication.
      const final = pos >= total
      const d = crypto.createDecipheriv('aes-256-gcm', fek, chunkNonce(base, i), { authTagLength: TAG_LEN })
      d.setAAD(chunkAad(entry, id, i, final))
      d.setAuthTag(body.subarray(len))
      await sink(Buffer.concat([d.update(body.subarray(0, len)), d.final()]))
      if (final) break
      i++
    }
  } finally { await fh.close() }
  return meta
}

async function writeObject (entry, readChunk, { name = null, kind = 'file', tag = null, taskId = null } = {}, size) {
  const dek = dekFor(entry) // fails BEFORE anything is written if the vault is locked
  const id = crypto.randomUUID()
  const fek = crypto.randomBytes(32)
  const tmp = objPath(entry, id) + '.tmp'
  mkdir700(path.dirname(tmp))
  const out = await fsp.open(tmp, 'w', 0o600)
  try { await encryptStream(entry, id, fek, readChunk, out) } finally { await out.close() }
  // Key file BEFORE the rename: an object never exists without the key that opens it.
  writeJsonAtomic(keyPath(entry, id), sealRecord(dek, { fek: fek.toString('base64'), name, kind, task_id: taskId, tag }, `iris-vault-key|${entry.id}|${id}`))
  fek.fill(0)
  fs.renameSync(tmp, objPath(entry, id))
  const m = readManifest(entry)
  const now = new Date().toISOString()
  m.objects[id] = { created_at: now, size, kind, tag: tag || null }
  writeManifest(entry, m)
  updateEntry(entry.name, { last_write_at: now })
  return { fileId: id, size }
}

async function putBuffer (entry, buf, meta = {}) {
  let off = 0
  return writeObject(entry, async () => { const c = buf.subarray(off, off + CHUNK); off += c.length; return c }, meta, buf.length)
}

async function putFile (entry, src, meta = {}) {
  const st = fs.statSync(src)
  const fh = await fsp.open(src, 'r')
  try {
    return await writeObject(entry, async () => {
      const b = Buffer.alloc(CHUNK)
      let n = 0
      while (n < CHUNK) { const r = await fh.read(b, n, CHUNK - n, null); if (!r.bytesRead) break; n += r.bytesRead }
      return b.subarray(0, n)
    }, meta, st.size)
  } finally { await fh.close() }
}

async function readObject (entry, id) {
  const parts = []
  const meta = await decryptStream(entry, id, async (c) => { parts.push(c) })
  return { meta, data: Buffer.concat(parts) }
}

async function exportObject (entry, id, outPath) {
  mkdir700(path.dirname(outPath))
  const out = await fsp.open(outPath, 'w', 0o600)
  try { return await decryptStream(entry, id, async (c) => { await out.write(c) }) } finally { await out.close() }
}

async function sha256File (file) {
  const h = crypto.createHash('sha256')
  const fh = await fsp.open(file, 'r')
  try { const b = Buffer.alloc(CHUNK); let r; while ((r = await fh.read(b, 0, CHUNK, null)).bytesRead) h.update(b.subarray(0, r.bytesRead)) } finally { await fh.close() }
  return h.digest('hex')
}

async function sha256Object (entry, id) {
  const h = crypto.createHash('sha256')
  await decryptStream(entry, id, async (c) => { h.update(c) })
  return h.digest('hex')
}

/**
 * Crypto-shred one object: the key file goes FIRST (that alone makes the ciphertext useless),
 * then the ciphertext, then the manifest row. Needs no key, so it works on a locked vault.
 */
function shredObject (entry, id) {
  const m = readManifest(entry)
  const size = (m.objects[id] && m.objects[id].size) || 0
  try { fs.unlinkSync(keyPath(entry, id)) } catch (e) { if (e.code !== 'ENOENT') throw e }
  try { fs.unlinkSync(objPath(entry, id)) } catch (e) { if (e.code !== 'ENOENT') throw e }
  delete m.objects[id]
  writeManifest(entry, m)
  return size
}

function findByTag (entry, tag) {
  return Object.entries(readManifest(entry).objects).filter(([, o]) => o.tag === tag)
    .sort((a, b) => a[1].created_at.localeCompare(b[1].created_at)).map(([id]) => id)
}

/** Object list WITH names — needs the key, so only for a human on the node (`vaults files`). */
async function listFiles (name) {
  const entry = getEntry(name)
  const dek = dekFor(entry)
  return Object.entries(readManifest(entry).objects).map(([id, o]) => {
    let meta = {}
    try { meta = openRecord(dek, readJson(keyPath(entry, id), null), `iris-vault-key|${entry.id}|${id}`) } catch { /* shredded mid-list */ }
    return { file_id: id, name: meta.name || null, kind: o.kind, task_id: meta.task_id || null, size: o.size, created_at: o.created_at }
  })
}

// ─── Absorbing plaintext: encrypt → verify → delete ──────────────────────────

function walkFiles (dir, rel = '', out = []) {
  let ents = []
  try { ents = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }) } catch { return out }
  for (const d of ents) {
    const r = path.join(rel, d.name)
    if (d.isSymbolicLink()) continue // node_modules links etc. — not ours, never followed
    if (d.isDirectory()) walkFiles(dir, r, out)
    else if (d.isFile()) out.push(r)
  }
  return out
}

/**
 * Move every regular file under `dir` into the vault. SAFETY ORDER, per file: encrypt to the
 * vault, decrypt it back and compare SHA-256 with the source, and only then delete the plaintext.
 * A file that fails any step stays where it was (listed in `failed`) — a full disk or a locked
 * vault costs us the encryption of that file, never the file.
 */
async function absorbDir (entry, dir, { taskId = null, kind = 'task-output', tagFor = null, removeDir = true } = {}) {
  const res = { absorbed: 0, bytes: 0, failed: [] }
  for (const rel of walkFiles(dir)) {
    const src = path.join(dir, rel)
    try {
      const before = await sha256File(src)
      const tag = (tagFor && tagFor(rel)) || (taskId ? `task:${taskId}` : null)
      const { fileId, size } = await putFile(entry, src, { name: rel, kind, tag, taskId })
      if (await sha256Object(entry, fileId) !== before) { shredObject(entry, fileId); throw new Error('verify mismatch') }
      fs.unlinkSync(src)
      res.absorbed++
      res.bytes += size
    } catch (e) {
      res.failed.push({ path: rel, error: String(e.message || e).slice(0, 200) })
    }
  }
  if (removeDir && res.failed.length === 0) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* empty dirs + symlinks only */ }
  }
  return res
}

// ─── Retention ───────────────────────────────────────────────────────────────

function retentionDays () {
  const n = parseInt(process.env.HIVE_PHI_RETENTION_DAYS, 10)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS
}

/**
 * Crypto-shred PHI working copies older than the retention window (default 30 days — the period
 * the owner approved for working copies of patient data). Ages by each object's created_at, so a
 * vault that is written daily still loses last month's screenshots. Works on locked vaults.
 * Returns one non-identifying row per vault that lost anything: { vault, vault_id, files, bytes }.
 */
function sweepRetention ({ days = retentionDays(), now = Date.now() } = {}) {
  const cutoff = now - days * 86400000
  const out = []
  for (const entry of Object.values(readRegistry().vaults)) {
    if (!entry.phi) continue
    let files = 0
    let bytes = 0
    for (const [id, o] of Object.entries(readManifest(entry).objects)) {
      const t = Date.parse(o.created_at)
      if (Number.isFinite(t) && t < cutoff) { bytes += shredObject(entry, id); files++ }
    }
    if (files) out.push({ vault: entry.name, vault_id: entry.id, files, bytes, retention_days: days })
  }
  return out
}

/** For the heartbeat: what `iris hive vaults list` shows for a remote node. */
function heartbeatReport () {
  try { return listVaults().map(v => ({ name: v.name, bloq_id: v.bloq_id, locked: v.locked, key_source: v.key_source, phi: v.phi, files: v.files, bytes: v.bytes, last_write_at: v.last_write_at, escrow: v.escrow })) } catch { return undefined }
}

function _forgetUnlocked () { unlocked.clear() }

module.exports = {
  VaultError,
  rootDir,
  createVault,
  escrowVault,
  unlock,
  lock,
  destroy,
  listVaults,
  listFiles,
  getEntry,
  summary,
  isLocked,
  canOpen,
  resolveForTask,
  dekFor,
  putBuffer,
  putFile,
  readObject,
  exportObject,
  shredObject,
  findByTag,
  absorbDir,
  sweepRetention,
  retentionDays,
  heartbeatReport,
  _forgetUnlocked,
  _paths: { vaultPath, objPath, keyPath, manifestPath, registryPath },
}
