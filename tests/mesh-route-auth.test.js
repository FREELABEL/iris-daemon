/**
 * The mesh HTTP surface must authenticate every route before it can be bound routably (#182092,
 * #182094 — the auth half of the atomic release with #182079).
 *
 * MEASURED 2026-08-23: the mesh routes are exempt from the bridge's global bridgeAuth
 * (openPrefixes '/daemon/mesh/', "mesh routes use their own X-Mesh-Key auth") — yet only 3 of 12
 * carried a per-route gate. /mesh/invite in particular minted a valid PSK to any caller, so
 * binding the listener off loopback would have handed arbitrary task execution to the network.
 *
 * This pins the two-tier model on the middleware directly (no HTTP server needed):
 *   - operatorMiddleware() — X-Bridge-Key, the local operator secret — gates the credential
 *     factory (/mesh/invite) and registry mutation.
 *   - middleware() — X-Mesh-Key, a paired peer's PSK, constant-time — gates every peer op AND read.
 *
 * SECRET ISOLATION: the key/token paths are pointed at throwaway temp files via env BEFORE the
 * module is required, so this never reads or writes the operator's real ~/.iris secrets even if
 * it crashes mid-run.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-auth-test-'))
const KEYS_FILE = path.join(TMP, 'mesh-keys.json')
const TOKEN_FILE = path.join(TMP, 'bridge-token')
process.env.IRIS_MESH_KEYS_FILE = KEYS_FILE
process.env.IRIS_BRIDGE_TOKEN_FILE = TOKEN_FILE

const { describe, it, beforeEach, afterEach, after } = require('node:test')
const assert = require('node:assert/strict')
const MeshAuth = require('../daemon/mesh-auth')

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

// A fake Express req/res/next so we can drive the middleware without a socket.
function run (mw, headers) {
  return new Promise((resolve) => {
    const req = { headers: headers || {} }
    const res = {
      statusCode: 200,
      status (c) { this.statusCode = c; return this },
      json (body) { resolve({ status: this.statusCode, body, passed: false }) }
    }
    mw(req, res, () => resolve({ status: 200, passed: true }))
  })
}

function clearKeys () { try { fs.unlinkSync(KEYS_FILE) } catch {} }

describe('mesh peer auth — middleware() / X-Mesh-Key', () => {
  let auth
  beforeEach(() => { clearKeys(); auth = new MeshAuth(); auth.addAuthorizedKey('a'.repeat(64), 'peer-x') })

  it('rejects a missing key', async () => {
    const r = await run(auth.middleware(), {})
    assert.equal(r.passed, false)
    assert.equal(r.status, 403)
  })

  it('rejects a wrong key of the same length (no prefix/length leak)', async () => {
    const r = await run(auth.middleware(), { 'x-mesh-key': 'b'.repeat(64) })
    assert.equal(r.passed, false)
  })

  it('rejects a wrong key of a different length without throwing', async () => {
    const r = await run(auth.middleware(), { 'x-mesh-key': 'short' })
    assert.equal(r.passed, false)
  })

  it('accepts an authorized PSK', async () => {
    const r = await run(auth.middleware(), { 'x-mesh-key': 'a'.repeat(64) })
    assert.equal(r.passed, true)
  })
})

describe('mesh operator auth — operatorMiddleware() / X-Bridge-Key', () => {
  let auth
  const TEST_TOKEN = 'operator-secret-token-1234567890'

  beforeEach(() => { clearKeys(); fs.writeFileSync(TOKEN_FILE, TEST_TOKEN); auth = new MeshAuth() })
  afterEach(() => { try { fs.unlinkSync(TOKEN_FILE) } catch {} })

  it('rejects a missing operator key — the invite factory is never open', async () => {
    const r = await run(auth.operatorMiddleware(), {})
    assert.equal(r.passed, false)
    assert.equal(r.status, 403)
  })

  it('rejects a wrong operator key', async () => {
    const r = await run(auth.operatorMiddleware(), { 'x-bridge-key': 'wrong-token-of-any-length' })
    assert.equal(r.passed, false)
  })

  it('accepts the correct operator token', async () => {
    const r = await run(auth.operatorMiddleware(), { 'x-bridge-key': TEST_TOKEN })
    assert.equal(r.passed, true)
  })

  it('a paired PSK does NOT satisfy operator auth (tiers are distinct)', async () => {
    auth.addAuthorizedKey('c'.repeat(64), 'peer-y')
    const r = await run(auth.operatorMiddleware(), { 'x-bridge-key': 'c'.repeat(64) })
    assert.equal(r.passed, false)
  })
})

describe('mesh operator auth — fails closed when no token exists', () => {
  beforeEach(() => { clearKeys(); try { fs.unlinkSync(TOKEN_FILE) } catch {} })

  it('denies even a well-formed request when the operator secret is absent', async () => {
    const auth = new MeshAuth()
    const r = await run(auth.operatorMiddleware(), { 'x-bridge-key': 'anything' })
    assert.equal(r.passed, false)
    assert.equal(r.status, 403)
  })
})

describe('mesh key file permissions — 0600 (the sibling fix)', () => {
  it('writes mesh-keys.json owner-only', () => {
    clearKeys()
    const auth = new MeshAuth()
    auth.addAuthorizedKey('d'.repeat(64), 'peer-z') // triggers save()
    const mode = fs.statSync(KEYS_FILE).mode & 0o777
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`)
  })
})
