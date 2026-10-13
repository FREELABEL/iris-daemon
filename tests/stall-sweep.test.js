'use strict'
const test = require('node:test')
const assert = require('node:assert')
const S = require('../daemon/stall-sweep')

const NOW = Date.parse('2026-10-13T12:00:00Z')
const ago = (min) => new Date(NOW - min * 60000).toISOString()
const sess = (id, o = {}) => ({ session_id: id, node: 'n1', label: id, status: 'idle', updated_at: ago(120), waiting: null, claim: null, ...o })

test('unclaimed idle sessions are finished conversations: never touched', () => {
  const { actions } = S.decide([sess('a'), sess('b', { updated_at: ago(60 * 48), status: 'stale' })], {}, { now: NOW })
  assert.deepStrictEqual(actions, [])
})

test('a session waiting on a person is reported once per question, not every run', () => {
  const w = { questions: [{ question: 'Which layout?' }] }
  let r = S.decide([sess('a', { waiting: w, claim: { assignee: 'alex' } })], {}, { now: NOW })
  assert.deepStrictEqual(r.actions.map((x) => [x.kind, x.to]), [['needs_you', 'alex']])
  r = S.decide([sess('a', { waiting: w })], r.state, { now: NOW + 600000 })
  assert.deepStrictEqual(r.actions, [], 'same question, second run: silent')
  r = S.decide([sess('a', { waiting: { questions: [{ question: 'Ship it?' }] } })], r.state, { now: NOW + 1200000 })
  assert.strictEqual(r.actions.length, 1, 'a NEW question is reported')
})

test('claimed and quiet: one nudge, ever — then one cold report a day later', () => {
  const s = sess('a', { claim: { assignee: 'alex' }, updated_at: ago(45) })
  let r = S.decide([s], {}, { now: NOW })
  assert.deepStrictEqual(r.actions.map((x) => x.kind), ['nudge'])
  assert.match(r.actions[0].message, /FINAL/)
  r = S.decide([s], r.state, { now: NOW + 600000 })
  assert.deepStrictEqual(r.actions, [], 'no second nudge')
  r = S.decide([s], r.state, { now: NOW + S.COLD_MS + 1000 })
  assert.deepStrictEqual(r.actions.map((x) => x.kind), ['gone_cold'])
  r = S.decide([s], r.state, { now: NOW + 2 * S.COLD_MS })
  assert.deepStrictEqual(r.actions, [], 'cold is reported once')
})

test('claimed but recently active, or answering after the nudge: left alone', () => {
  assert.deepStrictEqual(S.decide([sess('a', { claim: { assignee: 'x' }, updated_at: ago(5) })], {}, { now: NOW }).actions, [])
  let r = S.decide([sess('a', { claim: { assignee: 'x' }, updated_at: ago(45) })], {}, { now: NOW })
  // it replied to the nudge (touched after it), then went quiet again
  r = S.decide([sess('a', { claim: { assignee: 'x' }, updated_at: new Date(NOW + 60000).toISOString() })], r.state, { now: NOW + S.COLD_MS + 5000 })
  assert.deepStrictEqual(r.actions, [], 'it answered — not cold')
})

test('sessions that disappear are forgotten, so the state cannot grow forever', () => {
  const r = S.decide([sess('a', { claim: { assignee: 'x' } })], {}, { now: NOW })
  assert.ok(r.state.nudged.a)
  assert.deepStrictEqual(S.decide([], r.state, { now: NOW }).state, { nudged: {}, told: {} })
})

test('measured fleet shape: 94 sessions, none claimed or waiting → zero actions', () => {
  const fleet = Array.from({ length: 94 }, (_, i) => sess(`s${i}`, { status: i < 25 ? 'active' : 'idle', updated_at: ago(i < 25 ? 5 : 300) }))
  assert.deepStrictEqual(S.decide(fleet, {}, { now: NOW }).actions, [])
})
