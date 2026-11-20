'use strict'
// #189649 — a production node must have somewhere to go when its API host stops answering.
const { test } = require('node:test')
const assert = require('node:assert')
const { defaultFallback, resolveFallback } = require('../lib/api-fallback')

const PROD = 'https://freelabel.net'

test('production on freelabel.net falls back to heyiris.io (the 2026-10-15 outage)', () => {
  assert.strictEqual(resolveFallback({ mode: 'production', apiUrl: 'https://freelabel.net', productionUrl: PROD }), 'https://heyiris.io')
})

test('and the other way round', () => {
  assert.strictEqual(resolveFallback({ mode: 'production', apiUrl: 'https://heyiris.io/', productionUrl: PROD }), 'https://freelabel.net')
})

test('an explicit fallback (flag, env or config) always wins', () => {
  assert.strictEqual(resolveFallback({ explicit: 'https://x.example', mode: 'production', apiUrl: PROD, productionUrl: PROD }), 'https://x.example')
})

test('local mode keeps falling back to production, as before', () => {
  assert.strictEqual(resolveFallback({ mode: 'local', apiUrl: 'https://local.iris.freelabel.net', productionUrl: PROD }), PROD)
})

test('a custom host gets NO invented fallback — a node key must not go somewhere unconfigured', () => {
  assert.strictEqual(defaultFallback('https://api.client.example'), null)
  assert.strictEqual(resolveFallback({ mode: 'production', apiUrl: 'https://api.client.example', productionUrl: PROD }), null)
})

test('garbage in, null out', () => {
  assert.strictEqual(defaultFallback(''), null)
  assert.strictEqual(defaultFallback(undefined), null)
  assert.strictEqual(defaultFallback('not a url'), null)
})

test('daemon.js actually wires it in (the module alone fixes nothing)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'daemon.js'), 'utf8')
  assert.match(src, /require\('\.\/lib\/api-fallback'\)/)
  assert.match(src, /apiUrlFallback:\s*resolveFallback\(/)
})
