// Which SOM campaigns are on (#190302). `iris som toggle` writes the switch to fl-api's
// /api/v1/som/campaigns, but the disk cache som-all reads came from campaign templates whose
// flag never changes, so on 2026-10-21 the cache said all 9 were on while only 2 were. A default
// `som-all` run would have messaged leads for 7 switched-off campaigns.
const test = require('node:test')
const assert = require('node:assert')
const { applyLiveActive } = require('../som/som-config')

const cache = () => ({
  courses: { active: true, boardId: 38 },
  creators: { active: true, boardId: 80 },
  beatbox: { active: true, boardId: 224 },
  saddlepass: { active: true, boardId: 337 },
})
const live = [
  { name: 'courses', active: true },
  { name: 'creators', active: true },
  { name: 'beatbox', active: false },
]

test('the live switch wins over the cache', () => {
  const { registry } = applyLiveActive(cache(), live)
  assert.strictEqual(registry.courses.active, true)
  assert.strictEqual(registry.creators.active, true)
  assert.strictEqual(registry.beatbox.active, false)
})

test('a campaign the live registry does not list is off', () => {
  const { registry } = applyLiveActive(cache(), live)
  assert.strictEqual(registry.saddlepass.active, false)
})

test('it reports which campaigns the cache had wrong', () => {
  const { turnedOff } = applyLiveActive(cache(), live)
  assert.deepStrictEqual(turnedOff.sort(), ['beatbox', 'saddlepass'])
})

test('everything else about a campaign is kept', () => {
  const { registry } = applyLiveActive(cache(), live)
  assert.strictEqual(registry.beatbox.boardId, 224)
})

test('it does not change the registry it was given', () => {
  const c = cache()
  applyLiveActive(c, live)
  assert.strictEqual(c.beatbox.active, true)
})
