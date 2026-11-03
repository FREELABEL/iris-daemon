// #192164: a lead is never wasted and never messaged twice.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const g = require('../som/helpers/dm-guard')

const ACCOUNT = 'acct_a'
const day = 24 * 3600 * 1000
const NOW = Date.parse('2026-11-01T12:00:00Z')
const ago = ms => new Date(NOW - ms).toISOString()
const gate = (over = {}) => g.dmGate({ lead: {}, notes: [], messages: [], account: ACCOUNT, firstContact: true, journal: [], leadId: 1, now: NOW, ...over })
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-guard-')), 'j.jsonl')

test('a fresh lead may be messaged', () => assert.strictEqual(gate().allow, true))

test('someone who replied is never messaged', () => {
  assert.strictEqual(gate({ lead: { has_replied: true } }).code, 'replied')
  assert.strictEqual(gate({ messages: [{ direction: 'inbound', type: 'instagram_dm' }] }).code, 'replied')
  assert.strictEqual(gate({ firstContact: false, lead: { has_replied: 1 } }).code, 'replied')
})

test('someone we reached is not first-contacted again, from any account', () => {
  assert.strictEqual(gate({ messages: [{ direction: 'outbound', type: 'instagram_dm', status: 'sent', channel_account: 'other' }] }).code, 'reached')
  assert.strictEqual(gate({ notes: [{ content: '[SOM DM] Sent via @other: "hi..."', created_at: ago(200 * day) }] }).code, 'reached')
})

test('history we could not read blocks the send', () => {
  assert.strictEqual(gate({ messages: null }).code, 'history-unreadable')
})

test('refused by Instagram: never again from this account, no expiry', () => {
  const notes = [{ content: `[SOM UNDELIVERABLE] cannot DM @x from @${ACCOUNT}: this account can't receive your message`, created_at: ago(400 * day) }]
  assert.strictEqual(gate({ notes }).code, 'undeliverable-this-account')
  const lead = { custom_fields: { dm_undeliverable: { [ACCOUNT]: { at: ago(400 * day), reason: 'r', kind: 'refused' } } } }
  assert.strictEqual(gate({ lead }).code, 'undeliverable-this-account')
})

test('no Message button may be a bad page load: rest 14 days, then try again', () => {
  const note = at => [{ content: `[SOM UNDELIVERABLE] cannot DM @x from @${ACCOUNT}: no options (…) button`, created_at: at }]
  assert.strictEqual(gate({ notes: note(ago(2 * day)) }).code, 'undeliverable-cooldown')
  assert.strictEqual(gate({ notes: note(ago(15 * day)) }).allow, true)
})

test('another account: off by default; once only when policy allows', () => {
  const lead = { custom_fields: { dm_undeliverable: { other: { at: ago(day), reason: 'r', kind: 'refused' } } } }
  const messages = [{ direction: 'outbound', type: 'instagram_dm', status: 'sent', channel_account: 'other' }]
  const notes = [{ content: '[SOM DM] Sent via @other: "hi..."', created_at: ago(day) }]
  assert.strictEqual(gate({ lead, messages, notes }).code, 'undeliverable-other-account')
  assert.strictEqual(gate({ lead, messages, notes, crossAccount: true }).allow, true)
  const two = { custom_fields: { dm_undeliverable: { other: { kind: 'refused' }, third: { kind: 'refused' } } } }
  assert.strictEqual(gate({ lead: two, crossAccount: true }).code, 'undeliverable-other-account')
  // and a reply still wins over the policy
  assert.strictEqual(gate({ lead: { ...lead, has_replied: true }, crossAccount: true }).code, 'replied')
})

test('typed but not confirmed may have arrived: never retried', () => {
  assert.strictEqual(gate({ notes: [{ content: `[SOM UNCONFIRMED] DM to @x via @${ACCOUNT}: r`, created_at: ago(90 * day) }] }).code, 'unconfirmed')
  assert.strictEqual(gate({ notes: [{ content: `[SOM FAIL] DM to @x via @${ACCOUNT} — message typed but not confirmed in chat`, created_at: ago(90 * day) }] }).code, 'unconfirmed')
})

