// Where a SOM batch gets its leads from (#190296).
//
// The UI engine scans the board table and keeps only rows whose id is in the API's allow-list of
// eligible leads. The table and the API sort differently, so on a 6,000-lead board the allow-list
// can sit entirely past the ~300 rows the scan reaches: on 2026-10-21 the courses batch reported
// "3 fresh via API but not visible", sent nothing and raised a false "leads exhausted" alert.
// When that happens the batch opens those leads directly by id instead (API-direct).
function leadSource ({ mode, allowListSize, uiEligible }) {
  if (!allowListSize) return 'ui'
  if (mode === 'api') return 'api'
  return uiEligible === 0 ? 'api-fallback' : 'ui'
}

module.exports = { leadSource }
