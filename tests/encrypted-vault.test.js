'use strict'

/**
 * Encrypted, partitioned Hive vaults — lib/encrypted-vault.js, lib/phi-vault.js,
 * lib/disk-encryption.js, and the cloud-client / phi-task hooks.
 *
 * Only the FILE key backend is exercised (IRIS_VAULT_BACKEND=file): Keychain, libsecret and DPAPI
 * need a real desktop session and cannot run in CI. They share the same get/set/del contract.
 */

const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-ev-'))
process.env.IRIS_VAULT_BACKEND = 'file'

const ev = require('../lib/encrypted-vault')
const phiVault = require('../lib/phi-vault')
const disk = require('../lib/disk-encryption')
const { openEnvelopeBuffers, X25519_SPKI_PREFIX, X25519_PKCS8_PREFIX } = require('../lib/envelope')
const { phiSafeResult } = require('../lib/phi-task')

let n = 0
beforeEach(() => {
  n++
  process.env.IRIS_VAULT_DIR = path.join(tmp, `keys-${n}`)
  process.env.IRIS_VAULTS_DIR = path.join(tmp, `vaults-${n}`)
  ev._forgetUnlocked()
})

const ENCRYPTED = () => ({ encrypted: true, method: 'luks' })
const task = (bloq, extra = {}) => ({ id: `t-${crypto.randomUUID()}`, config: { phi: true, ...(bloq != null ? { bloq_id: bloq } : {}), ...extra } })
const allFiles = (dir) => fs.readdirSync(dir, { recursive: true }).map(f => path.join(dir, f)).filter(f => fs.statSync(f).isFile())

// ─── outputs encrypted at rest ───────────────────────────────────────────────

test('an object is unreadable on disk and round-trips through the vault, including multi-chunk files', async () => {
  const { entry } = ev.createVault({ name: 'clinic', bloqId: 7, phi: true })
  const secret = 'MRN 0042 Jane Doe DOB 1970-01-01'
  const { fileId } = await ev.putBuffer(entry, Buffer.from(secret), { name: 'jane-doe.png', taskId: 't1', tag: 'task:t1' })

  for (const f of allFiles(ev._paths.vaultPath(entry))) {
    const raw = fs.readFileSync(f)
    assert.ok(!raw.includes(Buffer.from('Jane Doe')), `plaintext found in ${f}`)
    assert.ok(!raw.includes(Buffer.from('jane-doe')), `the object NAME leaked into ${f}`)
  }
  assert.equal((await ev.readObject(entry, fileId)).data.toString(), secret)

  const big = crypto.randomBytes(3 * 1024 * 1024 + 123) // 4 chunks, last one short
  const src = path.join(tmp, `big-${n}.bin`)
  fs.writeFileSync(src, big)
  const r = await ev.putFile(entry, src, { name: 'video.webm' })
  assert.ok((await ev.readObject(entry, r.fileId)).data.equals(big))

  const exact = Buffer.alloc(1024 * 1024, 7) // exactly one chunk
  const r2 = await ev.putBuffer(entry, exact)
  assert.ok((await ev.readObject(entry, r2.fileId)).data.equals(exact))
  const empty = await ev.putBuffer(entry, Buffer.alloc(0))
  assert.equal((await ev.readObject(entry, empty.fileId)).data.length, 0)
})

test('tampering, truncation at a chunk boundary, and chunk swapping are all detected', async () => {
  const { entry } = ev.createVault({ name: 'tamper' })
  const data = crypto.randomBytes(2 * 1024 * 1024 + 10)
  const { fileId } = await ev.putBuffer(entry, data)
  const p = ev._paths.objPath(entry, fileId)
  const orig = fs.readFileSync(p)

  const flipped = Buffer.from(orig); flipped[100] ^= 1
  fs.writeFileSync(p, flipped)
  await assert.rejects(ev.readObject(entry, fileId))

  const chunk = 4 + 1024 * 1024 + 16
  fs.writeFileSync(p, orig.subarray(0, 12 + 2 * chunk)) // drop the final chunk exactly
  await assert.rejects(ev.readObject(entry, fileId))

  const swapped = Buffer.concat([orig.subarray(0, 12), orig.subarray(12 + chunk, 12 + 2 * chunk), orig.subarray(12, 12 + chunk), orig.subarray(12 + 2 * chunk)])
  fs.writeFileSync(p, swapped)
  await assert.rejects(ev.readObject(entry, fileId))

  fs.writeFileSync(p, orig)
  assert.ok((await ev.readObject(entry, fileId)).data.equals(data))
})

