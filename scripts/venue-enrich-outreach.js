#!/usr/bin/env node
/**
 * venue-enrich-outreach.js — Enrich venues via Serper Places API + create leads with outreach.
 *
 * Usage:
 *   node venue-enrich-outreach.js city=Austin limit=10
 *   node venue-enrich-outreach.js city=Nashville limit=3 dry_run=1
 *   node venue-enrich-outreach.js city=Denver board_id=292 strategy_id=37
 *
 * Environment variables:
 *   CITY                  — City to enrich venues for (default: Austin)
 *   LIMIT                 — Max venues to process (default: 10)
 *   DRY_RUN               — If "1", log actions without writing (default: 0)
 *   BOARD_ID              — Lead board/bloq ID for creating leads
 *   STRATEGY_ID           — Outreach strategy template ID to apply (optional)
 *   SERPER_API_KEY        — Serper.dev API key (for places search + thumbnails)
 *   DELAY_MS              — Delay between API calls in ms (default: 3000)
 *   FL_API_URL            — fl-api base URL (default: https://raichu.heyiris.io)
 *   FL_RAICHU_API_TOKEN   — Auth token for fl-api (also resolves from
 *                           FL_API_TOKEN/IRIS_API_KEY, ~/.iris/sdk/.env, ~/.iris/config.json)
 */

const https = require('https')
const http = require('http')
const { URL } = require('url')
const { resolveIrisToken } = require('../lib/resolve-iris-token')

// ─── Parse CLI args ───────────────────────────────────────────
const params = {}
for (const arg of process.argv.slice(2)) {
  const eqIdx = arg.indexOf('=')
  if (eqIdx > 0) {
    params[arg.substring(0, eqIdx)] = arg.substring(eqIdx + 1)
  }
}

const CITY = params.city || process.env.CITY || 'Austin'
const LIMIT = parseInt(params.limit || process.env.LIMIT || '10', 10)
const DRY_RUN = (params.dry_run || process.env.DRY_RUN || '0') === '1'
const BOARD_ID = params.board_id || process.env.BOARD_ID || ''
const STRATEGY_ID = params.strategy_id || process.env.STRATEGY_ID || ''
const SERPER_API_KEY = params.serper_api_key || process.env.SERPER_API_KEY || 'ff1effc31b786e21d631c1bb8840072e7175a24a'
const DELAY_MS = parseInt(params.delay_ms || process.env.DELAY_MS || '3000', 10)
const API_URL = params.api_url || process.env.FL_API_URL || 'https://raichu.heyiris.io'
const API_TOKEN = resolveIrisToken({ override: params.api_token }).token || ''

const PREFIX = '[venue-enrich]'

if (!API_TOKEN) {
  console.error(`${PREFIX} Error: No API token. Set FL_RAICHU_API_TOKEN / FL_API_TOKEN / IRIS_API_KEY, run \`iris auth login\`, or pass api_token=...`)
  process.exit(1)
}

if (!SERPER_API_KEY) {
  console.error(`${PREFIX} Error: No Serper API key. Set SERPER_API_KEY or pass serper_api_key=...`)
  process.exit(1)
}

// ─── HTTP helper (zero dependencies) ──────────────────────────
function httpRequest (method, url, headers, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const lib = parsed.protocol === 'https:' ? https : http
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
      rejectUnauthorized: false
    }
    const req = lib.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.on('error', reject)
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')) })
    if (body) req.write(body)
    req.end()
  })
}

function delay (ms) { return new Promise(r => setTimeout(r, ms)) }

