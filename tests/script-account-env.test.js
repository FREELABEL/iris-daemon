'use strict'

// #186147 — a persisted script run with `hive script exec` did not get IRIS_API_KEY. Scripts now get
// the signed-in ACCOUNT key — and never the node key under that name.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')

function envFor (home, extra = {}) {
  const out = execFileSync(process.execPath, ['-e', "process.stdout.write(JSON.stringify(require('./daemon/task-executor').accountEnvForScripts()))"], {
    cwd: ROOT, env: { PATH: process.env.PATH, HOME: home, ...extra }, encoding: 'utf-8'
  })
  return JSON.parse(out)
}

test('signed in → scripts get the account key and user id', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sae-'))
  fs.mkdirSync(path.join(home, '.iris', 'sdk'), { recursive: true })
  fs.writeFileSync(path.join(home, '.iris', 'sdk', '.env'), 'IRIS_API_KEY=acct_token_123\nIRIS_USER_ID=42\n')
  assert.deepStrictEqual(envFor(home), { IRIS_API_KEY: 'acct_token_123', IRIS_USER_ID: '42' })
})

test('only a NODE key on the machine → scripts get nothing (never the node key as IRIS_API_KEY)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sae-'))
  fs.mkdirSync(path.join(home, '.iris'), { recursive: true })
  fs.writeFileSync(path.join(home, '.iris', 'config.json'), JSON.stringify({ node_api_key: 'node_live_SECRETNODEKEY123456', user_id: 42 }))
  assert.deepStrictEqual(envFor(home), {})
})

test('an explicit IRIS_API_KEY in the daemon env still wins', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sae-'))
  assert.deepStrictEqual(envFor(home, { IRIS_API_KEY: 'from_env', IRIS_USER_ID: '7' }), { IRIS_API_KEY: 'from_env', IRIS_USER_ID: '7' })
})
