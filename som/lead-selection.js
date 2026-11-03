// Where a SOM batch gets its leads from (#190296).
//
// The UI engine scans the board table and keeps only rows whose id is in the API's allow-list of
// eligible leads. The table and the API sort differently, so on a 6,000-lead board the allow-list
// can sit entirely past the ~300 rows the scan reaches: on 2026-10-21 the courses batch reported
// "3 fresh via API but not visible", sent nothing and raised a false "leads exhausted" alert.
// When that happens the batch opens those leads directly by id instead (API-direct).
function leadSource ({ mode, allowListSize, uiEligible, need = 1 }) {
  if (!allowListSize) return 'ui'
  if (mode === 'api') return 'api'
  // Fall back whenever the scan found FEWER than the batch needs, not only zero: on 2026-10-29 the
  // creators scan reached 300 rows, found 3 "eligible" (all had replied) and sent nothing while the
  // API held 7,691 fresh leads.
  return uiEligible < Math.min(need, allowListSize) ? 'api-fallback' : 'ui'
}

// The API's "no outreach" list still holds leads DM'd before outreach steps were tracked; the
// batch finds their [SOM DM] note and skips them. So fetch a wide pool, and count only sends and
// failures against the batch size: on 2026-10-22, limit=1 tried one such lead and sent nothing.
function candidateFetchSize (leadsToProcess) {
  return Math.min(Math.max(leadsToProcess * 10, 50), 500)
}

function directQuotaReached ({ sent, failed }, limit) {
  return sent + failed >= limit
}

// A wide pool is still not enough when most of a board was DM'd before step tracking: on
// 2026-10-22, 33 of the first 35 "no outreach" leads on courses had a [SOM DM] note (#190638).
// So when the batch runs out of candidates short of its limit it asks for the next page, up to
// a cap that keeps one run from walking the whole board.
const MAX_CANDIDATE_PAGES = 10

function shouldFetchNextPage ({ page, lastPage }, maxPages = MAX_CANDIDATE_PAGES) {
  return page < lastPage && page < maxPages
}

module.exports = { leadSource, candidateFetchSize, directQuotaReached, shouldFetchNextPage, MAX_CANDIDATE_PAGES }
