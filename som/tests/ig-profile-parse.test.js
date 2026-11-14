// #193482 — Instagram profile → lead fields. Run: node --test som/tests/ig-profile-parse.test.js
//
// FIXTURES ARE TYPED, NOT RECORDED: written from the shape of Instagram's web_profile_info
// response and its profile meta description, because this machine cannot reach Instagram.
// They prove the parser agrees with that shape. They cannot prove Instagram still sends it —
// that proof is a real run on the Mac, recorded on #193482.
const test = require('node:test')
const assert = require('node:assert')
const { parseCount, fromWebProfileInfo, fromMetaDescription, realBio, leadFields } = require('../helpers/providers/ig-profile-parse')

test('parseCount reads plain, comma, K and M counts, and refuses what it cannot read', () => {
  assert.strictEqual(parseCount('1,234'), 1234)
  assert.strictEqual(parseCount('12.5K'), 12500)
  assert.strictEqual(parseCount('1.2M'), 1200000)
  assert.strictEqual(parseCount('0'), 0)
  assert.strictEqual(parseCount(42), 42)
  assert.strictEqual(parseCount(''), null)
  assert.strictEqual(parseCount('followers'), null)
  assert.strictEqual(parseCount(undefined), null)
})

const API = {
  data: {
    user: {
      username: 'sample.creator',
      full_name: 'Sample Creator',
      biography: 'Course creator · teaching AI workflows to small teams',
      edge_followed_by: { count: 4821 },
      edge_follow: { count: 310 },
      edge_owner_to_timeline_media: { count: 212 },
      is_verified: false,
      is_private: false,
      external_url: 'https://example.com',
      category_name: 'Education',
      is_business_account: true,
      business_address_json: '{"city_name":"Austin, Texas","zip_code":"78701"}',
    },
  },
  status: 'ok',
}

test('the profile JSON gives counts, bio, category and city', () => {
  const s = fromWebProfileInfo(API)
  assert.strictEqual(s.source, 'api')
  assert.strictEqual(s.followers, 4821)
  assert.strictEqual(s.following, 310)
  assert.strictEqual(s.posts, 212)
  assert.strictEqual(s.bio, 'Course creator · teaching AI workflows to small teams')
  assert.strictEqual(s.category, 'Education')
  assert.strictEqual(s.city, 'Austin, Texas')
  assert.strictEqual(s.isBusiness, true)
})

test('a login wall or error body is not a profile', () => {
  assert.strictEqual(fromWebProfileInfo({ message: 'Please wait a few minutes', status: 'fail' }), null)
  assert.strictEqual(fromWebProfileInfo(null), null)
  assert.strictEqual(fromWebProfileInfo({ data: { user: null } }), null)
})

test('a missing count stays unknown (null), never 0', () => {
  const s = fromWebProfileInfo({ data: { user: { username: 'x', full_name: 'X' } } })
  assert.strictEqual(s.followers, null)
  assert.strictEqual(s.posts, null)
})

test('meta description: counts, name, and the bio after "on Instagram:"', () => {
  const a = fromMetaDescription('1,234 Followers, 56 Following, 78 Posts - See Instagram photos and videos from Jo Doe (@jo.doe)')
  assert.deepStrictEqual([a.followers, a.following, a.posts, a.displayName, a.bio], [1234, 56, 78, 'Jo Doe', ''])
  const b = fromMetaDescription('12.5K Followers, 300 Following, 1,024 Posts - Jo Doe (@jo.doe) on Instagram: "DJ · Austin · bookings below"')
  assert.deepStrictEqual([b.followers, b.posts, b.bio], [12500, 1024, 'DJ · Austin · bookings below'])
  assert.strictEqual(fromMetaDescription('Instagram'), null)
})

test('THE BUG: a bio equal to the display name is not a bio', () => {
  assert.strictEqual(realBio('JJ', 'JJ'), '')
  assert.strictEqual(realBio('Sabah✨', 'Sabah✨'), '')
  assert.strictEqual(realBio('DJ in Austin', 'JJ'), 'DJ in Austin')
})

test('THE BUG: leadFields never writes 0 for a count it could not read', () => {
  // What the old selectors produced for every lead: zeros and the name as the bio.
  const broken = { followers: null, following: null, posts: null, displayName: 'JJ', bio: 'JJ', source: 'dom' }
  const f = leadFields(broken, new Date('2026-11-14T00:00:00Z'))
  assert.ok(!('ig_followers' in f), 'unknown followers must be left out, not written as 0')
  assert.ok(!('ig_bio' in f), 'a name-as-bio must not be written')
  assert.strictEqual(f.ig_display_name, 'JJ')
  assert.strictEqual(f.ig_stats_source, 'dom')
})

test('leadFields writes everything the profile JSON had, including city and category', () => {
  const f = leadFields(fromWebProfileInfo(API), new Date('2026-11-14T00:00:00Z'))
  assert.strictEqual(f.ig_followers, 4821)
  assert.strictEqual(f.ig_city, 'Austin, Texas')
  assert.strictEqual(f.ig_category, 'Education')
  assert.strictEqual(f.ig_business, true)
  assert.strictEqual(f.ig_stats_source, 'api')
  assert.strictEqual(f.ig_scraped_at, '2026-11-14T00:00:00.000Z')
})

test('nothing read → nothing written', () => {
  assert.strictEqual(leadFields({ followers: null, bio: '', displayName: '' }), null)
  assert.strictEqual(leadFields(null), null)
})
