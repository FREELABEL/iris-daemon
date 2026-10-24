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
