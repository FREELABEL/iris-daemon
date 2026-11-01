// See som/lead-outcome.js (#191681).
const test = require('node:test')
const assert = require('node:assert')
const { leadOutcome, countsTowardDailyCap, timingStatus, undeliverableNote, outcomeLine } = require('../som/lead-outcome')

test('an account with no Message or Follow button is undeliverable, not sent', () => {
  const o = leadOutcome({ sent: false, undeliverableReason: 'no Message or Follow button' })
  assert.strictEqual(o, 'undeliverable')
  assert.strictEqual(countsTowardDailyCap(o), false)
  assert.strictEqual(timingStatus(o), 'undeliverable')
  assert.match(outcomeLine('@savvy_karan', o, '41.2', 'no Message or Follow button'), /^🚫 @savvy_karan undeliverable/)
  assert.doesNotMatch(outcomeLine('@savvy_karan', o, '41.2', 'x'), /✅/)
})

test('only a confirmed send is sent and counts toward the cap', () => {
  assert.strictEqual(leadOutcome({ sent: true }), 'sent')
  assert.strictEqual(countsTowardDailyCap('sent'), true)
  assert.strictEqual(outcomeLine('@a', 'sent', '30'), '✅ @a (30s)')
  // a send wins over a reason recorded earlier in the flow (e.g. the first path failed, PATH C worked)
  assert.strictEqual(leadOutcome({ sent: true, undeliverableReason: 'Message button did not open' }), 'sent')
})

test('nothing sent and no known reason is a failure', () => {
  const o = leadOutcome({})
  assert.strictEqual(o, 'failed')
  assert.strictEqual(countsTowardDailyCap(o), false)
  assert.strictEqual(timingStatus(o), 'fail')
  assert.match(outcomeLine('@b', o, '9'), /^❌/)
})

test('a dry run is reported as such and never counts toward the cap', () => {
  const o = leadOutcome({ dryRunTyped: true })
  assert.strictEqual(o, 'dry-run')
  assert.strictEqual(countsTowardDailyCap(o), false)
  assert.match(outcomeLine('@c', o, '5'), /dry run, not sent/)
})

test('the lead note names the account, the handle and the reason', () => {
  assert.strictEqual(
    undeliverableNote('heyiris.io', '@ballistic_shots_', 'no Message or Follow button'),
    '[SOM UNDELIVERABLE] cannot DM @ballistic_shots_ from @heyiris.io: no Message or Follow button'
  )
})

test('#192164: unknown is neither sent nor undeliverable, and counts toward the cap because it may be real', () => {
  const o = leadOutcome({ deliveredUnknownReason: 'could not read the thread back' })
  assert.strictEqual(o, 'delivered-unknown')
  assert.strictEqual(countsTowardDailyCap(o), true)
  assert.strictEqual(timingStatus(o), 'delivered-unknown')
  assert.match(outcomeLine('@a', o, '30', 'x'), /^❓/)
  assert.strictEqual(countsTowardDailyCap('undeliverable'), false)
  // a refusal and a confirmed send still win their own
  assert.strictEqual(leadOutcome({ sent: true, deliveredUnknownReason: 'x' }), 'sent')
})