test('list shows names, bloq, lock state and size — never contents', async () => {
  const { entry } = ev.createVault({ name: 'listme', bloqId: '12', nodeId: 'node-a' })
  await ev.putBuffer(entry, Buffer.from('patient text'), { name: 'secret-name.txt' })
  const [v] = ev.listVaults()
  assert.deepEqual([v.name, v.bloq_id, v.node_id, v.locked, v.files, v.bytes, v.encrypted], ['listme', '12', 'node-a', false, 1, 12, true])
  assert.ok(!JSON.stringify(ev.listVaults()).includes('secret-name'))
  assert.ok(!JSON.stringify(ev.heartbeatReport()).includes('secret-name'))
})

// ─── partition isolation ─────────────────────────────────────────────────────

test('PARTITION: a task for bloq Y cannot open bloq X\'s vault, by name or by auto-selection', async () => {
  const { entry: x } = ev.createVault({ name: 'bloq-x', bloqId: 'X', nodeId: 'n1', phi: true })
  assert.equal(ev.canOpen(x, task('X'), 'n1').ok, true)
  assert.equal(ev.canOpen(x, task('Y'), 'n1').ok, false)
  assert.equal(ev.canOpen(x, task(null), 'n1').ok, false, 'a bloq-less task must not see a bloq vault')
  assert.equal(ev.canOpen(x, task('X'), 'n2').ok, false, 'bound to another node')

  assert.throws(() => ev.resolveForTask(task('Y', { vault: 'bloq-x' }), { nodeId: 'n1', phi: true }), (e) => e.code === 'partition' && /vault_partition_denied/.test(e.message))

  const y = ev.resolveForTask(task('Y'), { nodeId: 'n1', phi: true })
  assert.notEqual(y.entry.id, x.id, 'bloq Y got its OWN vault')
  assert.equal(y.created, true)
  assert.equal(y.entry.bloq_id, 'Y')
  assert.notEqual(ev.dekFor(y.entry).toString('hex'), ev.dekFor(x).toString('hex'), 'each vault has its own key')

  // Y's key cannot open X's objects.
  const { fileId } = await ev.putBuffer(x, Buffer.from('x data'))
  const fakeX = { ...y.entry, id: x.id, name: x.name } // X's files, Y's key
  fs.copyFileSync(ev._paths.keyPath(x, fileId), path.join(ev._paths.vaultPath(y.entry), 'keys', `${fileId}.key`))
  fs.copyFileSync(ev._paths.objPath(x, fileId), path.join(ev._paths.vaultPath(y.entry), 'objects', `${fileId}.bin`))
  await assert.rejects(ev.readObject({ ...fakeX, id: y.entry.id }, fileId))

  const again = ev.resolveForTask(task('X'), { nodeId: 'n1', phi: true })
  assert.equal(again.entry.id, x.id, 'bloq X keeps using its vault')
})

test('a non-PHI task without config.vault gets no vault; a migration vault is never opened by a task', () => {
  assert.equal(ev.resolveForTask({ config: { bloq_id: 1 } }, { phi: false }), null)
  const { entry } = ev.createVault({ name: 'phi-migrated', phi: true, migrated: true })
  assert.equal(ev.canOpen(entry, task(null)).ok, false)
  const r = ev.resolveForTask(task(null), { phi: true })
  assert.notEqual(r.entry.id, entry.id)
})

// ─── crypto-shred ────────────────────────────────────────────────────────────

