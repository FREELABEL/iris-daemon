// #192164: what happened after we pressed send. Fixture shapes are copied from a read-only inbox read on
// 2026-11-01: the refusal is its own message, content_type REACHABILITY_SETTINGS_ONE_WAY_SEND_XMAT, from us.
const test = require('node:test')
const assert = require('node:assert')
const { classifyDelivery, parseThreadPayload, scopedThreadText } = require('../som/helpers/delivery-check')

const MSG = 'Hey, saw your comment on the roadmap post'
const REFUSAL = "This account can't receive your message because they don't allow new message requests from everyone."
const node = (over) => ({ sender_fbid: 'me', content_type: 'TEXT', text_body: MSG, timestamp_ms: '1000', ...over })
const payload = (nodes, username = 'them') => ({
  data: { get_slide_thread_nullable: { as_ig_direct_thread: {
    users: [{ username }], viewer: { interop_messaging_user_fbid: 'me' }, slide_messages: { edges: nodes.map(n => ({ node: n })) },
  } } },
})
const refusalNode = node({ content_type: 'REACHABILITY_SETTINGS_ONE_WAY_SEND_XMAT', text_body: null, igd_snippet: REFUSAL, timestamp_ms: '1001' })
const parse = (nodes, username) => parseThreadPayload(payload(nodes, username), 'them')

test('the refusal wording in the open thread is undeliverable, even with the message on screen', () => {
  for (const text of [REFUSAL, REFUSAL.replace("can't", 'can’t').replace("don't", 'don’t')]) {
    assert.strictEqual(classifyDelivery({ bubbleVisible: true, threadText: text, message: MSG }).outcome, 'undeliverable')
  }
})

test('the refusal message type is undeliverable in any language', () => {
  const nodes = [node(), { ...refusalNode, igd_snippet: 'Esta cuenta no puede recibir tu mensaje.' }]
  const c = classifyDelivery({ bubbleVisible: true, threadText: '', payload: parse(nodes), message: MSG })
  assert.strictEqual(c.outcome, 'undeliverable')
})

test('sent needs the thread read back: our message there, no refusal', () => {
  const c = classifyDelivery({ bubbleVisible: true, threadText: MSG, payload: parse([node()]), message: MSG })
  assert.deepStrictEqual(c, { outcome: 'sent', reason: '' })
})

test('a message on screen we could not read back is unknown, never sent', () => {
  const c = classifyDelivery({ bubbleVisible: true, threadText: MSG, payload: null, message: MSG })
  assert.strictEqual(c.outcome, 'delivered-unknown')
})

test('new warning wording is unknown, not sent', () => {
  const c = classifyDelivery({ bubbleVisible: true, threadText: "Couldn't send. Tap to retry.", payload: parse([node()]), message: MSG })
  assert.strictEqual(c.outcome, 'delivered-unknown')
})

test('our message missing from the read-back is unknown', () => {
  const c = classifyDelivery({ bubbleVisible: true, threadText: '', payload: parse([node({ text_body: 'something older' })]), message: MSG })
  assert.strictEqual(c.outcome, 'delivered-unknown')
})

test('a bubble we missed but the read-back holds is sent', () => {
  assert.strictEqual(classifyDelivery({ bubbleVisible: false, threadText: '', payload: parse([node()]), message: MSG }).outcome, 'sent')
})

test('a read-back of someone else\'s thread is not read back', () => {
  assert.strictEqual(parse([node()], 'someone_else'), null)
})

test('only the open thread counts: a mailbox payload full of other people\'s refusals is ignored', () => {
  const mailbox = { data: { get_slide_mailbox_for_iris_subscription: { threads_by_folder: { edges: [{ node: { as_ig_direct_thread: {
    users: [{ username: 'them' }], viewer: { interop_messaging_user_fbid: 'me' }, slide_messages: { edges: [{ node: refusalNode }] },
  } } }] } } } }
  assert.strictEqual(parseThreadPayload(mailbox, 'them'), null)
})

test('an older refusal followed by a later message of ours is judged by what came after', () => {
  const nodes = [node({ text_body: 'old', timestamp_ms: '1' }), { ...refusalNode, timestamp_ms: '2' }, node({ timestamp_ms: '3' })]
  assert.strictEqual(classifyDelivery({ bubbleVisible: true, threadText: '', payload: parse(nodes), message: MSG }).outcome, 'sent')
})

// The thread list beside an open thread previews other people's refusals (#192164). Reading the whole
// page, as post-run did, calls everyone after the first refusal undeliverable.
test('scoped text drops the thread list', () => {
  const blocks = [{ inThreadList: true, text: REFUSAL }, { inThreadList: false, text: MSG }]
  assert.strictEqual(scopedThreadText(blocks), MSG)
  assert.strictEqual(classifyDelivery({ bubbleVisible: true, threadText: scopedThreadText(blocks), payload: parse([node()]), message: MSG }).outcome, 'sent')
})

// The whole check against a stand-in page: no browser, no Instagram.
const { checkDelivery } = require('../som/helpers/delivery-check')
function fakePage ({ text = '', body = null, reloadThrows = false }) {
  const listeners = []
  return {
    waitForTimeout: async () => {},
    evaluate: async () => [{ inThreadList: false, text }],
    on: (_, fn) => listeners.push(fn),
    off: () => {},
    reload: async () => {
      if (reloadThrows) throw new Error('net')
      if (body) for (const fn of listeners) await fn({ url: () => 'https://www.instagram.com/api/graphql', text: async () => JSON.stringify(body) })
    },
  }
}
const opts = { handle: 'them', message: MSG, bubbleVisible: true, settleMs: 0 }

test('checkDelivery: refused on screen, refused in the read-back, clean, and unreadable', async () => {
  assert.strictEqual((await checkDelivery(fakePage({ text: REFUSAL }), opts)).outcome, 'undeliverable')
  assert.strictEqual((await checkDelivery(fakePage({ body: payload([node(), refusalNode]) }), opts)).outcome, 'undeliverable')
  assert.strictEqual((await checkDelivery(fakePage({ body: payload([node()]) }), opts)).outcome, 'sent')
  assert.strictEqual((await checkDelivery(fakePage({ reloadThrows: true }), opts)).outcome, 'delivered-unknown')
})

// The batch is one long Playwright spec; these pin the order that makes a double-send impossible.
const fs = require('fs')
const path = require('path')
const spec = fs.readFileSync(path.join(__dirname, '../som/batch-with-login.spec.ts'), 'utf8')

test('both send paths write the intent before pressing send, and check delivery before recording', () => {
  const sends = [...spec.matchAll(/dmGuard\.writeIntent\(/g)].map(m => m.index)
  assert.strictEqual(sends.length, 2)
  for (const at of sends) {
    const after = spec.slice(at, at + 2500)
    assert.ok(after.indexOf('dmGuard.writeIntent') < after.indexOf('sendBtn.click'))
    assert.ok(after.indexOf('sendBtn.click') < after.indexOf('checkDelivery'))
  }
  assert.strictEqual([...spec.matchAll(/apiClient\.recordDmSent\(/g)].length, 2)
  assert.doesNotMatch(spec, /if \((uiD|d)elivered\) \{/) // the bubble alone never records a send again
})
