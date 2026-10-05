'use strict'

/**
 * node-vault.js — portal logins and TOTP seeds that live on THIS machine and nowhere else.
 *
 * WHY THIS EXISTS (#187915, GAP J "portal robots on machines we own"). `iris hive credentials
 * save-session` uploaded a Playwright storageState to /api/v1/project-credentials, where it sat
 * encrypted with the APP key and was handed back to any node at run time. For a portal that shows
 * patient data that cookie is a working credential to PHI, sitting in our cloud DB. The bar we
 * hold ourselves to is Robomotion's: the vault key never leaves the client. So:
 *
 *   - a 32-byte master key is held by the OS (macOS Keychain, libsecret, Windows DPAPI) or, when
 *     none is usable, by a 0600 file in the user's home — never in the repo, never in the cloud;
 *   - every credential is sealed with that key (AES-256-GCM) in ~/.iris/vault/vault.enc;
 *   - tasks reference a credential by NAME (`config.node_credential`); the executor opens it just
 *     before spawning the robot and puts the values into that one child's environment;
 *   - the only thing that leaves the node is the list of names (heartbeat) — see listNames().
 *
 * #187916: the TOTP seed for an MFA portal is stored here too, and the six digits are generated
 * HERE (RFC 6238) — the seed is never handed to the robot, only `iris-otp <name>`'s output.
 *
 * Synchronous on purpose: it is called once per task and from a CLI, and the OS keystores are
 * driven through short-lived child processes whose secrets travel on STDIN (never argv, which any
 * local user can read in `ps`).
 */

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const SERVICE = 'iris-node-vault'
const ACCOUNT = 'master-key'
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const REDACTED = '[redacted:node-vault]'

function vaultDir () {
  return process.env.IRIS_VAULT_DIR || path.join(os.homedir(), '.iris', 'vault')
}

function ensureDir () {
  const dir = vaultDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(dir, 0o700) } catch { /* windows: ACLs, not modes */ }
  return dir
}

function hasCommand (cmd) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' })
    return true
  } catch { return false }
}

// ─── Key backends: where the master key lives ────────────────────────────────

