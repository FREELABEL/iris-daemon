// #192164: reclassify leads already burned by the banner. Reports by default.
const test = require('node:test')
const assert = require('node:assert')
const r = require('../som/helpers/recover-undeliverable')

const ACCOUNT = 'acct_a'
const thread = (over = {}) => ({ username: 'p1', rawMetadata: { cantReceive: true, cantReceiveAt: '2026-11-01T10:00:00Z', hasTheirMessage: false, ...over } })
const lead = (over = {}) => ({ id: 1, ...over })

test('plan: only banner threads, nobody who replied, nobody unmatched', () => {
  const map = new Map([['p1', { id: 1 }], ['p3', { id: 3 }]])
  const plan = r.planRecovery([thread(), thread({ cantReceive: false, username: 'p2' }), { username: 'p3', rawMetadata: { cantReceive: true, hasTheirMessage: true } }, { username: 'p9', rawMetadata: { cantReceive: true } }], map)
  assert.strictEqual(plan.counts.threads, 4)
  assert.strictEqual(plan.counts.banner, 3)
  assert.strictEqual(plan.counts.replied, 1)
  assert.strictEqual(plan.counts.unmatched, 1)
  assert.strictEqual(plan.toCheck.length, 1)
  assert.strictEqual(plan.toCheck[0].leadId, 1)
})

test('decide: already marked or already replied leads are left alone', () => {
  assert.strictEqual(r.decide(lead({ has_replied: true }), [], ACCOUNT), 'replied')
  assert.strictEqual(r.decide(lead({ custom_fields: { dm_undeliverable: { [ACCOUNT]: { kind: 'refused' } } } }), [], ACCOUNT), 'already-marked')
  assert.strictEqual(r.decide(lead(), [{ direction: 'inbound' }], ACCOUNT), 'replied')
  assert.strictEqual(r.decide(lead(), [], ACCOUNT), 'reclassify')
})

function fakeApi (steps = [{ id: 7, is_completed: true }]) {
  const calls = []
  const ok = n => async (...a) => { calls.push([n, ...a]); return { success: true } }
  return { calls, addNote: ok('note'), updateLead: ok('lead'), updateMessage: ok('msg'), reopenStep: ok('step'), getSteps: async () => steps }
}

test('apply: marks the lead, archives that account\'s message, reopens the step, deletes nothing', async () => {
  const api = fakeApi()
  const messages = [
    { id: 10, direction: 'outbound', type: 'instagram_dm', status: 'sent', channel_account: ACCOUNT, message: 'hi' },
    { id: 11, direction: 'outbound', type: 'instagram_dm', status: 'sent', channel_account: 'other', message: 'hi2' },
  ]
  const res = await r.applyRecovery(api, lead(), messages, { account: ACCOUNT, handle: 'p1', at: '2026-11-01T10:00:00Z' })
  assert.deepStrictEqual(res, { noted: true, archived: 1, reopened: 0 }) // another account's message stands, so steps stay
  assert.strictEqual(api.calls.filter(c => c[0] === 'msg').length, 1)
  assert.deepStrictEqual(api.calls.find(c => c[0] === 'msg').slice(1), [1, 10, 'hi', 'archived'])
})

test('apply: with only this account\'s message, steps reopen so the lead reads as uncontacted', async () => {
  const api = fakeApi([{ id: 7, is_completed: true }, { id: 8, is_completed: false }])
  const messages = [{ id: 10, direction: 'outbound', type: 'instagram_dm', status: 'sent', channel_account: ACCOUNT, message: 'hi' }]
  const res = await r.applyRecovery(api, lead(), messages, { account: ACCOUNT, handle: 'p1', at: 'x' })
  assert.deepStrictEqual(res, { noted: true, archived: 1, reopened: 1 })
})

test('a note that fails stops the rest for that lead, so nothing half-applies', async () => {
  const api = fakeApi()
  api.addNote = async () => ({ success: false })
  const res = await r.applyRecovery(api, lead(), [{ id: 10, direction: 'outbound', channel_account: ACCOUNT, message: 'hi' }], { account: ACCOUNT, handle: 'p1', at: 'x' })
  assert.deepStrictEqual(res, { noted: false, archived: 0, reopened: 0 })
  assert.strictEqual(api.calls.length, 0)
})

test('report holds counts only, never a handle', () => {
  const s = r.report({ account: ACCOUNT, apply: false, counts: { threads: 2, banner: 1, replied: 0, unmatched: 0, reclassify: 1, alreadyMarked: 0 } })
  assert.strictEqual(s.mode, 'dry-run')
  assert.doesNotMatch(JSON.stringify(s), /p1/)
})

test('args: reports unless --apply is given exactly', () => {
  assert.strictEqual(r.parseApply(['node', 'x']), false)
  assert.strictEqual(r.parseApply(['--apply=false']), false)
  assert.strictEqual(r.parseApply(['--apply']), true)
})
