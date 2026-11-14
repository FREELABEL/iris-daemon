// #193485 — every SOM send is also reported to the server ledger, and that never gets in the way of a send.
// Run: node --test som/tests/send-ledger.test.js
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const sl = require('../helpers/send-ledger')

const tmpQueue = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'som-send-ledger-')), 'queue.jsonl')
const base = { campaign: 'Silent Iris', bloqId: 38, leadId: 30313, step: 1, channel: 'instagram', account: '@heyiris.io', at: '2026-11-14T15:00:00.000Z', node: 'mac-test' }

test('the event has the shape the server takes', () => {
  const ev = sl.buildEvent({ ...base, outcome: 'sent', campaignId: 53 })
  assert.deepStrictEqual(Object.keys(ev).sort(), ['account', 'bloq_id', 'campaign', 'campaign_id', 'channel', 'client_event_id', 'lead_id', 'node_id', 'sent_at', 'status', 'step'])
  assert.strictEqual(ev.account, 'heyiris.io')
  assert.strictEqual(ev.status, 'sent')
  assert.strictEqual(ev.sent_at, base.at)
  assert.strictEqual(ev.bloq_id, 38)
  assert.strictEqual(ev.campaign_id, 53)
  assert.match(ev.client_event_id, /^som1-[0-9a-f]{40}$/)
})

test('journal outcomes map to server statuses; a dry run or a missing lead reports nothing', () => {
  assert.strictEqual(sl.buildEvent({ ...base, outcome: 'delivered-unknown' }).status, 'sent') // spends the cap
  assert.strictEqual(sl.buildEvent({ ...base, outcome: 'failed', error: 'no_dm_input' }).error, 'no_dm_input')
  assert.strictEqual(sl.buildEvent({ ...base, outcome: 'undeliverable' }).status, 'undeliverable')
  assert.strictEqual(sl.buildEvent({ ...base, outcome: 'dry-run' }), null)
  assert.strictEqual(sl.buildEvent({ ...base, outcome: 'sent', leadId: null }), null)
  assert.strictEqual(sl.buildEvent({ ...base, outcome: 'sent', bloqId: null }), null)
})

test('client_event_id is stable for the same send and differs for a different one', () => {
  const a = sl.buildEvent({ ...base, outcome: 'sent' }).client_event_id
  assert.strictEqual(sl.buildEvent({ ...base, outcome: 'sent', account: 'HeyIris.io' }).client_event_id, a) // same send, same id
  assert.strictEqual(sl.buildEvent({ ...base, outcome: 'failed' }).client_event_id, a) // status is not part of the key
  for (const diff of [{ step: 2 }, { leadId: 1 }, { campaign: 'Other' }, { account: 'other' }, { at: '2026-11-14T15:00:01.000Z' }]) {
    assert.notStrictEqual(sl.buildEvent({ ...base, ...diff, outcome: 'sent' }).client_event_id, a, JSON.stringify(diff))
  }
})

test('a successful flush posts the queue once and empties it', async () => {
  const file = tmpQueue()
  const calls = []
  const post = async evs => { calls.push(evs); return { ok: true, status: 201 } }
  sl.enqueue(file, sl.buildEvent({ ...base, outcome: 'sent' }))
  sl.enqueue(file, sl.buildEvent({ ...base, leadId: 2, outcome: 'failed' }))
  const t = await sl.flush({ file, post })
  assert.strictEqual(t.posted, 2)
  assert.strictEqual(t.kept, 0)
  assert.strictEqual(calls.length, 1)
  assert.ok(calls[0].every(e => !Object.keys(e).some(k => k.startsWith('_'))), 'queue bookkeeping is not sent')
  assert.deepStrictEqual(sl.readLines(file), [])
})