test('CRYPTO-SHRED: destroy deletes the key; a saved copy of every vault file is then unrecoverable', async () => {
  const { entry } = ev.createVault({ name: 'doomed', bloqId: 3 })
  const { fileId } = await ev.putBuffer(entry, Buffer.from('patient data'))
  const backup = path.join(tmp, `backup-${n}`)
  fs.cpSync(ev._paths.vaultPath(entry), backup, { recursive: true }) // an attacker's copy

  const r = ev.destroy('doomed')
  assert.deepEqual([r.files, r.bytes], [1, 12])
  assert.equal(fs.existsSync(ev._paths.vaultPath(entry)), false)
  assert.equal(ev.listVaults().length, 0)
  assert.equal(require('../lib/node-vault').backends.file.get(`vault-dek:${entry.id}`), null, 'the DEK is gone from the keystore')

  // Restore the ciphertext copy in place: without the DEK it cannot be opened.
  fs.cpSync(backup, ev._paths.vaultPath(entry), { recursive: true })
  await assert.rejects(ev.readObject({ ...entry, locked: false }, fileId), /no key/)
})

test('CRYPTO-SHRED of one object: its key file goes, so even a kept ciphertext copy is dead', async () => {
  const { entry } = ev.createVault({ name: 'obj' })
  const { fileId } = await ev.putBuffer(entry, Buffer.from('old screenshot'))
  const keep = fs.readFileSync(ev._paths.objPath(entry, fileId))
  ev.shredObject(entry, fileId)
  fs.writeFileSync(ev._paths.objPath(entry, fileId), keep)
  await assert.rejects(ev.readObject(entry, fileId), /shredded/)
})

test('destroy refuses — and removes nothing — when the keystore will not delete the key', async () => {
  const { entry } = ev.createVault({ name: 'sticky' })
  const nv = require('../lib/node-vault')
  const del = nv.backends.file.del
  nv.backends.file.del = () => false
  try {
    assert.throws(() => ev.destroy('sticky'), (e) => e.code === 'shred_failed')
    assert.equal(fs.existsSync(ev._paths.vaultPath(entry)), true)
  } finally { nv.backends.file.del = del }
})

// ─── retention ───────────────────────────────────────────────────────────────

test('RETENTION: only objects older than the window are shredded; locked vaults are swept too', async () => {
  const { entry } = ev.createVault({ name: 'ret', phi: true })
  const now = Date.parse('2026-10-05T00:00:00Z')
  const ids = []
  for (const daysOld of [31, 30.01, 29.99, 1]) {
    const { fileId } = await ev.putBuffer(entry, Buffer.alloc(10))
    const m = JSON.parse(fs.readFileSync(ev._paths.manifestPath(entry)))
    m.objects[fileId].created_at = new Date(now - daysOld * 86400000).toISOString()
    fs.writeFileSync(ev._paths.manifestPath(entry), JSON.stringify(m))
    ids.push(fileId)
  }
  const { entry: other } = ev.createVault({ name: 'not-phi', phi: false })
  await ev.putBuffer(other, Buffer.alloc(5))

  ev.lock('ret') // a locked vault: the sweep needs no key
  const rows = ev.sweepRetention({ days: 30, now })
  assert.deepEqual(rows, [{ vault: 'ret', vault_id: entry.id, files: 2, bytes: 20, retention_days: 30 }])
  const left = Object.keys(JSON.parse(fs.readFileSync(ev._paths.manifestPath(entry))).objects)
  assert.deepEqual(left.sort(), ids.slice(2).sort())
  assert.equal(fs.existsSync(ev._paths.keyPath(entry, ids[0])), false)
  assert.equal(ev.listVaults().find(v => v.name === 'not-phi').files, 1)
})

