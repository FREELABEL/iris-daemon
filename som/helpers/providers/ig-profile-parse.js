/**
 * Instagram profile → lead fields, as pure functions (#193482).
 *
 * WHY THIS EXISTS: scrapeProfileStats read the profile with CSS selectors
 * ('header section ul li', 'header section span[dir]'). Instagram changed the header, the
 * selectors stopped matching, and every scrape since at least 2026-05 wrote followers 0,
 * following 0, posts 0 and a "bio" that was the display name. It reported success each time.
 * Measured 2026-11-14: boards 38 and 80, 118 scraped leads, 2 with a real bio.
 *
 * The order now: Instagram's own profile JSON (the request the profile page itself makes),
 * then the page's meta description ("1,234 Followers, 56 Following, 78 Posts - …"), then the
 * old selectors. A count that could not be read is null, never 0. 0 is a real follower count,
 * and writing it for "unknown" is how this went unnoticed for six months.
 */

/** "1,234" · "12.5K" · "1.2M" · "1 234" → number; anything unreadable → null. */
function parseCount(text) {
  if (text === null || text === undefined) return null
  if (typeof text === 'number') return Number.isFinite(text) ? text : null
  const t = String(text).trim().toLowerCase().replace(/[,\s]/g, '')
  const m = t.match(/^(\d+(?:\.\d+)?)([km])?$/)
  if (!m) return null
  const n = parseFloat(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1)
  return Math.round(n)
}

/** City from a business account's address, if Instagram gives one. */
function cityOf(user) {
  if (user.city_name) return String(user.city_name).trim() || null
  const raw = user.business_address_json
  if (!raw) return null
  try {
    const a = typeof raw === 'string' ? JSON.parse(raw) : raw
    return (a && (a.city_name || a.city) ? String(a.city_name || a.city).trim() : null) || null
  } catch {
    return null
  }
}

/**
 * The `data.user` object of /api/v1/users/web_profile_info/?username=… → stats.
 * Returns null when the object is not a profile (a login wall, an error body).
 */
function fromWebProfileInfo(body) {
  const user = body && body.data && body.data.user
  if (!user || typeof user !== 'object' || !user.username) return null
  const count = (edge) => (edge && typeof edge.count === 'number' ? edge.count : null)
  return {
    source: 'api',
    username: user.username,
    followers: count(user.edge_followed_by),
    following: count(user.edge_follow),
    posts: count(user.edge_owner_to_timeline_media),
    displayName: (user.full_name || '').trim(),
    bio: (user.biography || '').trim(),
    isVerified: !!user.is_verified,
    isPrivate: !!user.is_private,
    externalUrl: (user.external_url || '').trim(),
    category: (user.category_name || user.business_category_name || user.overall_category_name || '').trim(),
    city: cityOf(user),
    isBusiness: !!(user.is_business_account || user.is_professional_account),
  }
}

/**
 * The profile page's <meta name="description"> / og:description → counts (and the bio, when
 * Instagram appends it after "on Instagram:"). Formats seen:
 *   1,234 Followers, 56 Following, 78 Posts - See Instagram photos and videos from Name (@user)
 *   12.5K Followers, 300 Following, 1,024 Posts - Name (@user) on Instagram: "bio text"
 */
function fromMetaDescription(desc) {
  if (!desc || typeof desc !== 'string') return null
  const grab = (word) => {
    const m = desc.match(new RegExp('([\\d.,\\s]+[KkMm]?)\\s+' + word, 'i'))
    return m ? parseCount(m[1]) : null
  }
  const followers = grab('Followers?')
  const following = grab('Following')
  const posts = grab('Posts?')
  if (followers === null && following === null && posts === null) return null
  const bioMatch = desc.match(/on Instagram:\s*["“](.*)["”]\s*$/s)
  const nameMatch = desc.match(/videos from\s+(.+?)\s+\(@[\w.]+\)/) || desc.match(/Posts?\s+-\s+(.+?)\s+\(@[\w.]+\)/i)
  return {
    source: 'meta',
    followers,
    following,
    posts,
    displayName: nameMatch ? nameMatch[1].trim() : '',
    bio: bioMatch ? bioMatch[1].trim() : '',
  }
}

/** A bio that is only the display name is not a bio (the old selectors' failure). */
function realBio(bio, displayName) {
  const b = (bio || '').trim()
  if (!b) return ''
  if (displayName && b === displayName.trim()) return ''
  return b
}

/**
 * The custom_fields to write for a lead. Only what was actually read: an unknown count is
 * left out (the lead keeps whatever it had), never written as 0.
 */
function leadFields(stats, now = new Date()) {
  if (!stats) return null
  const f = {}
  const put = (k, v) => {
    if (v === null || v === undefined || v === '') return
    f[k] = v
  }
  put('ig_followers', stats.followers)
  put('ig_following', stats.following)
  put('ig_posts', stats.posts)
  put('ig_bio', realBio(stats.bio, stats.displayName).slice(0, 500))
  put('ig_display_name', stats.displayName)
  put('ig_external_url', stats.externalUrl)
  put('ig_category', stats.category)
  put('ig_city', stats.city)
  if (typeof stats.isVerified === 'boolean') f.ig_verified = stats.isVerified
  if (typeof stats.isPrivate === 'boolean') f.ig_private = stats.isPrivate
  if (typeof stats.isBusiness === 'boolean') f.ig_business = stats.isBusiness
  if (Object.keys(f).length === 0) return null
  f.ig_stats_source = stats.source || 'dom'
  f.ig_scraped_at = now.toISOString()
  return f
}

module.exports = { parseCount, fromWebProfileInfo, fromMetaDescription, realBio, leadFields }
