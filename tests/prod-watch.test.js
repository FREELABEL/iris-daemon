'use strict'
const test = require('node:test')
const assert = require('node:assert')
const W = require('../daemon/prod-watch')

// The shape production actually returns (2026-10-12): permanently "degraded" because one key 400s.
const degraded = (gemini = 'http_400', openai = 'key_valid', db = 'connected') => ({
  timestamp: 'x', database: db, ai_openai: { status: openai }, ai_gemini: { status: gemini }, status: 'degraded',
})
const run = (prev, sample) => W.evaluate(prev, sample, { now: new Date('2026-10-12T00:00:00Z') })

test('a component bad on first sight is the baseline, not an incident', () => {
  const r = run(undefined, { http: 207, ms: 1200, body: degraded() })
  assert.deepStrictEqual(r.opened, [])
  assert.strictEqual(r.state.components.ai_gemini, 'http_400')
})

test('a healthy component going bad opens ONE incident, kept open without re-filing, then recovers', () => {
  let s = run(undefined, { http: 207, ms: 1200, body: degraded() }).state
  let r = run(s, { http: 207, ms: 1200, body: degraded('http_400', 'http_401') })
  assert.deepStrictEqual(r.opened.map((o) => o.key), ['component:ai_openai'])
  r = run(r.state, { http: 207, ms: 1200, body: degraded('http_400', 'http_401') })
  assert.deepStrictEqual(r.opened, [], 'an open incident is not re-filed')
  r = run(r.state, { http: 207, ms: 1200, body: degraded() })
  assert.deepStrictEqual(r.closed, ['component:ai_openai'])
})

test('the endpoint going down opens an http incident; nothing else closes while it is down', () => {
  let s = run(undefined, { http: 207, ms: 1200, body: degraded() }).state
  let r = run(s, { http: 503, ms: 300, body: null })
  assert.deepStrictEqual(r.opened.map((o) => o.key), ['http'])
  r = run(r.state, { http: null, ms: null, body: null })
  assert.deepStrictEqual(r.opened, [])
  r = run(r.state, { http: 207, ms: 1200, body: degraded() })
  assert.deepStrictEqual(r.closed, ['http'])
})

test('latency: one slow run is noise, two in a row is an incident, and slow runs do not move the baseline', () => {
  let s
  for (let i = 0; i < 6; i++) s = run(s, { http: 207, ms: 1000 + i * 10, body: degraded() }).state
  let r = run(s, { http: 207, ms: 9000, body: degraded() })
  assert.deepStrictEqual(r.opened, [], 'one slow run')
  assert.strictEqual(r.state.latencies.includes(9000), false)
  r = run(r.state, { http: 207, ms: 9500, body: degraded() })
  assert.deepStrictEqual(r.opened.map((o) => o.key), ['latency'])
  r = run(r.state, { http: 207, ms: 1010, body: degraded() })
  assert.deepStrictEqual(r.closed, ['latency'])
})

test('latency below the 3-second floor is never an incident, however it compares', () => {
  let s
  for (let i = 0; i < 6; i++) s = run(s, { http: 200, ms: 100, body: {} }).state
  s = run(s, { http: 200, ms: 900, body: {} }).state
  const r = run(s, { http: 200, ms: 950, body: {} })
  assert.deepStrictEqual(r.opened, [])
})
