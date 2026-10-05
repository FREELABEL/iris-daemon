'use strict'

/**
 * #187915 (node-local credential vault) + #187916 (node-side TOTP).
 *
 * What must hold:
 *   - TOTP matches RFC 6238 Appendix B for SHA1/SHA256/SHA512;
 *   - the vault on disk is sealed: neither the password nor the seed appears in any file it
 *     writes, a flipped byte fails to open, and the fallback key file is 0600;
 *   - listing is NAMES ONLY (CLI, heartbeat);
 *   - a task that references a credential by name gets it in its env, and nothing that leaves
 *     the node (result, progress, live output) carries the password, the seed or a live code.
 */

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-vault-test-'))
process.env.IRIS_VAULT_DIR = path.join(TMP, 'vault')
process.env.IRIS_VAULT_BACKEND = 'file' // deterministic in CI; the OS backends share the sealing code

const vault = require('../lib/node-vault')
const cli = require('../lib/node-vault-cli')

const PASSWORD = 'Pw-correct-horse-9931'
const SEED = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'

after(() => { fs.rmSync(TMP, { recursive: true, force: true }) })

describe('RFC 6238 TOTP (#187916)', () => {
  // RFC 6238 Appendix B: 8 digits, T0 = 0, X = 30.
  const seeds = {
    sha1: Buffer.from('12345678901234567890'),
    sha256: Buffer.from('12345678901234567890123456789012'),
    sha512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234'),
  }
  const vectors = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ]
  for (const [t, s1, s256, s512] of vectors) {
    it(`T=${t}`, () => {
      assert.equal(vault.totp(seeds.sha1, { time: t * 1000, digits: 8, algorithm: 'sha1' }), s1)
      assert.equal(vault.totp(seeds.sha256, { time: t * 1000, digits: 8, algorithm: 'sha256' }), s256)
      assert.equal(vault.totp(seeds.sha512, { time: t * 1000, digits: 8, algorithm: 'sha512' }), s512)
    })
  }

  it('accepts the base32 form portals show (same key as the RFC seed)', () => {
    // base32("12345678901234567890") — what an authenticator QR carries.
    assert.equal(vault.totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', { time: 59000 }), '287082')
    assert.equal(vault.totp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq', { time: 59000 }), '287082')
    assert.throws(() => vault.base32Decode('not base32!'), /base32/)
  })
})

describe('node vault storage (#187915)', () => {
  before(() => {
    vault.addCredential('pathways-portal', { username: 'robot@clinic.test', password: PASSWORD, url: 'https://portal.test/login', totp_secret: SEED })
  })

  it('round-trips a credential for local use', () => {
    const c = vault.getCredential('pathways-portal')
    assert.equal(c.password, PASSWORD)
    assert.equal(c.totp_secret, SEED)
    assert.equal(vault.otpFor('pathways-portal', 59000), vault.totp(SEED, { time: 59000 }))
  })

  it('never writes the password or seed in the clear', () => {
    for (const f of fs.readdirSync(vault.vaultDir())) {
      const body = fs.readFileSync(path.join(vault.vaultDir(), f), 'utf8')
      assert.ok(!body.includes(PASSWORD), `${f} holds the password`)
      assert.ok(!body.includes(SEED), `${f} holds the TOTP seed`)
    }
  })

  it('keeps the fallback key readable only by the user', { skip: process.platform === 'win32' }, () => {
    const mode = fs.statSync(path.join(vault.vaultDir(), 'master.key')).mode & 0o777
    assert.equal(mode, 0o600)
    assert.equal(fs.statSync(path.join(vault.vaultDir(), 'vault.enc')).mode & 0o777, 0o600)
  })

  it('refuses a tampered vault (authenticated encryption)', () => {
    const p = path.join(vault.vaultDir(), 'vault.enc')
    const orig = fs.readFileSync(p, 'utf8')
    const env = JSON.parse(orig)
    const ct = Buffer.from(env.ct, 'base64'); ct[0] ^= 1
    fs.writeFileSync(p, JSON.stringify({ ...env, ct: ct.toString('base64') }))
    try {
      assert.throws(() => vault.getCredential('pathways-portal'))
    } finally { fs.writeFileSync(p, orig) }
  })

  it('cannot be opened with a different key', () => {
    const k = path.join(vault.vaultDir(), 'master.key')
    const orig = fs.readFileSync(k, 'utf8')
    fs.writeFileSync(k, require('crypto').randomBytes(32).toString('base64'))
    try {
      assert.throws(() => vault.getCredential('pathways-portal'))
    } finally { fs.writeFileSync(k, orig) }
  })

  it('lists NAMES only', () => {
    const names = vault.listNames()
    assert.deepEqual(names.map(n => Object.keys(n).sort()), [['has_totp', 'name', 'type', 'updated_at']])
    assert.equal(names[0].name, 'pathways-portal')
    assert.equal(names[0].has_totp, true)
    assert.ok(!JSON.stringify(names).includes(PASSWORD))
    assert.ok(!JSON.stringify(names).includes('robot@clinic.test'))
  })

  it('rejects names that could escape a path or a shell', () => {
    assert.throws(() => vault.addCredential('../etc', { password: 'x' }), /name/)
    assert.throws(() => vault.addCredential('a b', { password: 'x' }), /name/)
  })

  it('gives the robot the login but NOT the seed', () => {
    const env = vault.envForTask('pathways-portal', vault.getCredential('pathways-portal'))
    assert.equal(env.IRIS_CRED_PASSWORD, PASSWORD)
    assert.equal(env.IRIS_CRED_HAS_TOTP, '1')
    assert.ok(!Object.values(env).includes(SEED))
    assert.ok(fs.existsSync(env.IRIS_OTP_JS))
  })
})

describe('redaction', () => {
  const cred = { password: PASSWORD, totp_secret: SEED, totp: { digits: 6, period: 30, algorithm: 'sha1' } }

  it('removes the password, the seed and every code since the task began', () => {
    const since = Date.now() - 95_000
    const secrets = vault.secretsFor(cred, { since })
    const oldCode = vault.totp(SEED, { time: since })
    const nowCode = vault.totp(SEED)
    const text = `typed ${PASSWORD} then seed ${SEED} code ${nowCode} earlier ${oldCode} order #12345678`
    const out = vault.redactSecrets(text, secrets)
    for (const s of [PASSWORD, SEED]) assert.ok(!out.includes(s))
    assert.ok(!new RegExp(`(?<!\\d)${nowCode}(?!\\d)`).test(out))
    assert.ok(!new RegExp(`(?<!\\d)${oldCode}(?!\\d)`).test(out))
    assert.ok(out.includes('#12345678'), 'unrelated longer numbers survive')
  })

  it('deep-redacts results', () => {
    const r = vault.redactDeep({ output: `pw=${PASSWORD}`, metadata: { lines: [PASSWORD] }, n: 3 }, vault.secretsFor(cred))
    assert.ok(!JSON.stringify(r).includes(PASSWORD))
    assert.equal(r.n, 3)
  })
})

describe('CLI', () => {
  it('list prints names only; otp prints the current code', async () => {
    const out = []
    const io = { out: s => out.push(s), err: s => out.push(s) }
    assert.equal(await cli.main(['list'], io), 0)
    assert.equal(await cli.main(['list', '--json'], io), 0)
    assert.ok(out.join('\n').includes('pathways-portal'))
    assert.ok(!out.join('\n').includes(PASSWORD))
    out.length = 0
    assert.equal(await cli.main(['otp', 'pathways-portal'], io), 0)
    assert.match(out[0], /^\d{6}$/)
  })

  it('iris-otp <name> prints a code and never the seed', () => {
    const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'iris-otp'), 'pathways-portal'], { env: process.env }).toString().trim()
    assert.match(out, /^\d{6}$/)
    assert.ok(!out.includes(SEED))
  })

  it('add --password-stdin reads secrets from stdin, not argv; remove deletes', () => {
    const cliPath = path.join(__dirname, '..', 'lib', 'node-vault-cli.js')
    execFileSync(process.execPath, [cliPath, 'add', 'tmp-portal', '--username', 'u', '--password-stdin'], { input: `s3cret-stdin\n${SEED}\n`, env: process.env })
    assert.equal(vault.getCredential('tmp-portal').password, 's3cret-stdin')
    assert.equal(vault.getCredential('tmp-portal').totp_secret, SEED)
    execFileSync(process.execPath, [cliPath, 'remove', 'tmp-portal'], { env: process.env })
    assert.ok(!vault.listNames().some(n => n.name === 'tmp-portal'))
  })
})