test('a transient failure rests for hours, not days', () => {
  const note = at => [{ content: `[SOM FAIL] DM to @x via @${ACCOUNT}: session blip`, created_at: at }]
  assert.strictEqual(gate({ notes: note(ago(3600 * 1000)) }).code, 'fail-cooldown')
  assert.strictEqual(gate({ notes: note(ago(7 * 3600 * 1000)) }).allow, true)
})

test('crash after pressing send: an intent with no outcome is never re-sent', () => {
  const journal = [{ event: 'intent', lead_id: 1, account: ACCOUNT, at: ago(day) }]
  assert.strictEqual(gate({ journal }).code, 'unresolved-send')
  // another lead, or the same lead on another account, is untouched
  assert.strictEqual(gate({ journal, leadId: 2 }).allow, true)
  assert.strictEqual(gate({ journal: [{ ...journal[0], account: 'other' }] }).allow, true)
})

test('after an outcome the journal decides: failed may retry, anything that went out may not', () => {
  const j = outcome => [{ event: 'intent', lead_id: 1, account: ACCOUNT }, { event: 'outcome', lead_id: 1, account: ACCOUNT, outcome }]
  assert.strictEqual(gate({ journal: j('failed') }).allow, true)
  for (const o of ['sent', 'delivered-unknown', 'undeliverable']) assert.strictEqual(gate({ journal: j(o) }).allow, false, o)
})

test('a lead that keeps failing stops using up batches', () => {
  const f = { event: 'outcome', lead_id: 1, account: ACCOUNT, outcome: 'failed' }
  assert.strictEqual(gate({ journal: [f, f] }).allow, true)
  assert.strictEqual(gate({ journal: [f, f, f] }).code, 'failed-repeatedly')
})

test('follow-ups keep working on someone we reached, unless refused', () => {
  const messages = [{ direction: 'outbound', type: 'instagram_dm', status: 'sent', channel_account: ACCOUNT, sent_at: ago(5 * day) }]
  assert.strictEqual(gate({ firstContact: false, messages }).allow, true)
  const lead = { custom_fields: { dm_undeliverable: { [ACCOUNT]: { kind: 'refused' } } } }
  assert.strictEqual(gate({ firstContact: false, messages, lead }).allow, false)
})

test('the journal survives a line cut short by a crash, and an unwritable one throws before any send', () => {
  const f = tmp()
  g.writeIntent(f, { leadId: 1, account: ACCOUNT, campaign: 'c', boardId: 38 })
  fs.appendFileSync(f, '{"event":"outc')
  assert.strictEqual(g.readJournal(f).length, 1)
  assert.throws(() => g.writeIntent(path.join(f, 'under-a-file', 'j.jsonl'), { leadId: 1, account: ACCOUNT }))
})

test('the journal holds no message text and no handle', () => {
  const f = tmp()
  g.writeIntent(f, { leadId: 1, account: ACCOUNT, campaign: 'c', boardId: 38, handle: 'secret_person', message: 'hello' })
  g.writeOutcome(f, { leadId: 1, account: ACCOUNT, campaign: 'c', boardId: 38, outcome: 'sent', handle: 'secret_person' })
  assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /secret_person|hello/)
})

test('steps go back only when nothing went out and Instagram did not refuse', () => {
  assert.strictEqual(g.shouldReleaseSteps({ createdSteps: true, submitted: false, kind: '', dryRun: false }), true)
  assert.strictEqual(g.shouldReleaseSteps({ createdSteps: true, submitted: false, kind: 'no-route', dryRun: false }), true)
  assert.strictEqual(g.shouldReleaseSteps({ createdSteps: false, submitted: false, kind: '', dryRun: false }), false)
  assert.strictEqual(g.shouldReleaseSteps({ createdSteps: true, submitted: true, kind: '', dryRun: false }), false)
  assert.strictEqual(g.shouldReleaseSteps({ createdSteps: true, submitted: false, kind: 'refused', dryRun: false }), false)
  assert.strictEqual(g.shouldReleaseSteps({ createdSteps: true, submitted: false, kind: '', dryRun: true }), false)
})