const backends = {
  // macOS Keychain. `security -i` reads its commands on stdin, so the key is never on argv.
  keychain: {
    available: () => process.platform === 'darwin' && hasCommand('security'),
    get () {
      try {
        const out = execFileSync('security', ['find-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] })
        return Buffer.from(out.toString().trim(), 'base64')
      } catch { return null }
    },
    set (key) {
      execFileSync('security', ['-i'], { input: `add-generic-password -U -a ${ACCOUNT} -s ${SERVICE} -l "IRIS node vault" -w ${key.toString('base64')}\n`, stdio: ['pipe', 'ignore', 'pipe'] })
    },
  },
  // libsecret (GNOME Keyring / KWallet via Secret Service). secret-tool reads the secret on stdin.
  libsecret: {
    available: () => process.platform === 'linux' && !!process.env.DBUS_SESSION_BUS_ADDRESS && hasCommand('secret-tool'),
    get () {
      try {
        const out = execFileSync('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT], { stdio: ['ignore', 'pipe', 'ignore'] })
        const s = out.toString().trim()
        return s ? Buffer.from(s, 'base64') : null
      } catch { return null }
    },
    set (key) {
      execFileSync('secret-tool', ['store', '--label=IRIS node vault', 'service', SERVICE, 'account', ACCOUNT], { input: key.toString('base64'), stdio: ['pipe', 'ignore', 'pipe'] })
    },
  },
  // Windows: DPAPI (CurrentUser scope) — the same OS-held key Credential Manager itself uses.
  // The protected blob sits in the vault dir; only this Windows user on this machine can open it.
  dpapi: {
    available: () => process.platform === 'win32',
    _file: () => path.join(vaultDir(), 'master.dpapi'),
    _ps (script, input) {
      return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd().Trim(); ${script}`],
      { input, stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim()
    },
    get () {
      try {
        const blob = fs.readFileSync(this._file(), 'utf8').trim()
        const out = this._ps("[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in),$null,'CurrentUser'))", blob)
        return Buffer.from(out, 'base64')
      } catch { return null }
    },
    set (key) {
      const blob = this._ps("[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($in),$null,'CurrentUser'))", key.toString('base64'))
      fs.writeFileSync(this._file(), blob, { mode: 0o600 })
    },
  },
  // Last resort: a file only this user can read. Still never in the repo or the cloud.
  file: {
    available: () => true,
    _file: () => path.join(vaultDir(), 'master.key'),
    get () {
      try { return Buffer.from(fs.readFileSync(this._file(), 'utf8').trim(), 'base64') } catch { return null }
    },
    set (key) {
      fs.writeFileSync(this._file(), key.toString('base64'), { mode: 0o600 })
      try { fs.chmodSync(this._file(), 0o600) } catch { /* windows */ }
    },
  },
}

// ─── Index: names and non-secret metadata only ───────────────────────────────

function indexPath () { return path.join(vaultDir(), 'index.json') }

function readIndex () {
  try { return JSON.parse(fs.readFileSync(indexPath(), 'utf8')) } catch { return { backend: null, credentials: {} } }
}

function writeIndex (idx) {
  ensureDir()
  fs.writeFileSync(indexPath(), JSON.stringify(idx, null, 2), { mode: 0o600 })
}

/**
 * Which backend holds the key. Pinned in the index once chosen: if secret-tool appears on this
 * machine next month, switching backends silently would orphan every stored credential.
 */
function chooseBackend (idx) {
  const forced = process.env.IRIS_VAULT_BACKEND
  if (forced) {
    if (!backends[forced]) throw new Error(`unknown IRIS_VAULT_BACKEND "${forced}"`)
    return forced
  }
  if (idx.backend && backends[idx.backend]) return idx.backend
  for (const name of ['keychain', 'libsecret', 'dpapi']) {
    if (backends[name].available()) return name
  }
  return 'file'
}

function masterKey ({ create = false } = {}) {
  const idx = readIndex()
  const backend = chooseBackend(idx)
  let key = backends[backend].get()
  if ((!key || key.length !== 32) && create) {
    ensureDir()
    key = crypto.randomBytes(32)
    backends[backend].set(key)
    idx.backend = backend
    writeIndex(idx)
  }
  if (!key || key.length !== 32) return { key: null, backend }
  return { key, backend }
}

// ─── Sealed store ────────────────────────────────────────────────────────────

function vaultPath () { return path.join(vaultDir(), 'vault.enc') }

function seal (key, obj) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(SERVICE))
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()])
  return JSON.stringify({ v: 1, alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') })
}

function unseal (key, text) {
  const env = JSON.parse(text)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'))
  decipher.setAAD(Buffer.from(SERVICE))
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'))
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]).toString('utf8'))
}

function readAll (key) {
  if (!fs.existsSync(vaultPath())) return {}
  return unseal(key, fs.readFileSync(vaultPath(), 'utf8'))
}

function writeAll (key, all) {
  ensureDir()
  const tmp = vaultPath() + '.tmp'
  fs.writeFileSync(tmp, seal(key, all), { mode: 0o600 })
  fs.renameSync(tmp, vaultPath())
}

function validName (name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error('credential name must be 1-64 chars of letters, digits, ".", "_" or "-"')
  }
  return name
}

/**
 * Store a credential. `secret` fields: password, totp_secret (base32). Non-secret: type,
 * username, url, totp options. Returns the non-secret summary only.
 */
function addCredential (name, cred = {}) {
  validName(name)
  if (cred.totp_secret) base32Decode(cred.totp_secret) // reject a malformed seed now, not at 3am
  const { key, backend } = masterKey({ create: true })
  const all = readAll(key)
  all[name] = {
    type: cred.type || 'login',
    username: cred.username || null,
    password: cred.password || null,
    url: cred.url || null,
    totp_secret: cred.totp_secret ? String(cred.totp_secret).replace(/\s+/g, '').toUpperCase() : null,
    totp: cred.totp_secret ? { digits: cred.digits || 6, period: cred.period || 30, algorithm: cred.algorithm || 'sha1' } : null,
    updated_at: new Date().toISOString(),
  }
  writeAll(key, all)
  const idx = readIndex()
  idx.backend = backend
  idx.credentials = idx.credentials || {}
  idx.credentials[name] = summary(name, all[name])
  writeIndex(idx)
  return idx.credentials[name]
}

function summary (name, c) {
  return { name, type: c.type || 'login', has_totp: !!c.totp_secret, updated_at: c.updated_at || null }
}

function removeCredential (name) {
  validName(name)
  const { key } = masterKey()
  let existed = false
  if (key) {
    const all = readAll(key)
    existed = !!all[name]
    delete all[name]
    writeAll(key, all)
  }
  const idx = readIndex()
  if (idx.credentials && idx.credentials[name]) { existed = true; delete idx.credentials[name]; writeIndex(idx) }
  return existed
}

/**
 * NAMES ONLY. This is what the heartbeat carries and what `creds list` prints: it reads the index,
 * not the sealed store, so it cannot leak a value even by accident (and costs no keychain call).
 */
function listNames () {
  const idx = readIndex()
  return Object.values(idx.credentials || {}).map(c => ({ name: c.name, type: c.type, has_totp: !!c.has_totp, updated_at: c.updated_at || null }))
}

/** Full credential, for local injection only. Never log or return this object. */
function getCredential (name) {
  validName(name)
  const { key } = masterKey()
  if (!key) throw new Error(`node vault is empty on this machine (no key) — add "${name}" with: iris-daemon creds add ${name}`)
  const c = readAll(key)[name]
  if (!c) throw new Error(`no credential named "${name}" in this node's vault — add it with: iris-daemon creds add ${name}`)
  return c
}

// ─── RFC 6238 TOTP (#187916) ─────────────────────────────────────────────────

function base32Decode (input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const s = String(input).replace(/\s+/g, '').replace(/=+$/, '').toUpperCase()
  if (!s.length) throw new Error('empty TOTP secret')
  let bits = 0; let value = 0; const out = []
  for (const ch of s) {
    const i = alphabet.indexOf(ch)
    if (i < 0) throw new Error('TOTP secret is not valid base32')
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8 }
  }
  return Buffer.from(out)
}

/** RFC 4226 HOTP over a raw key buffer. */
function hotp (keyBuf, counter, { digits = 6, algorithm = 'sha1' } = {}) {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = crypto.createHmac(algorithm, keyBuf).update(msg).digest()
  const off = h[h.length - 1] & 0x0f
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
  return String(bin % 10 ** digits).padStart(digits, '0')
}

/** RFC 6238 TOTP. `secret` is base32 (as portals show it) or a Buffer (raw key). */
function totp (secret, { time = Date.now(), period = 30, digits = 6, algorithm = 'sha1' } = {}) {
  const keyBuf = Buffer.isBuffer(secret) ? secret : base32Decode(secret)
  return hotp(keyBuf, Math.floor(time / 1000 / period), { digits, algorithm })
}

function otpFor (name, time = Date.now()) {
  const c = getCredential(name)
  if (!c.totp_secret) throw new Error(`credential "${name}" has no TOTP secret`)
  return totp(c.totp_secret, { time, ...c.totp })
}

// ─── Keeping the values out of output ────────────────────────────────────────

/**
 * What must never appear in a task's output for a credential: its password and seed verbatim,
 * and every TOTP code it could have produced since the task began (a script that prints the code
 * it typed has printed a live second factor). Built once per task, held off the task object.
 */
function secretsFor (cred, { since = Date.now() } = {}) {
  const values = [cred.password, cred.totp_secret].filter(v => typeof v === 'string' && v.length >= 4)
  const totps = cred.totp_secret ? [{ secret: cred.totp_secret, ...(cred.totp || {}) }] : []
  return { values, totps, since }
}

function escapeRe (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

function redactSecrets (text, secrets, now = Date.now()) {
  if (typeof text !== 'string' || !secrets) return text
  let out = text
  for (const v of secrets.values || []) out = out.split(v).join(REDACTED)
  for (const t of secrets.totps || []) {
    const period = (t.period || 30) * 1000
    // Every window from (task start - 1) to (now + 1), capped at a day of windows.
    const from = Math.max(Math.floor(secrets.since / period) - 1, Math.floor(now / period) - 2880)
    const to = Math.floor(now / period) + 1
    const codes = new Set()
    for (let w = from; w <= to; w++) codes.add(totp(t.secret, { time: w * period, period: t.period || 30, digits: t.digits || 6, algorithm: t.algorithm || 'sha1' }))
    for (const code of codes) out = out.replace(new RegExp(`(?<!\\d)${escapeRe(code)}(?!\\d)`, 'g'), REDACTED)
  }
  return out
}

/** Deep-redact every string in a JSON-able value (results, progress bodies). */
function redactDeep (value, secrets, now = Date.now()) {
  if (!secrets) return value
  if (typeof value === 'string') return redactSecrets(value, secrets, now)
  if (Array.isArray(value)) return value.map(v => redactDeep(v, secrets, now))
  if (value && typeof value === 'object') {
    const o = {}
    for (const [k, v] of Object.entries(value)) o[k] = redactDeep(v, secrets, now)
    return o
  }
  return value
}

/**
 * The environment a robot gets for credential `name`. The seed is deliberately absent: the robot
 * asks `iris-otp` (IRIS_OTP_JS) for the current code, which is generated here at that moment.
 */
function envForTask (name, cred) {
  return {
    IRIS_CRED_NAME: name,
    IRIS_CRED_TYPE: cred.type || 'login',
    ...(cred.username ? { IRIS_CRED_USERNAME: cred.username } : {}),
    ...(cred.password ? { IRIS_CRED_PASSWORD: cred.password } : {}),
    ...(cred.url ? { IRIS_CRED_URL: cred.url } : {}),
    ...(cred.totp_secret ? { IRIS_CRED_HAS_TOTP: '1', IRIS_OTP_JS: path.join(__dirname, '..', 'iris-otp') } : {}),
  }
}

module.exports = {
  addCredential,
  removeCredential,
  listNames,
  getCredential,
  otpFor,
  totp,
  hotp,
  base32Decode,
  secretsFor,
  redactSecrets,
  redactDeep,
  envForTask,
  vaultDir,
  REDACTED,
  _backends: backends,
  _masterKey: masterKey,
}
