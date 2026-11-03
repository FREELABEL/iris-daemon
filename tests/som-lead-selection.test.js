// See som/lead-selection.js (#190296).
const test = require('node:test')
const assert = require('node:assert')
const { leadSource } = require('../som/lead-selection')

test('fresh API leads the UI scan cannot see are opened directly, not reported exhausted', () => {
  assert.strictEqual(leadSource({ mode: 'ui', allowListSize: 3, uiEligible: 0 }), 'api-fallback')
})

test('when the scan finds allow-listed rows the UI flow is kept', () => {
  assert.strictEqual(leadSource({ mode: 'ui', allowListSize: 45, uiEligible: 4 }), 'ui')
})

test('MODE=api always goes direct when the API returned leads', () => {
  assert.strictEqual(leadSource({ mode: 'api', allowListSize: 3, uiEligible: 0 }), 'api')
})

test('no allow-list means a plain UI scan (and a real exhausted board stays exhausted)', () => {
  assert.strictEqual(leadSource({ mode: 'ui', allowListSize: 0, uiEligible: 0 }), 'ui')
  assert.strictEqual(leadSource({ mode: 'api', allowListSize: 0, uiEligible: 0 }), 'ui')
})

// 2026-10-22: limit=1 fetched 3 candidates and tried exactly 1 — it had been DM'd 156 days ago
// (a [SOM DM] note older than outreach-step tracking), so the batch sent nothing.
const { candidateFetchSize, directQuotaReached } = require('../som/lead-selection')

test('API-direct fetches enough candidates to survive old-DM skips', () => {
  assert.ok(candidateFetchSize(1) >= 50)
  assert.strictEqual(candidateFetchSize(100), 500)
  assert.strictEqual(candidateFetchSize(1000), 500)
})

test('a skipped lead does not use up the batch quota; a send or a failure does', () => {
  assert.strictEqual(directQuotaReached({ sent: 0, failed: 0, skipped: 5 }, 1), false)
  assert.strictEqual(directQuotaReached({ sent: 1, failed: 0, skipped: 5 }, 1), true)
  assert.strictEqual(directQuotaReached({ sent: 1, failed: 1, skipped: 0 }, 2), true)
  assert.strictEqual(directQuotaReached({ sent: 0, failed: 0, skipped: 0 }, 0), true)
})

// 2026-10-22: 33 of the first 35 candidates on courses were old DMs (#190638).
const { shouldFetchNextPage, MAX_CANDIDATE_PAGES } = require('../som/lead-selection')

test('a batch short of its limit asks for the next page while the API has one', () => {
  assert.strictEqual(shouldFetchNextPage({ page: 1, lastPage: 173 }), true)
  assert.strictEqual(shouldFetchNextPage({ page: 3, lastPage: 3 }), false)
  assert.strictEqual(shouldFetchNextPage({ page: 1, lastPage: 1 }), false)
})

test('one run never pages past the cap, however big the board', () => {
  assert.strictEqual(shouldFetchNextPage({ page: MAX_CANDIDATE_PAGES, lastPage: 173 }), false)
  assert.strictEqual(shouldFetchNextPage({ page: 2, lastPage: 173 }, 2), false)
})

// 2026-10-29: the creators scan found 3 "eligible" rows (all had replied) out of 300 while the API held
// 7,691 fresh leads; the batch only fell back on ZERO and sent nothing. Fewer than needed must fall back.
test('falls back to the API when the scan finds fewer than the batch needs', () => {
  assert.strictEqual(leadSource({ allowListSize: 7691, uiEligible: 3, need: 25 }), 'api-fallback')
  assert.strictEqual(leadSource({ allowListSize: 7691, uiEligible: 30, need: 25 }), 'ui')
  assert.strictEqual(leadSource({ allowListSize: 2, uiEligible: 2, need: 25 }), 'ui')
})

// #192412: leads already marked undeliverable leave the candidate list.
const { dropUndeliverable } = require('../som/lead-selection')
const DAY = 24 * 3600 * 1000

test('a lead refused from this account is dropped; others are kept', () => {
  const leads = [
    { id: 1, custom_fields: { dm_undeliverable: { 'heyiris.io': { kind: 'refused', at: '2026-11-02T00:00:00Z' } } } },
    { id: 2, custom_fields: {} },
    { id: 3 },
  ]
  const r = dropUndeliverable(leads, 'heyiris.io')
  assert.deepStrictEqual(r.keep.map(l => l.id), [2, 3])
  assert.deepStrictEqual(r.dropped, [{ id: 1, code: 'undeliverable-this-account' }])
})

test('no route from this account: dropped for 14 days, then tried again', () => {
  const now = Date.parse('2026-11-03T12:00:00Z')
  const lead = at => ({ id: 9, custom_fields: { dm_undeliverable: { thediscoverpage_: { kind: 'no-route', at } } } })
  assert.strictEqual(dropUndeliverable([lead(new Date(now - 2 * DAY).toISOString())], 'thediscoverpage_', { now }).keep.length, 0)
  assert.strictEqual(dropUndeliverable([lead(new Date(now - 15 * DAY).toISOString())], 'thediscoverpage_', { now }).keep.length, 1)
})

test('refused from another account: dropped unless cross-account retry is on (and only one account refused)', () => {
  const one = { id: 4, custom_fields: { dm_undeliverable: { freelabelnet: { kind: 'refused', at: '2026-11-01T00:00:00Z' } } } }
  const two = { id: 5, custom_fields: { dm_undeliverable: { freelabelnet: { kind: 'refused' }, hourdemayo: { kind: 'refused' } } } }
  assert.deepStrictEqual(dropUndeliverable([one, two], 'heyiris.io').keep, [])
  assert.deepStrictEqual(dropUndeliverable([one, two], 'heyiris.io', { crossAccount: true }).keep.map(l => l.id), [4])
})

test('the DM Undeliverable tag alone drops a lead (marked by hand, no field)', () => {
  const tagged = { id: 6, tags: [{ id: 77, name: 'DM Undeliverable' }] }
  assert.deepStrictEqual(dropUndeliverable([tagged], 'heyiris.io').keep, [])
  assert.deepStrictEqual(dropUndeliverable([{ id: 7, tags: [{ id: 1, name: 'leadgen' }] }], 'heyiris.io').keep.map(l => l.id), [7])
})

test('rows without an id are ignored, and an empty or missing list is fine', () => {
  assert.deepStrictEqual(dropUndeliverable([null, {}, { id: 8 }], 'x').keep.map(l => l.id), [8])
  assert.deepStrictEqual(dropUndeliverable(undefined, 'x'), { keep: [], dropped: [] })
})
