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

// #192414: a confirmed DM moves the lead to Contacted, never backwards.
const { contactedStatusFor, markContacted } = require('../som/lead-outcome')

test('a confirmed send moves a lead before first contact to Contacted', () => {
  for (const s of ['Prospected', 'prospected', 'New', '', null, undefined, '  Prospected ']) {
    assert.strictEqual(contactedStatusFor('sent', s), 'Contacted', String(s))
  }
})

test('a lead already past first contact is never moved', () => {
  for (const s of ['Contacted', 'Responded', 'Qualified', 'Proposal', 'In Negotiation', 'Follow-Up', 'On Hold', 'Active', 'Partner', 'Won', 'Lost', 'Archived', 'Some Custom Stage']) {
    assert.strictEqual(contactedStatusFor('sent', s), null, s)
  }
})

test('only a confirmed send counts: unknown delivery, undeliverable, dry run and failures move nothing', () => {
  for (const o of ['delivered-unknown', 'undeliverable', 'dry-run', 'failed']) {
    assert.strictEqual(contactedStatusFor(o, 'Prospected'), null, o)
  }
})

function fakeApi (status, { readOk = true, writeOk = true } = {}) {
  const calls = []
  return {
    calls,
    async getLead (id) { calls.push(['get', id]); return readOk ? { success: true, data: { data: { id, status } } } : { success: false, message: 'HTTP 500' } },
    async updateLead (id, body) { calls.push(['put', id, body]); return { success: writeOk, message: writeOk ? '' : 'HTTP 422' } },
  }
}

test('markContacted re-reads the lead and writes only status: Contacted', async () => {
  const api = fakeApi('Prospected')
  const r = await markContacted(api, 30092, 'sent')
  assert.deepStrictEqual(r, { updated: true, from: 'Prospected', reason: '' })
  assert.deepStrictEqual(api.calls, [['get', 30092], ['put', 30092, { status: 'Contacted' }]])
})

test('markContacted leaves a lead that replied in the meantime alone', async () => {
  const api = fakeApi('Qualified')
  const r = await markContacted(api, 1, 'sent')
  assert.strictEqual(r.updated, false)
  assert.match(r.reason, /already past first contact \(Qualified\)/)
  assert.deepStrictEqual(api.calls, [['get', 1]])
})

test('markContacted writes nothing when it cannot read the lead, and never throws', async () => {
  const api = fakeApi('Prospected', { readOk: false })
  assert.strictEqual((await markContacted(api, 1, 'sent')).updated, false)
  assert.deepStrictEqual(api.calls, [['get', 1]])
  const boom = { async getLead () { throw new Error('socket hang up') }, async updateLead () { throw new Error('no') } }
  assert.deepStrictEqual(await markContacted(boom, 1, 'sent'), { updated: false, reason: 'socket hang up' })
})

test('markContacted does nothing for delivered-unknown', async () => {
  const api = fakeApi('Prospected')
  assert.strictEqual((await markContacted(api, 1, 'delivered-unknown')).updated, false)
  assert.deepStrictEqual(api.calls, [])
})

test('a failed write is reported, not hidden', async () => {
  const r = await markContacted(fakeApi('New', { writeOk: false }), 1, 'sent')
  assert.deepStrictEqual(r, { updated: false, from: 'New', reason: 'HTTP 422' })
})
