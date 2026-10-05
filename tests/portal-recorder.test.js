'use strict'

// #187920 — a recorded portal flow becomes a parameterised Hive script. The non-negotiable part:
// nothing the person TYPED (password, MFA code, the sample patient) and nothing that LOOKS like a
// record survives into the script; credentials are referenced by node-vault NAME only.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { sanitizeRecording, codegenArgs, shredRaw, rawRecordingPath } = require('../lib/portal-recorder')
const cli = require('../lib/portal-record-cli')

const RAW = `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('https://portal.example.com/login');
  await page.getByLabel('Email').fill('navigator@clinic.org');
  await page.getByLabel('Password').fill('Hunter2!secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByPlaceholder('Enter the 6-digit verification code').fill('492133');
  await page.getByLabel('Last name').fill('Doe');
  await page.fill('#dob', '03/14/1962');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('link', { name: 'Doe, Jane' }).click();
  await page.goto('https://portal.example.com/patients/0012345/records?mrn=0012345');
  await page.getByText('Member since 2011 (ID 88812345)').click();
  await page.getByLabel('Zip code').fill('78701');
  await page.getByRole('button', { name: 'Download PDF' }).click();
});
`
const SECRETS = ['navigator@clinic.org', 'Hunter2!secret', '492133', 'Doe', '03/14/1962', '0012345', '88812345', '78701', 'Jane']

test('no typed secret, OTP, patient value or record-looking text survives', () => {
  const { script } = sanitizeRecording(RAW, { name: 'pathways-labs', vault: 'pathways-portal' })
  for (const s of SECRETS) assert.ok(!script.includes(s), `leaked: ${s}`)
  // Selectors and steps are kept — that is the know-how being captured.
  assert.match(script, /getByRole\('button', \{ name: 'Download PDF' \}\)/)
  assert.match(script, /getByLabel\('Last name'\)\.fill\(P\('LAST_NAME', rec\)\)/)
})

test('credentials are read from the node vault by NAME; the OTP is generated on the node', () => {
  const { script, credential, removed } = sanitizeRecording(RAW, { name: 'x', vault: 'pathways-portal' })
  assert.strictEqual(credential, 'pathways-portal')
  assert.match(script, /\/\/ iris: credential=pathways-portal/)
  assert.match(script, /getByLabel\('Password'\)\.fill\(C\('IRIS_CRED_PASSWORD'\)\)/)
  assert.match(script, /getByLabel\('Email'\)\.fill\(C\('IRIS_CRED_USERNAME'\)\)/, 'an e-mail followed by a password is the login')
  assert.match(script, /verification code'\)\.fill\(OTP\(\)\)/)
  assert.deepStrictEqual([removed.password, removed.username, removed.otp], [1, 1, 1])
  assert.throws(() => sanitizeRecording(RAW, { vault: 'bad name; rm -rf' }))
})

test('without a vault name a typed password still never survives (becomes a parameter)', () => {
  const { script } = sanitizeRecording(RAW, { name: 'x' })
  assert.ok(!script.includes('Hunter2!secret'))
  assert.doesNotMatch(script, /IRIS_CRED_PASSWORD/)
})

test('a zip code is record data, not an MFA code; an echoed value reuses or replaces whole', () => {
  const { script, params } = sanitizeRecording(RAW, { name: 'x', vault: 'v' })
  assert.match(script, /getByLabel\('Zip code'\)\.fill\(P\('ZIP_CODE', rec\)\)/)
  assert.match(script, /getByRole\('link', \{ name: P\('MATCH', rec\) \}\)/)
  assert.ok(params.every(p => /^[A-Z][A-Z0-9_]*$/.test(p.name)))
  assert.ok(params.every(p => !SECRETS.some(s => p.label.includes(s))), 'param labels are field names, never values')
})

test('declared sample-record values are stripped even where nobody typed them', () => {
  const raw = RAW.replace("'Download PDF'", "'Download Jane-Roe-intake.pdf'")
  const { script } = sanitizeRecording(raw, { name: 'x', vault: 'v', phiValues: ['Roe'] })
  assert.ok(!script.includes('Roe'))
})

test('steps before the first record value are the login (once); the rest repeat per record', () => {
  const { script } = sanitizeRecording(RAW, { name: 'x', vault: 'v' })
  const loginAt = script.indexOf("C('IRIS_CRED_PASSWORD')")
  const perRecordAt = script.indexOf('const perRecord = async')
  assert.ok(loginAt > 0 && loginAt < perRecordAt)
  assert.ok(script.indexOf("P('LAST_NAME'") > perRecordAt)
  assert.match(script, /forEachRecord\(loadRecords\(\)/)
})

test('codegen is driven headed with an http(s) URL only', () => {
  assert.deepStrictEqual(codegenArgs({ url: 'https://p.example/login', outFile: '/t/raw.spec.ts' }).slice(0, 4), ['playwright', 'codegen', '--target', 'playwright-test'])
  assert.throws(() => codegenArgs({ url: 'file:///etc/passwd', outFile: 'x' }))
})

test('CLI: saves spec + launcher into the scripts dir; the raw recording is shredded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-cli-'))
  const raw = rawRecordingPath()
  fs.writeFileSync(raw, RAW)
  const saved = cli.saveRecording({ rawFile: raw, name: 'Pathways Labs', vault: 'pathways-portal', phiValues: [], scriptsDir: dir })
  shredRaw(raw)
  assert.strictEqual(fs.existsSync(raw), false)
  assert.strictEqual(saved.slug, 'pathways-labs')
  const all = fs.readFileSync(saved.specPath, 'utf8') + fs.readFileSync(saved.launcherPath, 'utf8')
  for (const s of SECRETS) assert.ok(!all.includes(s), `leaked: ${s}`)
  // The launcher is valid JS that a node schedule can fire.
  assert.doesNotThrow(() => new Function(fs.readFileSync(saved.launcherPath, 'utf8').replace(/^\/\/.*$/gm, '')))
  assert.match(fs.readFileSync(saved.launcherPath, 'utf8'), /envForTask\(vault, v\.getCredential\(vault\)\)/)
})