describe('what leaves the node', () => {
  const { CloudClient } = require('../daemon/cloud-client')

  function capturingClient () {
    const c = new CloudClient('https://hub.test', 'node_live_test')
    c.sent = []
    c._requestWithFailover = async (method, p, body) => { c.sent.push({ p, body }); return {} }
    return c
  }

  it('heartbeat carries credential NAMES, never values', async () => {
    const c = capturingClient()
    await c.sendHeartbeat({ hardware_profile: {} })
    const hb = c.sent[0].body
    assert.ok(Array.isArray(hb.vault_credentials))
    assert.equal(hb.vault_credentials[0].name, 'pathways-portal')
    const wire = JSON.stringify(hb)
    for (const s of [PASSWORD, SEED, 'robot@clinic.test']) assert.ok(!wire.includes(s))
  })

  it('a marked task has every report redacted at the one door', async () => {
    const c = capturingClient()
    c.markSecretTask('t-1', vault.secretsFor(vault.getCredential('pathways-portal')))
    await c.reportProgress('t-1', 50, `logging in with ${PASSWORD}`)
    await c.reportOutput('t-1', 1, `seed=${SEED}`)
    await c.submitResult('t-1', { status: 'completed', output: `ok ${PASSWORD}`, stdout: [PASSWORD] })
    const wire = JSON.stringify(c.sent)
    assert.ok(!wire.includes(PASSWORD))
    assert.ok(!wire.includes(SEED))
    // An unmarked task is untouched (no false positives on other work).
    await c.submitResult('t-2', { output: 'plain' })
    assert.equal(c.sent.at(-1).body.output, 'plain')
  })

  it('end to end: a task referencing the credential by name logs in with it and leaks nothing', async () => {
    const { TaskExecutor } = require('../daemon/task-executor')
    const { WorkspaceManager } = require('../daemon/workspace-manager')
    const c = capturingClient()
    const ex = new TaskExecutor(c, new WorkspaceManager(path.join(TMP, 'data')))
    ex.tmux = { available: false, cleanup () {}, cleanupAll () {} }
    const logs = []
    const origLog = console.log; const origWarn = console.warn; const origErr = console.error
    console.log = (...a) => logs.push(a.join(' ')); console.warn = console.log; console.error = console.log
    const script = `node -e "const {execFileSync}=require('child_process');const code=execFileSync(process.execPath,[process.env.IRIS_OTP_JS,process.env.IRIS_CRED_NAME]).toString().trim();console.log('user='+process.env.IRIS_CRED_USERNAME+' pw='+process.env.IRIS_CRED_PASSWORD+' otp='+code+' len='+process.env.IRIS_CRED_PASSWORD.length);console.error('err '+process.env.IRIS_CRED_PASSWORD)"`
    try {
      await ex.execute({ id: 'vault-e2e-1', type: 'test_run', prompt: script, config: { node_credential: 'pathways-portal' } })
    } finally { console.log = origLog; console.warn = origWarn; console.error = origErr }
    const result = c.sent.find(s => s.p.endsWith('/result'))
    assert.ok(result, 'a result was submitted')
    const out = JSON.stringify(result.body)
    assert.match(out, /user=robot@clinic\.test/, 'the robot received the login from the vault')
    assert.match(out, new RegExp(`len=${PASSWORD.length}`), 'the password reached the child env')
    const wire = JSON.stringify(c.sent) + '\n' + logs.join('\n')
    assert.ok(!wire.includes(PASSWORD), 'password leaked to cloud or daemon log')
    assert.ok(!wire.includes(SEED), 'seed leaked')
    assert.ok(/otp=\[redacted:node-vault\]/.test(out), 'the live code is redacted')
  })
})