test('HIVE_PHI_RETENTION_DAYS configures the window; default 30', () => {
  delete process.env.HIVE_PHI_RETENTION_DAYS
  assert.equal(ev.retentionDays(), 30)
  process.env.HIVE_PHI_RETENTION_DAYS = '7'
  assert.equal(ev.retentionDays(), 7)
  process.env.HIVE_PHI_RETENTION_DAYS = 'nonsense'
  assert.equal(ev.retentionDays(), 30)
  delete process.env.HIVE_PHI_RETENTION_DAYS
})

test('retentionSweep posts a counts-only audit event', async () => {
  const { entry } = ev.createVault({ name: 'aud', phi: true })
  await ev.putBuffer(entry, Buffer.from('x'), { name: 'patient-name.png' })
  const posts = []
  await phiVault.retentionSweep({ cloud: { post: async (p, b) => { posts.push([p, b]) } }, days: 1, now: Date.now() + 2 * 86400000 })
  assert.equal(posts[0][0], '/api/v6/node-agent/vaults/audit')
  assert.deepEqual(posts[0][1], { event: 'retention_sweep', vaults: [{ vault: 'aud', vault_id: entry.id, files: 1, bytes: 1, retention_days: 1 }] })
})

// ─── keys: passphrase + lock ─────────────────────────────────────────────────

test('a passphrase vault is locked after a restart until a human unlocks it', async () => {
  const { entry } = ev.createVault({ name: 'pp', passphrase: 'correct horse battery' })
  const { fileId } = await ev.putBuffer(entry, Buffer.from('hi'))
  ev._forgetUnlocked() // daemon restart
  assert.equal(ev.listVaults()[0].locked, true)
  assert.throws(() => ev.dekFor(ev.getEntry('pp')), (e) => e.code === 'locked')
  assert.throws(() => ev.unlock('pp', 'wrong passphrase'), (e) => e.code === 'bad_passphrase')
  ev.unlock('pp', 'correct horse battery')
  assert.equal((await ev.readObject(ev.getEntry('pp'), fileId)).data.toString(), 'hi')
  assert.equal(require('../lib/node-vault').backends.file.get(`vault-dek:${entry.id}`), null, 'no keystore entry for a passphrase vault')
})

test('lock on a keychain vault blocks the PHI gate until unlock', async () => {
  ev.createVault({ name: 'phi-bloq-5', bloqId: 5, phi: true })
  await ev.escrowVault('phi-bloq-5', { fetchTargets: async () => ({ policy: 'forbidden', targets: [] }), postWraps: async () => {} })
  ev.lock('phi-bloq-5')
  const g = await phiVault.gate(task(5), { diskReport: ENCRYPTED })
  assert.equal(g.ok, false)
  assert.match(g.reason, /^phi_vault_locked:/)
  ev.unlock('phi-bloq-5')
  assert.equal((await phiVault.gate(task(5), { diskReport: ENCRYPTED })).ok, true)
})

// ─── encrypt → verify → delete ───────────────────────────────────────────────

test('absorbDir seals every file, verifies, then deletes the plaintext; a failure leaves it in place', async () => {
  const { entry } = ev.createVault({ name: 'abs', phi: true })
  const ws = path.join(tmp, `ws-${n}`)
  fs.mkdirSync(path.join(ws, 'test-results'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'phi-result.json'), '{"stdout":"Jane Doe"}')
  fs.writeFileSync(path.join(ws, 'test-results', 'shot.png'), crypto.randomBytes(2000))
  fs.symlinkSync(os.tmpdir(), path.join(ws, 'node_modules'))
  const r = await ev.absorbDir(entry, ws, { taskId: 't9' })
  assert.deepEqual([r.absorbed, r.failed.length], [2, 0])
  assert.equal(fs.existsSync(ws), false)
  const files = await ev.listFiles('abs')
  assert.deepEqual(files.map(f => f.name).sort(), ['phi-result.json', path.join('test-results', 'shot.png')])
  assert.ok(fs.existsSync(os.tmpdir()), 'the symlink target was not followed or removed')

  const ws2 = path.join(tmp, `ws2-${n}`)
  fs.mkdirSync(ws2)
  fs.writeFileSync(path.join(ws2, 'keep.txt'), 'must survive')
  ev.lock('abs')
  const r2 = await ev.absorbDir(ev.getEntry('abs'), ws2, { taskId: 't10' })
  assert.equal(r2.failed.length, 1)
  assert.equal(fs.readFileSync(path.join(ws2, 'keep.txt'), 'utf8'), 'must survive')
})

