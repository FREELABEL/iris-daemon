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
