// `iris reachr post-run --send` (#192163). Fixture text is copied from what Instagram showed on
// 2026-11-01 (#192164).
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const p = require('../som/helpers/post-run-send')

const REFUSED = "Hi there\nThis account can't receive your message because they don't allow new message requests from everyone."
const sent = { status: 'sent', delivered: true }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'post-run-'))

test('a message on screen with the refusal under it is undeliverable, not sent', () => {
  assert.strictEqual(p.classifySend(sent, { pageText: REFUSED }).outcome, 'undeliverable')
  assert.strictEqual(p.classifySend(sent, { pageText: REFUSED.replace("can't", 'can’t').replace("don't", 'don’t') }).outcome, 'undeliverable')
})

test('a confirmed send with no refusal is sent', () => {
  assert.deepStrictEqual(p.classifySend(sent, { pageText: 'Hi there' }), { outcome: 'sent', reason: '' })
})

test('typed but not confirmed may have arrived, and is not called sent or failed', () => {
  assert.strictEqual(p.classifySend({ status: 'failed', error: 'message typed but not confirmed in chat' }).outcome, 'unconfirmed')
})

test('no way to open a thread is undeliverable', () => {
  for (const error of ['could not open DM view (private/DM-restricted?)', 'no DM input found', 'account not found']) {
    assert.strictEqual(p.classifySend({ status: 'failed', error }).outcome, 'undeliverable', error)
  }
})

test('a logged-out or human-checked account stops the run and blames nobody', () => {
  for (const url of ['https://www.instagram.com/accounts/suspended/', 'https://www.instagram.com/accounts/login/', 'https://www.instagram.com/challenge/x/']) {
    const c = p.classifySend({ status: 'failed', error: 'could not open DM view' }, { url })
    assert.strictEqual(c.outcome, 'failed', url)
    assert.strictEqual(c.stop, true, url)
  }
  assert.strictEqual(p.classifySend({ status: 'failed', error: 'session expired' }).stop, true)
})

test('only sends that may be real count toward the cap', () => {
  assert.deepStrictEqual(['sent', 'unconfirmed', 'undeliverable', 'failed'].map(p.countsTowardCap), [true, true, false, false])
})

test('three misses in a row stop the run; a send resets it', () => {
  assert.strictEqual(p.shouldStopAfterMisses(['sent', 'undeliverable', 'failed']), false)
  assert.strictEqual(p.shouldStopAfterMisses(['undeliverable', 'failed', 'undeliverable']), true)
  assert.strictEqual(p.shouldStopAfterMisses(['undeliverable', 'sent', 'failed', 'failed']), false)
})

test('the cap file is the batch sender\'s file, in its format', () => {
  const som = path.join(tmp(), 'bridge', 'som')
  const when = new Date('2026-11-01T12:00:00Z')
  const file = p.capFile(som, 'acct', when)
  assert.strictEqual(file, path.join(som, '../../test-results/.dm-sent-acct-2026-11-01.json'))
  assert.strictEqual(p.remainingToday(file, 2), 2)
  p.recordCapSend(file, 11)
  p.recordCapSend(file, 11)
  const d = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.strictEqual(d.count, 1)
  assert.deepStrictEqual(d.leadIds, [11])
  p.recordCapSend(file, 12)
  assert.strictEqual(p.remainingToday(file, 2), 0)
})

test('the batch sender\'s count is honoured even without lead ids', () => {
  const file = path.join(tmp(), 'cap.json')
  fs.writeFileSync(file, JSON.stringify({ count: 39, leadIds: [], updated: '' }))
  assert.strictEqual(p.remainingToday(file, 40), 1)
})

test('the ledger survives a torn line, and blocks everyone but a plain failure', () => {
  const file = path.join(tmp(), 'nested', 'ledger.jsonl')
  for (const [handle, outcome] of [['@One', 'sent'], ['two', 'unconfirmed'], ['three', 'undeliverable'], ['four', 'failed']]) p.appendLedger(file, { handle, outcome })
  fs.appendFileSync(file, '{"handle":"cut')
  const entries = p.readLedger(file)
  assert.strictEqual(entries.length, 4)
  assert.deepStrictEqual([...p.blockedHandles(entries)].sort(), ['one', 'three', 'two'])
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepStrictEqual(p.readLedger(path.join(tmp(), 'none')), [])
})

test('the approved list must match the typed count and be complete', () => {
  const ok = { handle: 'a', leadId: 1, message: 'hi' }
  assert.strictEqual(p.validateApproved([ok], '1'), null)
  assert.match(p.validateApproved([ok], '2'), /confirmed 2/)
  assert.match(p.validateApproved([ok], undefined), /confirmed/)
  assert.match(p.validateApproved([], '0'), /empty/)
  assert.match(p.validateApproved([{ ...ok, leadId: 0 }], '1'), /no lead/)
  assert.match(p.validateApproved([{ ...ok, message: ' ' }], '1'), /no message/)
})

test('notes say what happened; a send writes none here because record-dm does', () => {
  const ctx = { account: 'acct', handle: '@x', reason: 'why' }
  assert.strictEqual(p.noteFor('sent', ctx), null)
  assert.match(p.noteFor('undeliverable', ctx), /^\[SOM UNDELIVERABLE\]/)
  assert.match(p.noteFor('unconfirmed', ctx), /^\[SOM FAIL\]/)
})