test('REPLAY: the generated script drives a page with vault creds once and record values per record, checkpointed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-replay-'))
  const otpJs = path.join(dir, 'otp.js')
  fs.writeFileSync(otpJs, "process.stdout.write('654321\\n')")
  const records = [{ LAST_NAME: 'Alpha', DOB: '01/01/2000', MATCH: 'Alpha, A', PATH: '1', MRN: '1', RECORD_TEXT: 't', ZIP_CODE: '1' },
    { LAST_NAME: 'Beta', DOB: '02/02/2000', MATCH: 'Beta, B', PATH: '2', MRN: '2', RECORD_TEXT: 't', ZIP_CODE: '2' }]
  const recFile = path.join(dir, 'records.json')
  fs.writeFileSync(recFile, JSON.stringify(records))
  const { script } = sanitizeRecording(RAW, { name: 'x', vault: 'v' })
  const js = script.replace(/^import .*$/gm, '').replace(/: (string|any)\b/g, '')
  const calls = []
  const loc = (desc) => new Proxy({}, { get: (_, m) => (...a) => { calls.push([desc, m, ...a]); return m === 'click' || m === 'fill' || m === 'selectOption' ? Promise.resolve() : loc(desc) } })
  const page = new Proxy({}, { get: (_, m) => (...a) => { if (m === 'goto' || m === 'fill') { calls.push(['page', m, ...a]); return Promise.resolve() } return loc(`${m}(${JSON.stringify(a[0])})`) } })
  let body
  const env = { IRIS_CRED_USERNAME: 'u@x', IRIS_CRED_PASSWORD: 'pw', IRIS_CRED_NAME: 'v', IRIS_OTP_JS: otpJs,
    IRIS_PORTAL_RECORDS: recFile, IRIS_PORTAL_LIB: path.join(__dirname, '..', 'lib', 'portal-checkpoint.js'), IRIS_PORTAL_CHECKPOINT: path.join(dir, 'run', 'checkpoint.json') }
  const saved = { ...process.env }
  Object.assign(process.env, env)
  const { execFileSync } = require('child_process')
  new Function('test', 'require', 'execFileSync', js)((t, fn) => { body = fn }, require, execFileSync)
  const origWrite = process.stdout.write
  process.stdout.write = () => true // forEachRecord's progress lines
  try { await body({ page }) } finally {
    process.stdout.write = origWrite
    for (const k of Object.keys(env)) { if (k in saved) process.env[k] = saved[k]; else delete process.env[k] }
  }
  const fills = calls.filter(c => c[1] === 'fill').map(c => c[c.length - 1])
  assert.deepStrictEqual(fills.slice(0, 3), ['u@x', 'pw', '654321'], 'login once, from the vault')
  assert.ok(fills.includes('Alpha') && fills.includes('Beta'))
  assert.strictEqual(fills.filter(f => f === 'pw').length, 1)
  assert.strictEqual(require('../lib/portal-checkpoint').readSummary(env.IRIS_PORTAL_CHECKPOINT).done, 2)
})
