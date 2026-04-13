#!/usr/bin/env node
/**
 * social-stats-sync.js — Fetch social stats from ALL platforms via Hive (residential IP)
 * and seed to fl-api's multi-platform endpoint.
 *
 * Usage:
 *   node social-stats-sync.js <profile-slug>
 *   node social-stats-sync.js moore-life,BigSean,JayyRose
 *   node social-stats-sync.js --auto                        # Auto-discover from marketplace
 *   node social-stats-sync.js moore-life --platforms=instagram,twitter
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
const profileArg = args.find(a => !a.startsWith('--') && !a.includes('='))
const params = {}
for (const arg of args) {
  if (arg.startsWith('--')) {
    const [key, val] = arg.substring(2).split('=')
    params[key] = val || 'true'
  } else {
    const eqIdx = arg.indexOf('=')
    if (eqIdx > 0) params[arg.substring(0, eqIdx)] = arg.substring(eqIdx + 1)
  }
}

const AUTO_MODE = profileArg === '--auto' || args.includes('--auto')
const PLATFORMS = (params.platforms || 'instagram,twitter,tiktok,youtube,spotify,soundcloud').split(',').map(s => s.trim())

if (!profileArg && !AUTO_MODE) {
  console.error('Usage: node social-stats-sync.js <profile-slug|--auto> [--platforms=instagram,twitter]')
  process.exit(1)
}

const API_URL = params.api_url || process.env.FL_API_URL || 'https://apiv2.heyiris.io'
const API_TOKEN = params.api_token || process.env.FL_RAICHU_API_TOKEN
const MAX_PROFILES = parseInt(params.max_profiles || '50', 10)
const DELAY_MS = parseInt(params.delay_ms || '2000', 10)

if (!API_TOKEN) {
  console.error('[stats-sync] Error: No API token. Set FL_RAICHU_API_TOKEN or pass api_token=...')
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
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }))
    })
    req.on('error', reject)
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')) })
    if (body) req.write(body)
    req.end()
  })
}

function delay (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

// ─── Instagram ────────────────────────────────────────────────
const IG_HEADERS = {
  'User-Agent': 'Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 458229258)',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'X-IG-App-ID': '936619743392459',
  'X-ASBD-ID': '129477',
  'X-IG-WWW-Claim': '0',
  'X-Requested-With': 'XMLHttpRequest'
}

async function fetchInstagram (username) {
  if (!username) return null
  const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`
  const resp = await httpRequest('GET', url, IG_HEADERS)
  if (resp.status !== 200) throw new Error(`Instagram ${resp.status} for @${username}`)
  const data = JSON.parse(resp.body)
  if (data.status !== 'ok' || !data.data?.user) throw new Error(`Instagram invalid response for @${username}`)
  const user = data.data.user
  const posts = (user.edge_owner_to_timeline_media?.edges || []).slice(0, 9).map(e => {
    const n = e.node || {}
    return {
      id: n.id, shortcode: n.shortcode,
      thumbnail_url: n.thumbnail_src || n.display_url,
      display_url: n.display_url, is_video: n.is_video || false,
      caption: (n.edge_media_to_caption?.edges?.[0]?.node?.text || ''),
      likes: n.edge_liked_by?.count || n.edge_media_preview_like?.count || 0,
      comments: n.edge_media_to_comment?.count || 0,
      timestamp: n.taken_at_timestamp,
      link: n.shortcode ? `https://instagram.com/p/${n.shortcode}/` : null
    }
  })
  return {
    stats: {
      username, followers: user.edge_followed_by?.count || 0,
      following: user.edge_follow?.count || 0,
      posts: user.edge_owner_to_timeline_media?.count || 0,
      full_name: user.full_name || username,
      profile_pic: user.profile_pic_url_hd || user.profile_pic_url || null,
      is_private: user.is_private || false
    },
    posts,
    followers: user.edge_followed_by?.count || 0
  }
}

// ─── Twitter/X (public profile scrape) ────────────────────────
async function fetchTwitter (handle) {
  if (!handle) return null
  handle = handle.replace(/^@/, '')
  // Use nitter or syndication endpoint for public data
  const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${handle}`
  try {
    const resp = await httpRequest('GET', url, {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      Accept: 'text/html,application/xhtml+xml'
    })
    if (resp.status !== 200) {
      console.log(`[stats-sync] Twitter syndication ${resp.status} for @${handle}, trying API fallback...`)
      return await fetchTwitterFallback(handle)
    }
    // Parse follower count from HTML
    const html = resp.body
    const followerMatch = html.match(/(\d[\d,.]*)\s*Follower/i)
    const followingMatch = html.match(/(\d[\d,.]*)\s*Following/i)
    const tweetMatch = html.match(/(\d[\d,.]*)\s*(?:Tweet|Post)/i)
    const parseCount = (m) => m ? parseInt(m[1].replace(/[,.\s]/g, ''), 10) : 0
    return {
      username: handle,
      followers: parseCount(followerMatch),
      following: parseCount(followingMatch),
      tweets: parseCount(tweetMatch)
    }
  } catch (err) {
    console.log(`[stats-sync] Twitter scrape failed: ${err.message}`)
    return await fetchTwitterFallback(handle)
  }
}

async function fetchTwitterFallback (handle) {
  // Try user lookup via public embed endpoint
  try {
    const url = `https://publish.twitter.com/oembed?url=https://twitter.com/${handle}`
    const resp = await httpRequest('GET', url, { Accept: 'application/json' })
    if (resp.status === 200) {
      const data = JSON.parse(resp.body)
      return { username: handle, author_name: data.author_name || handle, followers: 0, following: 0, tweets: 0 }
    }
  } catch {}
  return null
}

// ─── TikTok (public profile scrape) ──────────────────────────
async function fetchTikTok (handle) {
  if (!handle) return null
  handle = handle.replace(/^@/, '')
  try {
    const url = `https://www.tiktok.com/@${handle}`
    const resp = await httpRequest('GET', url, {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9'
    })
    if (resp.status !== 200) return null
    // Parse from __UNIVERSAL_DATA_FOR_REHYDRATION__ or meta tags
    const html = resp.body
    const jsonMatch = html.match(/"stats"\s*:\s*\{[^}]+\}/)
    if (jsonMatch) {
      try {
        const statsStr = jsonMatch[0].replace(/"stats"\s*:\s*/, '')
        const stats = JSON.parse(statsStr)
        return {
          username: handle,
          followers: stats.followerCount || 0,
          following: stats.followingCount || 0,
          likes: stats.heartCount || stats.heart || 0,
          videos: stats.videoCount || 0
        }
      } catch {}
    }
    // Fallback: parse meta tags
    const followerMeta = html.match(/followerCount['":\s]+(\d+)/)
    const likeMeta = html.match(/heartCount['":\s]+(\d+)/)
    if (followerMeta) {
      return {
        username: handle,
        followers: parseInt(followerMeta[1], 10),
        likes: likeMeta ? parseInt(likeMeta[1], 10) : 0,
        following: 0, videos: 0
      }
    }
    return null
  } catch (err) {
    console.log(`[stats-sync] TikTok scrape failed: ${err.message}`)
    return null
  }
}

// ─── YouTube (Data API v3 — free tier) ───────────────────────
async function fetchYouTube (channelIdentifier) {
  if (!channelIdentifier) return null
  // Support channel ID, handle (@name), or custom URL
  const YOUTUBE_KEY = process.env.YOUTUBE_API_KEY
  if (!YOUTUBE_KEY) {
    console.log('[stats-sync] No YOUTUBE_API_KEY, skipping YouTube')
    return null
  }
  let url
  if (channelIdentifier.startsWith('UC')) {
    url = `https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=${channelIdentifier}&key=${YOUTUBE_KEY}`
  } else {
    // Try as handle
    const handle = channelIdentifier.replace(/^@/, '')
    url = `https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&forHandle=${handle}&key=${YOUTUBE_KEY}`
  }
  try {
    const resp = await httpRequest('GET', url, { Accept: 'application/json' })
    if (resp.status !== 200) return null
    const data = JSON.parse(resp.body)
    const ch = data.items?.[0]
    if (!ch) return null
    return {
      username: ch.snippet?.customUrl || ch.snippet?.title || channelIdentifier,
      subscribers: parseInt(ch.statistics?.subscriberCount || '0', 10),
      total_views: parseInt(ch.statistics?.viewCount || '0', 10),
      videos: parseInt(ch.statistics?.videoCount || '0', 10)
    }
  } catch (err) {
    console.log(`[stats-sync] YouTube API failed: ${err.message}`)
    return null
  }
}

// ─── Spotify (Web API) ────────────────────────────────────────
async function fetchSpotify (artistId) {
  if (!artistId) return null
  const SPOTIFY_TOKEN = process.env.SPOTIFY_ACCESS_TOKEN
  if (!SPOTIFY_TOKEN) {
    console.log('[stats-sync] No SPOTIFY_ACCESS_TOKEN, skipping Spotify')
    return null
  }
  try {
    const url = `https://api.spotify.com/v1/artists/${artistId}`
    const resp = await httpRequest('GET', url, {
      Authorization: `Bearer ${SPOTIFY_TOKEN}`,
      Accept: 'application/json'
    })
    if (resp.status !== 200) return null
    const data = JSON.parse(resp.body)
    return {
      username: data.name || artistId,
      followers: data.followers?.total || 0,
      popularity: data.popularity || 0,
      genres: data.genres || []
    }
  } catch (err) {
    console.log(`[stats-sync] Spotify API failed: ${err.message}`)
    return null
  }
}

// ─── SoundCloud (public scrape) ──────────────────────────────
async function fetchSoundCloud (handle) {
  if (!handle) return null
  try {
    const url = `https://soundcloud.com/${handle}`
    const resp = await httpRequest('GET', url, {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      Accept: 'text/html'
    })
    if (resp.status !== 200) return null
    const html = resp.body
    const followerMatch = html.match(/"followers_count"\s*:\s*(\d+)/)
    const trackMatch = html.match(/"track_count"\s*:\s*(\d+)/)
    if (followerMatch) {
      return {
        username: handle,
        followers: parseInt(followerMatch[1], 10),
        tracks: trackMatch ? parseInt(trackMatch[1], 10) : 0
      }
    }
    return null
  } catch (err) {
    console.log(`[stats-sync] SoundCloud scrape failed: ${err.message}`)
    return null
  }
}

// ─── Resolve profile handles from fl-api ─────────────────────
async function resolveProfileHandles (slug) {
  const url = `${API_URL}/api/v1/profile/${slug}`
  const resp = await httpRequest('GET', url, { Accept: 'application/json' })
  if (resp.status !== 200) return {}
  const data = JSON.parse(resp.body)
  const p = data.data || data
  return {
    instagram: (p.instagram || '').replace(/^@/, '').trim() || null,
    twitter: (p.twitter || '').replace(/^@/, '').trim() || null,
    tiktok: (p.tiktok || '').replace(/^@/, '').trim() || null,
    youtube: p.youtube_channel_id || (p.youtube || '').trim() || null,
    spotify: p.spotify_id || (p.spotify || '').trim() || null,
    soundcloud: (p.soundcloud || '').trim() || null,
    pk: p.pk || null
  }
}

// ─── Seed all stats to fl-api ────────────────────────────────
async function seedStats (profileSlug, allStats) {
  const seedUrl = `${API_URL}/api/v1/profile/${profileSlug}/social-stats`
  const payload = JSON.stringify(allStats)
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

// ─── Auto-discover profiles ──────────────────────────────────
async function discoverProfiles () {
  console.log(`[stats-sync] Auto-discovering profiles from ${API_URL}...`)
  const url = `${API_URL}/api/v1/profile?limit=${MAX_PROFILES}&sortBy=best_match`
  const resp = await httpRequest('GET', url, {
    Accept: 'application/json',
    Authorization: `Bearer ${API_TOKEN}`
  })
  if (resp.status !== 200) throw new Error(`Marketplace API returned ${resp.status}`)
  const json = JSON.parse(resp.body)
  const profiles = json.data || json
  if (!Array.isArray(profiles)) throw new Error('Unexpected response format')
  // Return slugs that have at least one social handle
  return profiles
    .filter(p => p.instagram || p.twitter || p.tiktok || p.youtube_channel_id || p.youtube || p.spotify_id || p.spotify || p.soundcloud)
    .map(p => p.id)
    .filter(Boolean)
    .slice(0, MAX_PROFILES)
}

// ─── Main ─────────────────────────────────────────────────────
async function main () {
  let slugs
  if (AUTO_MODE) {
    slugs = await discoverProfiles()
    if (slugs.length === 0) {
      console.log('[stats-sync] No profiles with social handles found. Done.')
      process.exit(0)
    }
  } else {
    slugs = profileArg.split(',').map(s => s.trim()).filter(Boolean)
  }

  console.log(`[stats-sync] Syncing ${slugs.length} profile(s): ${slugs.slice(0, 10).join(', ')}${slugs.length > 10 ? '...' : ''}`)
  console.log(`[stats-sync] Platforms: ${PLATFORMS.join(', ')}`)
  console.log(`[stats-sync] API: ${API_URL}`)

  let success = 0; let failed = 0

  for (const slug of slugs) {
    try {
      console.log(`\n[stats-sync] ── ${slug} ──`)
      const handles = await resolveProfileHandles(slug)
      console.log(`[stats-sync] Handles: ${JSON.stringify(handles)}`)

      const allStats = {}
      let totalFollowers = 0

      // Instagram
      if (PLATFORMS.includes('instagram') && handles.instagram) {
        try {
          console.log(`[stats-sync]   Instagram @${handles.instagram}...`)
          const ig = await fetchInstagram(handles.instagram)
          if (ig) {
            allStats.instagram = ig
            totalFollowers += ig.followers || 0
            console.log(`[stats-sync]   ✓ Instagram: ${ig.followers} followers, ${ig.posts?.length || 0} posts`)
          }
        } catch (err) { console.log(`[stats-sync]   ✗ Instagram: ${err.message}`) }
        await delay(1000)
      }

      // Twitter
      if (PLATFORMS.includes('twitter') && handles.twitter) {
        try {
          console.log(`[stats-sync]   Twitter @${handles.twitter}...`)
          const tw = await fetchTwitter(handles.twitter)
          if (tw) {
            allStats.twitter = tw
            totalFollowers += tw.followers || 0
            console.log(`[stats-sync]   ✓ Twitter: ${tw.followers} followers`)
          }
        } catch (err) { console.log(`[stats-sync]   ✗ Twitter: ${err.message}`) }
        await delay(500)
      }

      // TikTok
      if (PLATFORMS.includes('tiktok') && handles.tiktok) {
        try {
          console.log(`[stats-sync]   TikTok @${handles.tiktok}...`)
          const tt = await fetchTikTok(handles.tiktok)
          if (tt) {
            allStats.tiktok = tt
            totalFollowers += tt.followers || 0
            console.log(`[stats-sync]   ✓ TikTok: ${tt.followers} followers, ${tt.likes || 0} likes`)
          }
        } catch (err) { console.log(`[stats-sync]   ✗ TikTok: ${err.message}`) }
        await delay(500)
      }

      // YouTube
      if (PLATFORMS.includes('youtube') && handles.youtube) {
        try {
          console.log(`[stats-sync]   YouTube ${handles.youtube}...`)
          const yt = await fetchYouTube(handles.youtube)
          if (yt) {
            allStats.youtube = yt
            totalFollowers += yt.subscribers || 0
            console.log(`[stats-sync]   ✓ YouTube: ${yt.subscribers} subscribers, ${yt.total_views} views`)
          }
        } catch (err) { console.log(`[stats-sync]   ✗ YouTube: ${err.message}`) }
      }

      // Spotify
      if (PLATFORMS.includes('spotify') && handles.spotify) {
        try {
          console.log(`[stats-sync]   Spotify ${handles.spotify}...`)
          const sp = await fetchSpotify(handles.spotify)
          if (sp) {
            allStats.spotify = sp
            totalFollowers += sp.followers || 0
            console.log(`[stats-sync]   ✓ Spotify: ${sp.followers} followers, popularity ${sp.popularity}`)
          }
        } catch (err) { console.log(`[stats-sync]   ✗ Spotify: ${err.message}`) }
      }

      // SoundCloud
      if (PLATFORMS.includes('soundcloud') && handles.soundcloud) {
        try {
          console.log(`[stats-sync]   SoundCloud ${handles.soundcloud}...`)
          const sc = await fetchSoundCloud(handles.soundcloud)
          if (sc) {
            allStats.soundcloud = sc
            totalFollowers += sc.followers || 0
            console.log(`[stats-sync]   ✓ SoundCloud: ${sc.followers} followers, ${sc.tracks} tracks`)
          }
        } catch (err) { console.log(`[stats-sync]   ✗ SoundCloud: ${err.message}`) }
      }

      // Seed to fl-api
      if (Object.keys(allStats).length > 0) {
        console.log(`[stats-sync]   Seeding ${Object.keys(allStats).length} platform(s) (total reach: ${totalFollowers})...`)
        const result = await seedStats(slug, allStats)
        console.log(`[stats-sync]   ✓ Seeded: ${JSON.stringify(result.data?.platforms || {})}`)
        success++
      } else {
        console.log(`[stats-sync]   No stats fetched for ${slug}`)
        failed++
      }
    } catch (err) {
      console.error(`[stats-sync] FAILED ${slug}: ${err.message}`)
      failed++
    }

    if (slugs.length > 1 && slug !== slugs[slugs.length - 1]) {
      await delay(DELAY_MS)
    }
  }

  console.log(`\n[stats-sync] Done: ${success} synced, ${failed} failed out of ${slugs.length}`)
  process.exit(failed > 0 && success === 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`[stats-sync] Fatal: ${err.message}`)
  process.exit(1)
})
