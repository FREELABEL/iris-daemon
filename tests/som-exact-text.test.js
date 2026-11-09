// See som/helpers/exact-text.js (#192413): send the approved opener word for word, when asked to.
const test = require('node:test')
const assert = require('node:assert')
const { exactTextMode, strategySteps, renderExact } = require('../som/helpers/exact-text')

const APPROVED = "Saw you're into AI. We built IRIS, an AI team that runs on your laptop and takes the busywork off your plate. What are you building?"

test('default is unchanged: no env and no verbatim flag means Vary It runs', () => {
  assert.deepStrictEqual(exactTextMode({ env: {}, step: { verbatim: false } }), { exact: false, source: '' })
  assert.deepStrictEqual(exactTextMode({ env: {}, step: null }), { exact: false, source: '' })
  assert.strictEqual(exactTextMode({ env: { SOM_EXACT_TEXT: '0' } }).exact, false)
  assert.strictEqual(exactTextMode({ env: { SOM_EXACT_TEXT: '' } }).exact, false)
})

test('SOM_EXACT_TEXT=1 (or true/yes) turns it on for the run', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
    assert.deepStrictEqual(exactTextMode({ env: { SOM_EXACT_TEXT: v } }), { exact: true, source: 'SOM_EXACT_TEXT' }, v)
  }
})

test("a strategy step marked verbatim turns it on for that strategy", () => {
  for (const v of [true, 1, '1', 'true']) {
    assert.deepStrictEqual(exactTextMode({ env: {}, step: { verbatim: v } }), { exact: true, source: 'strategy step verbatim' })
  }
})

test('the approved text goes out unchanged', () => {
  assert.deepStrictEqual(renderExact(APPROVED, { name: 'savvy_karan' }), { ok: true, text: APPROVED, unresolved: [], reason: '' })
  assert.strictEqual(renderExact(`  ${APPROVED}\n`, {}).text, APPROVED)
})

test('merge fields are filled from the lead', () => {
  const r = renderExact('Hey {first_name}! Loved @{instagram} — {company}?', { name: 'Maya Lopez', company: 'Lopez Films', contact_info: { instagram: '@mayalopez' } })
  assert.deepStrictEqual(r, { ok: true, text: 'Hey Maya! Loved @mayalopez — Lopez Films?', unresolved: [], reason: '' })
})

test('a merge field with no value stops the lead rather than sending "{first_name}"', () => {
  const r = renderExact('Hey {first_name}! I love what you do.', { name: 'savvy_karan' }) // a handle is not a first name
  assert.strictEqual(r.ok, false)
  assert.deepStrictEqual(r.unresolved, ['{first_name}'])
  assert.match(r.reason, /no value for \{first_name\}/)
  assert.strictEqual(renderExact('Hi {sender_nmae}', { name: 'A B' }).ok, false)
})

test('an empty step is refused', () => {
  assert.strictEqual(renderExact('   ', {}).ok, false)
  assert.strictEqual(renderExact(null, {}).ok, false)
})

test('strategySteps returns the named strategy in send order', () => {
  const templates = [
    { name: 'Other', steps: [{ order: 0, instructions: 'no' }] },
    { name: 'Roadmap Commenters | V1', steps: [{ order: 1, instructions: 'second' }, { order: '0', instructions: APPROVED, verbatim: true }] },
  ]
  const steps = strategySteps(templates, 'Roadmap Commenters | V1')
  assert.deepStrictEqual(steps.map(s => s.instructions), [APPROVED, 'second'])
  assert.strictEqual(exactTextMode({ env: {}, step: steps[0] }).exact, true)
  assert.deepStrictEqual(strategySteps(templates, 'missing'), [])
  assert.deepStrictEqual(strategySteps(undefined, 'x'), [])
})
