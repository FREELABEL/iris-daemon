#!/usr/bin/env node
/**
 * social-feed-sync.js — Fetch Instagram feed from residential IP and seed to fl-api.
 *
 * Usage:
 *   node social-feed-sync.js <profile-slug> [key=value ...]
 *   node social-feed-sync.js moore-life
 *   node social-feed-sync.js moore-life,other-profile
 *   node social-feed-sync.js --auto                          # Auto-discover profiles from marketplace
 *   node social-feed-sync.js --auto max_profiles=20
 *   node social-feed-sync.js moore-life api_url=http://localhost:8000
 *
 * Environment variables:
 *   FL_API_URL            — fl-api base URL (default: https://apiv2.heyiris.io)
 *   FL_RAICHU_API_TOKEN   — Auth token for fl-api
 */

const https = require('https')
const http = require('http')
const { URL } = require('url')

// ─── Parse CLI args ───────────────────────────────────────────
const args = process.argv.slice(2)
const profileArg = args[0]

const params = {}
for (const arg of args) {
  const eqIdx = arg.indexOf('=')
  if (eqIdx > 0) {
    params[arg.substring(0, eqIdx)] = arg.substring(eqIdx + 1)
  }
}

const AUTO_MODE = profileArg === '--auto'

if (!profileArg) {
  console.error('Usage: node social-feed-sync.js <profile-slug|--auto> [key=value ...]')
  process.exit(1)
}

const API_URL = params.api_url || process.env.FL_API_URL || 'https://apiv2.heyiris.io'
const API_TOKEN = params.api_token || process.env.FL_RAICHU_API_TOKEN
const MAX_POSTS = parseInt(params.max_posts || '9', 10)
const MAX_PROFILES = parseInt(params.max_profiles || '50', 10)
const DELAY_MS = parseInt(params.delay_ms || '2000', 10) // delay between IG requests to avoid rate-limit

if (!API_TOKEN) {
  console.error('[social-feed-sync] Error: No API token. Set FL_RAICHU_API_TOKEN or pass api_token=...')
  process.exit(1)
}

// ─── Instagram API headers (same as SocialMediaFeedService) ───
const IG_HEADERS = {
  'User-Agent': 'Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 458229258)',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'X-IG-App-ID': '936619743392459',
  'X-ASBD-ID': '129477',
  'X-IG-WWW-Claim': '0',
  'X-Requested-With': 'XMLHttpRequest'
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
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }))
    })
    req.on('error', reject)
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')) })
    if (body) req.write(body)
    req.end()
  })
}

// ─── Fetch + transform Instagram data ─────────────────────────
async function fetchInstagramFeed (username) {
  const igUrl = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`
  const resp = await httpRequest('GET', igUrl, IG_HEADERS)

  if (resp.status !== 200) {
    throw new Error(`Instagram API returned ${resp.status} for @${username}`)
  }

  const igData = JSON.parse(resp.body)
  if ((igData.status || '') !== 'ok' || !igData.data?.user) {
    throw new Error(`Instagram API response invalid for @${username}`)
  }

  const user = igData.data.user

  const stats = {
    posts: user.edge_owner_to_timeline_media?.count || 0,
    followers: user.edge_followed_by?.count || 0,
    following: user.edge_follow?.count || 0,
    full_name: user.full_name || username,
    profile_pic: user.profile_pic_url_hd || user.profile_pic_url || null,
    is_private: user.is_private || false,
    username
  }

  const posts = []
  const edges = (user.edge_owner_to_timeline_media?.edges || []).slice(0, MAX_POSTS)

  for (const edge of edges) {
    const node = edge.node || {}
    let caption = ''
    const captionEdges = node.edge_media_to_caption?.edges || []
    if (captionEdges.length > 0) {
      caption = captionEdges[0]?.node?.text || ''
    }
    posts.push({
      id: node.id || null,
      shortcode: node.shortcode || null,
      thumbnail_url: node.thumbnail_src || node.display_url || null,
      display_url: node.display_url || null,
      is_video: node.is_video || false,
      caption,
      likes: node.edge_liked_by?.count || node.edge_media_preview_like?.count || 0,
      comments: node.edge_media_to_comment?.count || 0,
      timestamp: node.taken_at_timestamp || null,
      link: node.shortcode ? `https://instagram.com/p/${node.shortcode}/` : null
    })
  }

  return { stats, posts }
}

// ─── Resolve profile slug → Instagram username ───────────────
async function resolveInstagramHandle (slug) {
  const profileUrl = `${API_URL}/api/v1/profile/${slug}`
  const resp = await httpRequest('GET', profileUrl, { Accept: 'application/json' })
  if (resp.status !== 200) return null
  try {
    const data = JSON.parse(resp.body)
    const ig = (data.data?.instagram || '').replace(/^@/, '').trim()
    return ig || null
  } catch { return null }
}