test('routes: email when we have one, comment for stage 3, another account only by policy', () => {
  assert.deepStrictEqual(g.nextRoutes({ email: 'a@b.co' }, ACCOUNT), ['email', 'comment'])
  assert.deepStrictEqual(g.nextRoutes({ contact_info: {} }, ACCOUNT), ['comment'])
  assert.deepStrictEqual(g.nextRoutes({}, ACCOUNT, { crossAccount: true }), ['comment', 'other-account'])
  assert.deepStrictEqual(g.nextRoutes({ has_replied: true, email: 'a@b.co' }, ACCOUNT), [])
})

test('marking: note first, then merged custom field and tag, keeping existing tags', async () => {
  const calls = []
  const api = {
    addNote: async (id, m) => { calls.push(['note', m]); return { success: true } },
    updateLead: async (id, d) => { calls.push(['lead', d]); return { success: true } },
  }
  const lead = { id: 1, email: 'a@b.co', tags: [{ id: 5 }], custom_fields: { keep: 1 } }
  const r = await g.markUndeliverable(api, lead, { account: ACCOUNT, handle: 'x', reason: "can't receive", kind: 'refused', tagId: 9, at: '2026-11-01' })
  assert.strictEqual(r.noted, true)
  assert.strictEqual(calls[0][0], 'note')
  assert.match(calls[0][1], /^\[SOM UNDELIVERABLE\]/)
  const body = calls[1][1]
  assert.deepStrictEqual(body.tags, [5, 9])
  assert.deepStrictEqual(body.custom_fields.dm_undeliverable[ACCOUNT].routes, ['email', 'comment'])
  assert.strictEqual(body.custom_fields.dm_undeliverable[ACCOUNT].kind, 'refused')
  assert.strictEqual(body.custom_fields.dm_undeliverable[ACCOUNT].at, '2026-11-01')
})

test('metrics: per campaign per day, a crash counts as unknown, rate excludes failures', () => {
  const o = (lead_id, outcome, at = '2026-11-01T10:00:00Z', campaign = 'c1') => ({ event: 'outcome', lead_id, account: ACCOUNT, campaign, outcome, at })
  const rows = g.summarize([
    o(1, 'sent'), o(2, 'undeliverable'), o(3, 'delivered-unknown'), o(4, 'failed'), o(5, 'sent'),
    { event: 'intent', lead_id: 6, account: ACCOUNT, campaign: 'c1', at: '2026-11-01T11:00:00Z' },
    o(7, 'sent', '2026-11-02T10:00:00Z'), o(8, 'undeliverable', '2026-11-01T10:00:00Z', 'c2'),
  ])
  assert.deepStrictEqual(rows[0], { date: '2026-11-01', campaign: 'c1', account: ACCOUNT, attempted: 6, sent: 2, undeliverable: 1, delivered_unknown: 2, failed: 1, delivery_rate: 0.4 })
  assert.strictEqual(rows.length, 3)
  assert.strictEqual(rows.find(r => r.campaign === 'c2').delivery_rate, 0)
})

test('metrics: nothing went out means no rate, not 0%', () => {
  const rows = g.summarize([{ event: 'outcome', lead_id: 1, account: ACCOUNT, campaign: 'c', outcome: 'failed', at: '2026-11-01T10:00:00Z' }])
  assert.strictEqual(rows[0].delivery_rate, null)
})

test('the batch summary line has every number', () => {
  const line = g.summaryLine({ sent: 2, failed: 4, undeliverable: 1, deliveredUnknown: 1 })
  assert.strictEqual(line, 'Attempted: 6  |  Sent: 2  |  Undeliverable: 1  |  Unknown: 1  |  Failed: 2  |  Delivery rate: 50% (of 4 that went out)')
})
