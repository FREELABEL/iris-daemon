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