// ─── Seed to fl-api ───────────────────────────────────────────
async function seedToApi (profileSlug, feedData) {
  const seedUrl = `${API_URL}/api/v1/profile/${profileSlug}/social-feed`
  const payload = JSON.stringify({ instagram: feedData })

  const resp = await httpRequest('POST', seedUrl, {
    Authorization: `Bearer ${API_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }, payload)

  if (resp.status >= 200 && resp.status < 300) {
    return JSON.parse(resp.body)
  }
  throw new Error(`Seed failed: HTTP ${resp.status} — ${resp.body.substring(0, 200)}`)
}

// ─── Auto-discover profiles from fl-api marketplace ─────────
async function discoverProfiles () {
  console.log(`[social-feed-sync] Auto-discovering profiles from ${API_URL}...`)
  const url = `${API_URL}/api/v1/profile?limit=${MAX_PROFILES}&sortBy=best_match`
  const resp = await httpRequest('GET', url, {
    Accept: 'application/json',
    Authorization: `Bearer ${API_TOKEN}`
  })
  if (resp.status !== 200) {
    throw new Error(`Marketplace API returned ${resp.status}`)
  }
  const json = JSON.parse(resp.body)
  const profiles = json.data || json
  if (!Array.isArray(profiles)) {
    throw new Error('Unexpected marketplace response format')
  }

  // Count how many profiles share each IG handle (duplicates = junk data)
  const handleCount = {}
  for (const p of profiles) {
    const ig = (p.instagram || '').replace(/^@/, '').trim().toLowerCase()
    if (ig) handleCount[ig] = (handleCount[ig] || 0) + 1
  }

  // Filter to profiles with real, unique Instagram handles
  const seen = new Set()
  const candidates = []
  for (const p of profiles) {
    const ig = (p.instagram || '').replace(/^@/, '').trim()
    const igLower = ig.toLowerCase()
    const slug = p.id || ''
    if (!ig || !slug || seen.has(igLower)) continue
    // Skip handles used by multiple profiles (placeholder/junk data)
    if ((handleCount[igLower] || 0) > 1) {
      console.log(`[social-feed-sync] Skipping @${ig} — shared by ${handleCount[igLower]} profiles (likely placeholder)`)
      seen.add(igLower)
      continue
    }
    seen.add(igLower)
    candidates.push({
      slug,
      instagram: ig,
      hasPhoto: !!p.photo,
      updatedAt: p.updated_at || ''
    })
  }

  console.log(`[social-feed-sync] Found ${candidates.length} profiles with unique Instagram handles out of ${profiles.length} total`)
  return candidates.map(c => c.slug)
}

// ─── Delay helper (avoid Instagram rate limiting) ────────────
function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─── Main ─────────────────────────────────────────────────────
async function main () {
  let slugs
  if (AUTO_MODE) {
    slugs = await discoverProfiles()
    if (slugs.length === 0) {
      console.log('[social-feed-sync] No profiles with Instagram handles found. Done.')
      process.exit(0)
    }
  } else {
    slugs = profileArg.split(',').map(s => s.trim()).filter(Boolean)
  }

  console.log(`[social-feed-sync] Syncing ${slugs.length} profile(s): ${slugs.join(', ')}`)
  console.log(`[social-feed-sync] API: ${API_URL}`)

  let success = 0
  let failed = 0

  for (const slug of slugs) {
    try {
      // Resolve profile slug → Instagram handle via fl-api
      let igHandle = slug
      console.log(`\n[social-feed-sync] Resolving profile "${slug}"...`)
      const resolved = await resolveInstagramHandle(slug)
      if (resolved) {
        igHandle = resolved
        console.log(`[social-feed-sync] Instagram handle: @${igHandle}`)
      } else {
        console.log(`[social-feed-sync] Could not resolve profile, using "${slug}" as Instagram username`)
      }

      console.log(`[social-feed-sync] Fetching @${igHandle} from Instagram...`)
      const feedData = await fetchInstagramFeed(igHandle)
      console.log(`[social-feed-sync] Got ${feedData.posts.length} posts, ${feedData.stats.followers} followers`)

      console.log(`[social-feed-sync] Seeding to ${API_URL}...`)
      const result = await seedToApi(slug, feedData)
      console.log(`[social-feed-sync] OK: @${slug} seeded (${feedData.posts.length} posts)`)
      success++
    } catch (err) {
      console.error(`[social-feed-sync] FAILED @${slug}: ${err.message}`)
      failed++
    }

    // Delay between profiles to avoid Instagram rate limiting
    if (slugs.length > 1 && slug !== slugs[slugs.length - 1]) {
      console.log(`[social-feed-sync] Waiting ${DELAY_MS}ms before next profile...`)
      await delay(DELAY_MS)
    }
  }

  console.log(`\n[social-feed-sync] Done: ${success} synced, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`[social-feed-sync] Fatal: ${err.message}`)
  process.exit(1)
})
