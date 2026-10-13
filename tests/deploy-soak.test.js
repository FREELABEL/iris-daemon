'use strict'
const test = require('node:test')
const assert = require('node:assert')
const D = require('../daemon/deploy-soak')

// Measured shape 2026-10-12: overall "degraded" forever because one provider key answers 400.
const body = (o = {}) => ({ status: 'degraded', database: 'ok', redis: 'ok', openai: 'key_invalid', ...o })
const ok = (ms = 300, o) => ({ http: 200, ms, body: body(o) })
const down = { http: null, ms: null, body: null }

const baseline = [ok(280), ok(300), ok(320)].reduce((b, p) => D.updateBaseline(b, p), undefined)

test('the always-degraded component is baseline, not a failure', () => {
  assert.strictEqual(baseline.components.openai, 'key_invalid')
  assert.deepStrictEqual(D.soakVerdict(baseline, [ok(), ok(), ok()]), { verdict: 'PASS', reasons: [] })
})

test('a component healthy before the deploy and broken after it fails the soak', () => {
  const v = D.soakVerdict(baseline, [ok(), ok(300, { redis: 'error' }), ok(300, { redis: 'error' })])
  assert.strictEqual(v.verdict, 'FAIL')
  assert.match(v.reasons[0], /redis was ok before the deploy and is error after it/)
})

test('one blip does not fail it; three misses in a row do', () => {
  assert.strictEqual(D.soakVerdict(baseline, [ok(), down, ok(), down, ok()]).verdict, 'PASS')
  assert.strictEqual(D.soakVerdict(baseline, [ok(), ok(300, { redis: 'error' }), ok()]).verdict, 'PASS', 'recovered by the last probe')
  const v = D.soakVerdict(baseline, [ok(), down, down, down])
  assert.strictEqual(v.verdict, 'FAIL')
  assert.match(v.reasons[0], /3 probes in a row/)
})

test('latency: 3x the pre-deploy median and over 3 s fails; slower but under the floor does not', () => {
  assert.strictEqual(D.soakVerdict(baseline, [ok(4000), ok(4200), ok(3900)]).verdict, 'FAIL')
  assert.strictEqual(D.soakVerdict(baseline, [ok(1200), ok(1300), ok(1100)]).verdict, 'PASS')
})

test('a soak with no probes is a FAIL, not a silent PASS', () => {
  assert.strictEqual(D.soakVerdict(baseline, []).verdict, 'FAIL')
})

test('a probe that did not answer never moves the baseline', () => {
  assert.deepStrictEqual(D.updateBaseline(baseline, down), baseline)
})

test('deploy state comes from the status Railway posts for that service', () => {
  const st = [{ context: 'freelabel-eco - fl-api-worker', state: 'success' }, { context: 'freelabel-eco - fl-api', state: 'pending' }]
  assert.strictEqual(D.deployState(st, 'freelabel-eco - fl-api'), 'pending')
  assert.strictEqual(D.deployState(st, 'freelabel-eco - fl-iris-api'), 'unknown')
  assert.strictEqual(D.deployState([{ context: 'x', state: 'error' }], 'x'), 'failure')
})

test('next step: first sight is baseline; a new live SHA is soaked once; a deploying one waits', () => {
  assert.strictEqual(D.nextStep({}, { sha: 'a', state: 'success' }), 'baseline')
  assert.strictEqual(D.nextStep({ sha: 'a' }, { sha: 'a', state: 'success' }), 'baseline')
  assert.strictEqual(D.nextStep({ sha: 'a' }, { sha: 'b', state: 'pending' }), 'wait')
  assert.strictEqual(D.nextStep({ sha: 'a' }, { sha: 'b', state: 'success' }), 'soak')
  assert.strictEqual(D.nextStep({ sha: 'a', soaked: { b: 'FAIL' } }, { sha: 'b', state: 'success' }), 'baseline', 'a soaked SHA is never soaked twice')
  assert.strictEqual(D.nextStep({ sha: 'a' }, null), 'wait')
})
