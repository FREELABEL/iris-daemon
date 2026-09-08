/**
 * R1 Device Registry — pairing tokens for handheld agent clients.
 *
 * The R1 is not a browser and has no keyboard, so it cannot carry the operator's
 * X-Bridge-Key the way a CLI does. Each device gets its OWN long-lived token,
 * minted here, so a lost or sold device is revoked on its own without rotating
 * the operator key that every other tool on the machine depends on.
 *
 * Stored at ~/.iris/bridge/r1-devices.json (mode 0600).
 *
 * Tokens are compared with timingSafeEqual and stored as sha256 digests — the
 * plaintext is shown exactly once, at mint time. A registry file that leaks
 * should not hand over the devices.
 */

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const REGISTRY_PATH = process.env.R1_REGISTRY_PATH ||
  path.join(os.homedir(), '.iris', 'bridge', 'r1-devices.json')

function _read () {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed.devices) ? parsed : { devices: [] }
  } catch {
    return { devices: [] }
  }
}

function _write (registry) {
  const dir = path.dirname(REGISTRY_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), { mode: 0o600 })
}

function _hash (token) {
  return crypto.createHash('sha256').update(token, 'utf-8').digest('hex')
}

/**
 * Mint a pairing token for a device.
 * Returns the PLAINTEXT token — this is the only time it exists in the clear.
 */
function pair (deviceId, opts = {}) {
  if (!deviceId || !/^[A-Za-z0-9._-]{1,64}$/.test(deviceId)) {
    throw new Error('device id must be 1-64 chars of [A-Za-z0-9._-]')
  }

  const token = crypto.randomBytes(32).toString('hex')
  const registry = _read()

  // Re-pairing the same device replaces its token rather than accumulating
  // entries — otherwise a device paired three times has three live keys and
  // revoking "it" revokes one of them.
  registry.devices = registry.devices.filter(d => d.device_id !== deviceId)
  registry.devices.push({
    device_id: deviceId,
    token_sha256: _hash(token),
    label: opts.label || deviceId,
    agent_id: opts.agentId || null,
    paired_at: new Date().toISOString(),
    last_seen: null
  })
  _write(registry)

  return { device_id: deviceId, token, label: opts.label || deviceId, agent_id: opts.agentId || null }
}

/**
 * Verify a device_id + token pair. Returns the device record, or null.
 */
function verify (deviceId, token) {
  if (!deviceId || !token) return null

  const device = _read().devices.find(d => d.device_id === deviceId)
  if (!device) return null

  const expected = Buffer.from(device.token_sha256, 'hex')
  const actual = Buffer.from(_hash(token), 'hex')
  if (expected.length !== actual.length) return null
  if (!crypto.timingSafeEqual(expected, actual)) return null

  return device
}

/** Record a successful connection. Best-effort — never throws into the WS path. */
function touch (deviceId) {
  try {
    const registry = _read()
    const device = registry.devices.find(d => d.device_id === deviceId)
    if (!device) return
    device.last_seen = new Date().toISOString()
    _write(registry)
  } catch { /* a failed timestamp must not drop a live connection */ }
}

/** List paired devices. Never returns token material. */
function list () {
  return _read().devices.map(({ token_sha256, ...safe }) => safe)
}

/** Revoke one device. Returns true if something was removed. */
function revoke (deviceId) {
  const registry = _read()
  const before = registry.devices.length
  registry.devices = registry.devices.filter(d => d.device_id !== deviceId)
  if (registry.devices.length === before) return false
  _write(registry)
  return true
}

module.exports = { pair, verify, touch, list, revoke, REGISTRY_PATH }