test('migratePlain seals pre-vault PHI task dirs into an untouchable vault, skipping running tasks', async () => {
  const tasksDir = path.join(tmp, `tasks-${n}`)
  for (const id of ['old1', 'running1', 'nonphi']) fs.mkdirSync(path.join(tasksDir, id), { recursive: true })
  fs.writeFileSync(path.join(tasksDir, 'old1', 'phi-result.json'), '{"output":"patient"}')
  fs.writeFileSync(path.join(tasksDir, 'old1', 'shot.png'), 'png')
  fs.writeFileSync(path.join(tasksDir, 'running1', 'phi-result.json'), '{}')
  fs.writeFileSync(path.join(tasksDir, 'nonphi', 'out.txt'), 'x')
  const r = await phiVault.migratePlain(tasksDir, { running: (id) => id === 'running1' })
  assert.deepEqual([r.tasks, r.absorbed, r.failed], [1, 2, 0])
  assert.equal(fs.existsSync(path.join(tasksDir, 'old1')), false)
  assert.equal(fs.existsSync(path.join(tasksDir, 'running1', 'phi-result.json')), true)
  assert.equal(fs.existsSync(path.join(tasksDir, 'nonphi', 'out.txt')), true)
  const v = ev.getEntry('phi-migrated')
  assert.equal(v.migrated, true)
  const res = (await ev.listFiles('phi-migrated')).find(f => f.name === 'phi-result.json')
  assert.equal((await ev.readObject(v, res.file_id)).data.toString(), '{"output":"patient"}')
})

// ─── escrow ──────────────────────────────────────────────────────────────────

function x25519 () {
  const kp = crypto.generateKeyPairSync('x25519')
  return {
    pub: kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(X25519_SPKI_PREFIX.length),
    sec: kp.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(X25519_PKCS8_PREFIX.length),
  }
}

test('ESCROW required: the DEK is wrapped (ihw.v1) to each escrow holder and the holder can unwrap it', async () => {
  const holder = x25519()
  const posted = []
  const { entry, dek } = ev.createVault({ name: 'esc', bloqId: 9, phi: true })
  const esc = await ev.escrowVault('esc', {
    dek,
    fetchTargets: async (q) => { assert.equal(q.vault_id, entry.id); return { policy: 'required', targets: [{ type: 'escrow', id: 'escrow:compliance', public_key: holder.pub.toString('base64') }] } },
    postWraps: async (id, body) => { posted.push([id, body]) },
  })
  assert.equal(esc.status, 'escrowed')
  const w = posted[0][1].wraps[0]
  assert.equal(posted[0][0], entry.id)
  const { dek: unwrapped } = openEnvelopeBuffers({
    ephPublic: Buffer.from(w.eph_public, 'base64'), wrapNonce: Buffer.from(w.nonce, 'base64'), wrappedDek: Buffer.from(w.wrapped_dek, 'base64'), wrapTag: Buffer.from(w.tag, 'base64'),
    recipientSecret: holder.sec, recipientPublic: holder.pub, envelopeId: entry.id, targetId: 'escrow:compliance',
  })
  assert.ok(unwrapped.equals(ev.dekFor(entry)))
  // Bound to THIS vault: the same wrap does not open as another vault's.
  assert.throws(() => openEnvelopeBuffers({
    ephPublic: Buffer.from(w.eph_public, 'base64'), wrapNonce: Buffer.from(w.nonce, 'base64'), wrappedDek: Buffer.from(w.wrapped_dek, 'base64'), wrapTag: Buffer.from(w.tag, 'base64'),
    recipientSecret: holder.sec, recipientPublic: holder.pub, envelopeId: crypto.randomUUID(), targetId: 'escrow:compliance',
  }))
})