test('a 404 (endpoint not deployed) or 500 keeps the events queued, and the next flush sends them', async () => {
  const file = tmpQueue()
  sl.enqueue(file, sl.buildEvent({ ...base, outcome: 'sent' }))
  for (const status of [404, 500, 0]) {
    const t = await sl.flush({ file, post: async () => ({ ok: false, status }) })
    assert.strictEqual(t.posted, 0)
    assert.strictEqual(t.kept, 1)
    assert.strictEqual(sl.readLines(file).length, 1)
  }
  assert.strictEqual(sl.readLines(file)[0]._attempts, 3)

  let sent = []
  const t = await sl.flush({ file, post: async evs => { sent = evs; return { ok: true, status: 201 } } })
  assert.strictEqual(t.posted, 1)
  assert.strictEqual(sent[0].lead_id, base.leadId)
  assert.deepStrictEqual(sl.readLines(file), [])
})

test('a poster that throws or rejects never escapes into the send path', async () => {
  const file = tmpQueue()
  const ev = sl.buildEvent({ ...base, outcome: 'sent' })
  // report() is synchronous and returns; the background flush swallows the throw.
  assert.strictEqual(sl.report(ev, { file, post: () => { throw new Error('boom') } }), true)
  await sl.flush({ file, post: async () => { throw new Error('network down') } }) // resolves, never rejects
  assert.strictEqual(sl.readLines(file).length, 1, 'still queued for later')
  // A queue that cannot be written is a false, not an exception.
  const notADir = path.join(path.dirname(file), 'a-file')
  fs.writeFileSync(notADir, 'x')
  assert.strictEqual(sl.report(ev, { file: path.join(notADir, 'q.jsonl'), post: async () => ({ ok: true }) }), false)
  assert.strictEqual(sl.report(null, { file }), false)
})

test('one invalid event (422) is dropped without losing the valid ones', async () => {
  const file = tmpQueue()
  const good = sl.buildEvent({ ...base, outcome: 'sent' })
  const bad = { ...sl.buildEvent({ ...base, leadId: 9, outcome: 'sent' }), channel: 'carrier-pigeon' }
  sl.enqueue(file, good); sl.enqueue(file, bad)
  const accepted = []
  const post = async evs => {
    if (evs.some(e => e.channel === 'carrier-pigeon')) return { ok: false, status: 422 }
    accepted.push(...evs); return { ok: true, status: 201 }
  }
  const t = await sl.flush({ file, post })
  assert.strictEqual(t.posted, 1)
  assert.strictEqual(t.dropped, 1)
  assert.deepStrictEqual(accepted.map(e => e.lead_id), [base.leadId])
  assert.deepStrictEqual(sl.readLines(file), [])
})

test('posts go in batches of at most 100, and a duplicate in the queue is sent once', async () => {
  const file = tmpQueue()
  for (let i = 1; i <= 230; i++) sl.enqueue(file, sl.buildEvent({ ...base, leadId: i, outcome: 'sent' }))
  sl.enqueue(file, sl.buildEvent({ ...base, leadId: 1, outcome: 'sent' })) // same send queued twice
  const sizes = []
  const t = await sl.flush({ file, post: async evs => { sizes.push(evs.length); return { ok: true, status: 201 } } })
  assert.deepStrictEqual(sizes, [100, 100, 30])
  assert.strictEqual(t.posted, 230)
})

test('an event appended while a flush is posting is not lost', async () => {
  const file = tmpQueue()
  sl.enqueue(file, sl.buildEvent({ ...base, outcome: 'sent' }))
  let release
  const gate = new Promise(r => { release = r })
  const posted = []
  const post = async evs => { posted.push(...evs.map(e => e.lead_id)); await gate; return { ok: true, status: 201 } }
  const running = sl.flush({ file, post })
  await new Promise(r => setImmediate(r))
  sl.enqueue(file, sl.buildEvent({ ...base, leadId: 77, outcome: 'sent' })) // a send during the flush
  release()
  await running
  await sl.flush({ file, post })
  assert.deepStrictEqual(posted.sort((a, b) => a - b), [77, base.leadId].sort((a, b) => a - b))
  assert.deepStrictEqual(sl.readLines(file), [])
})

test('flushWithin never holds the end of a run longer than asked', async () => {
  const file = tmpQueue()
  sl.enqueue(file, sl.buildEvent({ ...base, outcome: 'sent' }))
  const t0 = Date.now()
  const r = await sl.flushWithin(100, { file, post: () => new Promise(() => {}) })
  assert.strictEqual(r.status, 'timeout')
  assert.ok(Date.now() - t0 < 1000)
})
