'use strict'

// A rejected node key used to 401 forever, even after the user signed in (#185896). The daemon now
// re-registers from the signed-in account — but ONLY on a 401, and never destructively.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { healNodeKey, readAccount, isRejectedKey, nodeApiUrl } = require('../daemon/node-key-heal')
const { mergeConfig } = require('../lib/config-merge')

const quiet = { log () {}, warn () {} }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nkh-'))

function fakeFetch (status, body, seen = []) {
  return async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) })
    return new Response(JSON.stringify(body), { status })
  }
}

test('only a 401 counts as a dead key — a 403 is a suspended node and must never re-register', () => {
  assert.strictEqual(isRejectedKey({ statusCode: 401 }), true)
  assert.strictEqual(isRejectedKey({ statusCode: 403 }), false)
  assert.strictEqual(isRejectedKey({ code: 'ECONNREFUSED' }), false)
  assert.strictEqual(isRejectedKey(null), false)
})

test('heals: registers with the ACCOUNT token and persists key, node_id and api_url, keeping other fields', async () => {
  const dir = tmp()
  const cfg = path.join(dir, 'config.json')
  fs.writeFileSync(cfg, JSON.stringify({ node_api_key: 'node_live_DEAD', local_api_key: 'keep', pusher_key: 'pk' }))
  const seen = []
  const r = await healNodeKey({
    apiUrl: 'https://freelabel.net/',
    nodeName: 'patsy-mbp',
    previousKey: 'node_live_DEAD',
    configPath: cfg,
    account: { token: 'acct_tok', userId: 42 },
    fingerprint: 'fp123',
    fetchImpl: fakeFetch(201, { node: { id: 'node-uuid-1' }, credentials: { api_key: 'node_live_FRESH' } }, seen),
    mergeConfig,
    log: quiet
  })
  assert.strictEqual(r.healed, true)
  assert.strictEqual(r.apiKey, 'node_live_FRESH')
  assert.strictEqual(seen[0].url, 'https://freelabel.net/api/v6/nodes')
  assert.strictEqual(seen[0].init.headers.Authorization, 'Bearer acct_tok')
  assert.deepStrictEqual(
    { user_id: seen[0].body.user_id, fp: seen[0].body.machine_fingerprint, prev: seen[0].body.previous_node_api_key },
    { user_id: 42, fp: 'fp123', prev: 'node_live_DEAD' }
  )
  const after = JSON.parse(fs.readFileSync(cfg, 'utf-8'))
  assert.strictEqual(after.node_api_key, 'node_live_FRESH')
  assert.strictEqual(after.node_id, 'node-uuid-1')
  assert.strictEqual(after.api_url, 'https://freelabel.net')
  assert.strictEqual(after.node_api_key_previous, 'node_live_DEAD')
  assert.strictEqual(after.local_api_key, 'keep')
  assert.strictEqual(after.pusher_key, 'pk')
})

test('not signed in: does nothing, writes nothing, and says what to do', async () => {
  const dir = tmp()
  const cfg = path.join(dir, 'config.json')
  fs.writeFileSync(cfg, '{"node_api_key":"node_live_DEAD"}')
  let called = false
  const warnings = []
  const r = await healNodeKey({
    apiUrl: 'https://freelabel.net',
    configPath: cfg,
    account: null,
    fetchImpl: async () => { called = true },
    mergeConfig,
    log: { log () {}, warn: (m) => warnings.push(m) }
  })
  assert.strictEqual(r.healed, false)
  assert.strictEqual(called, false)
  assert.match(warnings[0], /iris auth login/)
  assert.strictEqual(fs.readFileSync(cfg, 'utf-8'), '{"node_api_key":"node_live_DEAD"}')
})

test('account token also rejected: no heal, config untouched', async () => {
  const dir = tmp()
  const cfg = path.join(dir, 'config.json')
  fs.writeFileSync(cfg, '{"node_api_key":"node_live_DEAD"}')
  const r = await healNodeKey({
    apiUrl: 'https://freelabel.net',
    configPath: cfg,
    account: { token: 't', userId: 1 },
    fingerprint: undefined,
    fetchImpl: fakeFetch(401, { error: 'Unauthenticated' }),
    mergeConfig,
    log: quiet
  })
  assert.strictEqual(r.healed, false)
  assert.strictEqual(r.reason, 'register-401')
  assert.strictEqual(fs.readFileSync(cfg, 'utf-8'), '{"node_api_key":"node_live_DEAD"}')
})

test('a success with no key in it is not a heal', async () => {
  const r = await healNodeKey({
    apiUrl: 'https://x',
    configPath: path.join(tmp(), 'config.json'),
    account: { token: 't', userId: 1 },
    fingerprint: undefined,
    fetchImpl: fakeFetch(200, { node: { id: 'n' } }),
    mergeConfig,
    log: quiet
  })
  assert.strictEqual(r.healed, false)
  assert.strictEqual(r.reason, 'no-key')
})

test('readAccount needs both a token and a positive user id', () => {
  const dir = tmp()
  const f = path.join(dir, '.env')
  fs.writeFileSync(f, '﻿IRIS_API_KEY=abc\nIRIS_USER_ID=193\n')
  assert.deepStrictEqual(readAccount(f), { token: 'abc', userId: 193 })
  fs.writeFileSync(f, 'IRIS_API_KEY=abc\nIRIS_USER_ID=0\n')
  assert.strictEqual(readAccount(f), null)
  assert.strictEqual(readAccount(path.join(dir, 'missing')), null)
})

test('the web-app host is never used as the node API', () => {
  assert.strictEqual(nodeApiUrl('https://app.heyiris.io'), 'https://freelabel.net')
  assert.strictEqual(nodeApiUrl(undefined), 'https://freelabel.net')
  assert.strictEqual(nodeApiUrl('https://freelabel.net'), 'https://freelabel.net')
  assert.strictEqual(nodeApiUrl('https://local.iris.freelabel.net'), 'https://local.iris.freelabel.net')
})