test('ESCROW forbidden: nothing is wrapped; a failed escrow under required keeps the PHI gate CLOSED', async () => {
  const posts = []
  ev.createVault({ name: 'forb' })
  const s = await ev.escrowVault('forb', { fetchTargets: async () => ({ policy: 'forbidden', targets: [{ type: 'escrow', id: 'escrow:x', public_key: x25519().pub.toString('base64') }] }), postWraps: async (...a) => posts.push(a) })
  assert.equal(s.status, 'not_required')
  assert.equal(posts.length, 0)

  const cloud = { get: async () => { const e = new Error('escrow policy is `required` but no valid escrow public key is configured'); e.statusCode = 409; throw e }, post: async () => {} }
  const g = await phiVault.gate(task(44), { diskReport: ENCRYPTED, cloud })
  assert.equal(g.ok, false)
  assert.match(g.reason, /^phi_vault_escrow_pending:.*no valid escrow public key/)
  assert.equal(ev.getEntry('phi-bloq-44').escrow.status, 'pending')
})

// ─── disk encryption ─────────────────────────────────────────────────────────

test('DISK: a PHI task is refused unless full-disk encryption is confirmed ON, with per-OS how-to', async () => {
  for (const [report, platform, how] of [
    [{ encrypted: false, method: 'filevault' }, 'darwin', /FileVault.*fdesetup/],
    [{ encrypted: null }, 'win32', /BitLocker.*manage-bde/],
    [{ encrypted: false }, 'linux', /LUKS.*cryptsetup/],
  ]) {
    const g = await phiVault.gate(task(1, { phi_requires_disk_encryption: true }), { diskReport: () => report, platform })
    assert.equal(g.ok, false)
    assert.match(g.reason, /^phi_requires_disk_encryption:/)
    assert.match(g.reason, how)
  }
  assert.equal(ev.listVaults().length, 0, 'no vault is created for a refused task')
})

test('DISK (rollout): when the server does not require it, an unencrypted node runs the PHI task and still vaults it', async () => {
  // The server's rollout answer for escrow while HIVE_VAULT_ESCROW_ENFORCE is off: permitted, no targets.
  const cloud = { get: async () => ({ policy: 'permitted', reason: 'escrow_not_configured', targets: [] }), post: async () => ({ success: true }) }
  const g = await phiVault.gate(task(2), { diskReport: () => ({ encrypted: false, method: 'filevault' }), platform: 'darwin', cloud })
  assert.equal(g.ok, true)
  assert.ok(g.entry, 'the bloq vault is still opened, so outputs are encrypted at rest')
})

test('disk probes parse FileVault, BitLocker and LUKS output', () => {
  assert.equal(disk.parseFdesetup('FileVault is On.\n'), true)
  assert.equal(disk.parseFdesetup('FileVault is Off.\n'), false)
  assert.equal(disk.parseFdesetup('Encryption in progress'), null)
  assert.equal(disk.parseBitLocker('On\r\n'), true)
  assert.equal(disk.parseBitLocker('Off'), false)
  assert.equal(disk.parseBitLocker('    Protection Status:    Protection On\n'), true)
  assert.equal(disk.parseLsblkAncestors('part\n'), false)
  assert.equal(disk.parseLsblkAncestors('lvm\ncrypt\npart\ndisk\n'), true)
  assert.equal(disk.parseLsblkAncestors(''), null)
  disk._resetCache()
  const r = disk.diskEncryptionReport({ probeFn: () => ({ encrypted: 'yes', method: 'x' }), force: true })
  assert.equal(r.encrypted, null, 'anything but a boolean is unknown')
})

// ─── wiring: cloud-client + phi-task ─────────────────────────────────────────