function apiHeaders () {
  return {
    Authorization: `Bearer ${API_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  }
}

// ─── Phase A: Fetch venues needing enrichment ─────────────────
async function fetchVenues () {
  const url = `${API_URL}/api/v1/venues?city=${encodeURIComponent(CITY)}&limit=${LIMIT}`
  console.log(`${PREFIX} Fetching venues: ${url}`)
  const resp = await httpRequest('GET', url, apiHeaders())
  if (resp.status !== 200) {
    throw new Error(`Failed to fetch venues: HTTP ${resp.status} — ${resp.body.substring(0, 200)}`)
  }
  const data = JSON.parse(resp.body)
  const venues = data.data?.data || data.data || data.venues || data || []
  if (!Array.isArray(venues)) throw new Error(`Unexpected response shape: ${Object.keys(data).join(',')}`)
  // Filter to venues missing enrichment (includes Unsplash placeholders as "no photo")
  return venues.filter(v => !v.google_place_id || !v.photo || (typeof v.photo === 'string' && v.photo.includes('unsplash.com')) || !v.description)
}

// ─── Phase B: Enrich via Serper (Places + Images) ─────────────
async function enrichViaSerper (venue) {
  const city = venue.city || CITY
  const state = venue.state || ''
  const locationStr = state ? `${city}, ${state}` : city
  const query = `${venue.name} in ${locationStr}`
  const headers = { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' }

  // Step 1: Serper Places — get address, rating, lat/lng, cid
  const placesResp = await httpRequest('POST', 'https://google.serper.dev/places', headers, JSON.stringify({
    q: query, location: locationStr, gl: 'us', hl: 'en'
  }))

  let place = null
  if (placesResp.status === 200) {
    const placesData = JSON.parse(placesResp.body)
    place = (placesData.places || [])[0] || null
  } else {
    console.warn(`${PREFIX}   Serper Places error for "${venue.name}": HTTP ${placesResp.status}`)
  }

  // Step 2: Serper Images — get a real photo of the venue
  await delay(1000) // small gap between calls
  const imgQuery = `"${venue.name}" ${city} venue`
  const imgResp = await httpRequest('POST', 'https://google.serper.dev/images', headers, JSON.stringify({
    q: imgQuery, gl: 'us', hl: 'en', num: 5
  }))

  const SKIP_DOMAINS = ['facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'linkedin.com', 'youtube.com', 'tiktok.com', 'pinterest.com']
  let photoUrl = null
  if (imgResp.status === 200) {
    const imgData = JSON.parse(imgResp.body)
    const images = imgData.images || []
    // Pick first valid image (skip tiny/social media)
    const valid = images.find(img => {
      if (!img.imageUrl) return false
      const url = img.imageUrl.toLowerCase()
      if (SKIP_DOMAINS.some(d => url.includes(d))) return false
      if (img.imageWidth && img.imageWidth < 300) return false
      if (img.imageHeight && img.imageHeight < 200) return false
      return true
    })
    photoUrl = valid ? valid.imageUrl : (images[0]?.imageUrl || images[0]?.thumbnailUrl || null)
  }

  // Collect all images for metadata
  let allImages = []
  if (imgResp.status === 200) {
    allImages = (JSON.parse(imgResp.body).images || []).map(img => ({
      url: img.imageUrl || null,
      thumbnail: img.thumbnailUrl || null,
      title: img.title || null,
      source: img.source || null,
      domain: img.domain || null,
      width: img.imageWidth || null,
      height: img.imageHeight || null
    }))
  }

  if (!place && !photoUrl) {
    console.warn(`${PREFIX}   No Serper data for "${venue.name}"`)
    return null
  }

  // Build metadata with everything Serper returned
  const metadata = {
    serper_place: place || null,
    serper_images: allImages,
    enriched_at: new Date().toISOString(),
    enrichment_source: 'serper'
  }

  return {
    google_place_id: place?.cid || place?.placeId || null,
    description: place?.description || null,
    phone: place?.phoneNumber || null,
    website_url: place?.website || null,
    photo: photoUrl,
    rating: place?.rating || null,
    rating_count: place?.ratingCount || null,
    studio_hours: place?.openingHours || null,
    latitude: place?.latitude || null,
    longitude: place?.longitude || null,
    metadata: JSON.stringify(metadata)
  }
}

// ─── Phase C: Update venue ────────────────────────────────────
async function updateVenue (venueId, enrichedData) {
  // Remove null values
  const payload = {}
  for (const [k, v] of Object.entries(enrichedData)) {
    if (v !== null && v !== undefined) payload[k] = v
  }

  if (Object.keys(payload).length === 0) return false

  const url = `${API_URL}/api/v1/venues/${venueId}`
  let resp = await httpRequest('PUT', url, apiHeaders(), JSON.stringify(payload))
  if (resp.status !== 200 && payload.google_place_id) {
    // Likely unique constraint on google_place_id — retry without it
    console.warn(`${PREFIX}   Retrying without google_place_id (likely duplicate CID)`)
    delete payload.google_place_id
    resp = await httpRequest('PUT', url, apiHeaders(), JSON.stringify(payload))
  }
  if (resp.status !== 200) {
    console.warn(`${PREFIX}   Failed to update venue ${venueId}: HTTP ${resp.status}`)
    return false
  }
  return true
}

// ─── Phase D: Create lead ─────────────────────────────────────
async function createLeadForVenue (venue, enrichedData) {
  if (!BOARD_ID) return null

  // Check if lead already exists
  const searchUrl = `${API_URL}/api/v1/leads?bloq_id=${BOARD_ID}&search=${encodeURIComponent(venue.name)}`
  const searchResp = await httpRequest('GET', searchUrl, apiHeaders())
  if (searchResp.status === 200) {
    const searchData = JSON.parse(searchResp.body)
    const existing = (searchData.data || searchData || [])
    if (existing.length > 0) {
      console.log(`${PREFIX}   Lead already exists for "${venue.name}" (ID: ${existing[0].id})`)
      return existing[0].id
    }
  }

  // Create new lead
  const leadPayload = {
    bloq_id: parseInt(BOARD_ID, 10),
    name: venue.name,
    email: venue.email || null,
    phone: enrichedData.phone || venue.phone || null,
    website: enrichedData.website_url || venue.website_url || null,
    custom_fields: {
      venue_id: venue.id,
      city: venue.city || CITY,
      type: venue.type || 'venue'
    }
  }

  const url = `${API_URL}/api/v1/leads`
  const resp = await httpRequest('POST', url, apiHeaders(), JSON.stringify(leadPayload))
  if (resp.status !== 200 && resp.status !== 201) {
    console.warn(`${PREFIX}   Failed to create lead for "${venue.name}": HTTP ${resp.status}`)
    return null
  }

  const leadData = JSON.parse(resp.body)
  const leadId = leadData.data?.id || leadData.id
  console.log(`${PREFIX}   Created lead #${leadId} for "${venue.name}"`)

  // Add note
  if (leadId) {
    const notePayload = { content: `Auto-created from venue enrichment. Google Place ID: ${enrichedData.google_place_id || 'N/A'}` }
    await httpRequest('POST', `${API_URL}/api/v1/leads/${leadId}/notes`, apiHeaders(), JSON.stringify(notePayload))
  }

  return leadId
}

// ─── Phase E: Apply outreach strategy ─────────────────────────
async function applyOutreach (leadId) {
  if (!STRATEGY_ID || !leadId) return

  const url = `${API_URL}/api/v1/outreach-strategy-templates/${STRATEGY_ID}/apply`
  const resp = await httpRequest('POST', url, apiHeaders(), JSON.stringify({ lead_id: leadId }))
  if (resp.status !== 200 && resp.status !== 201) {
    console.warn(`${PREFIX}   Failed to apply outreach strategy to lead #${leadId}: HTTP ${resp.status}`)
  } else {
    console.log(`${PREFIX}   Applied outreach strategy #${STRATEGY_ID} to lead #${leadId}`)
  }
}

// ─── Main pipeline ────────────────────────────────────────────
async function main () {
  console.log(`${PREFIX} Starting venue enrichment pipeline`)
  console.log(`${PREFIX}   City: ${CITY} | Limit: ${LIMIT} | Dry run: ${DRY_RUN}`)
  console.log(`${PREFIX}   Board ID: ${BOARD_ID || '(none)'} | Strategy: ${STRATEGY_ID || '(none)'}`)

  const venues = await fetchVenues()
  console.log(`${PREFIX} Found ${venues.length} venues needing enrichment`)

  if (venues.length === 0) {
    console.log(`${PREFIX} Nothing to do.`)
    return
  }

  let enriched = 0
  let leadsCreated = 0

  for (const venue of venues) {
    console.log(`${PREFIX} Processing: "${venue.name}" (ID: ${venue.id})`)

    // Phase B: Enrich
    const data = await enrichViaSerper(venue)
    if (!data) {
      await delay(DELAY_MS)
      continue
    }

    console.log(`${PREFIX}   Found: ${data.description ? data.description.substring(0, 60) + '...' : 'no description'} | photo: ${data.photo ? 'yes' : 'no'}`)

    if (DRY_RUN) {
      console.log(`${PREFIX}   [DRY RUN] Would update venue ${venue.id} and create lead`)
      await delay(DELAY_MS)
      continue
    }

    // Phase C: Update venue
    const updated = await updateVenue(venue.id, data)
    if (updated) enriched++

    // Phase D: Create lead
    const leadId = await createLeadForVenue(venue, data)
    if (leadId && typeof leadId === 'number') leadsCreated++

    // Phase E: Apply outreach
    await applyOutreach(leadId)

    await delay(DELAY_MS)
  }

  console.log(`${PREFIX} Done. Enriched: ${enriched} | Leads created: ${leadsCreated}`)
}

main().catch(err => {
  console.error(`${PREFIX} Fatal error:`, err.message)
  process.exit(1)
})