test('a PHI task result is sealed into its vault; only the vault ref goes home', async () => {
  const { CloudClient } = require('../daemon/cloud-client')
  const { entry } = ev.createVault({ name: 'res', phi: true })
  const c = new CloudClient('http://127.0.0.1:9', 'k')
  const sent = []
  c._requestWithFailover = async (m, p, b) => { sent.push(b); return {} }
  c.markPhiTask('t-res', path.join(tmp, `nowhere-${n}`))
  c.attachPhiVault('t-res', phiVault.resultSink(entry, 't-res'))
  await c.post('/api/v6/node-agent/tasks/t-res/result', { status: 'completed', output: 'Jane Doe MRN 1', exit_code: 0 })
  assert.match(sent[0].data.local_ref, new RegExp(`^vault:res/[0-9a-f-]{36}$`))
  assert.ok(!JSON.stringify(sent[0]).includes('Jane'))
  assert.equal(fs.existsSync(path.join(tmp, `nowhere-${n}`, 'phi-result.json')), false, 'no plaintext copy')
  const id = sent[0].data.local_ref.split('/')[1]
  assert.match((await ev.readObject(entry, id)).data.toString(), /Jane Doe/)
})

test('a gate refusal code (never free text) survives phiSafeResult', () => {
  const s = phiSafeResult({ status: 'failed', error: 'phi_requires_disk_encryption: … FileVault …', metadata: { phi_refusal: 'phi_requires_disk_encryption' } })
  assert.equal(s.error, 'phi_refused:phi_requires_disk_encryption')
  assert.equal(s.metadata.phi_refusal, 'phi_requires_disk_encryption')
  const t = phiSafeResult({ status: 'failed', error: 'patient Jane', metadata: { phi_refusal: 'Jane Doe' } })
  assert.equal(t.error, 'phi_task_failed: details kept on the node')
  assert.equal(t.metadata.phi_refusal, undefined)
})

test('a PHI portal checkpoint is restored from the vault and replaced, not duplicated, on absorb', async () => {
  const { entry } = ev.createVault({ name: 'ck', phi: true })
  const ws = path.join(tmp, `ckws-${n}`)
  const file = path.join(phiVault.checkpointDir(ws), 'run-1', 'checkpoint.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{"done":1}')
  await phiVault.absorbWorkspace(entry, ws, { taskId: 'a', runKey: 'run-1' })
  assert.equal(fs.existsSync(ws), false)

  const ws2 = path.join(tmp, `ckws2-${n}`)
  assert.equal(await phiVault.checkpointRestore(entry, 'run-1', ws2), true)
  assert.equal(fs.readFileSync(path.join(phiVault.checkpointDir(ws2), 'run-1', 'checkpoint.json'), 'utf8'), '{"done":1}')
  fs.writeFileSync(path.join(phiVault.checkpointDir(ws2), 'run-1', 'checkpoint.json'), '{"done":2}')
  await phiVault.absorbWorkspace(entry, ws2, { taskId: 'b', runKey: 'run-1' })
  const tagged = ev.findByTag(entry, phiVault.checkpointTag('run-1'))
  assert.equal(tagged.length, 1)
  assert.equal((await ev.readObject(entry, tagged[0])).data.toString(), '{"done":2}')
  assert.ok(!fs.readFileSync(ev._paths.manifestPath(entry), 'utf8').includes('run-1'), 'run key hashed in the plaintext manifest')
})

test('executor wiring: the PHI gate runs before any task-type branch, and the workspace is absorbed in finally', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'task-executor.js'), 'utf8')
  const gateAt = src.indexOf('phiVault.gate(task')
  const firstBranch = src.indexOf("if (task.type === 'message')")
  const finallyAt = src.indexOf('} finally {', gateAt)
  assert.ok(gateAt > 0 && gateAt < firstBranch, 'gate must precede the first task-type branch')
  assert.ok(src.indexOf('phiVault.absorbWorkspace(', finallyAt) > finallyAt, 'absorb must run in finally')
  assert.ok(src.includes("preparePortalRun(task, workspace.dir, phi ? { dir: phiVault.checkpointDir(workspace.dir) }"), 'a PHI checkpoint lives in the workspace')
})
