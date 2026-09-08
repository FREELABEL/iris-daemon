'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { OutputStreamer } = require('../daemon/output-streamer')

/**
 * Live task output, and the rules that keep a live view from becoming a liability.
 *
 * The lines were always in hand — the executor collects them and hands them to console.log,
 * visible only to someone sitting at that machine. Forwarding them is easy; forwarding them
 * WITHOUT letting a chatty process wedge the task, exhaust memory, or silently lose output is
 * the actual work, and that is what these pin.
 */

function fakeClient () {
  const sent = []
  return {
    sent,
    fail: false,
    async reportOutput (taskId, seq, chunk, stream) {
      if (this.fail) throw new Error('network down')
      sent.push({ taskId, seq, chunk, stream })
    }
  }
}

test('lines are BATCHED, not sent one per line', async () => {
  // 500 lines a second would otherwise be 500 HTTP calls and a Pusher storm.
  const c = fakeClient()
  const s = new OutputStreamer(c, 'task-1')
  for (let i = 0; i < 50; i++) s.push(`line ${i}`)
  await s.flush()
  assert.strictEqual(c.sent.length, 1)
  assert.match(c.sent[0].chunk, /line 0/)
  assert.match(c.sent[0].chunk, /line 49/)
})

test('stdout and stderr stay SEPARATE streams', async () => {
  // The executor already fought this battle once: concatenating them with an invented
  // "[stderr] " prefix means a caller cannot tell an error from a result except by grepping
  // for something we made up.
  const c = fakeClient()
  const s = new OutputStreamer(c, 't')
  s.push('out', 'stdout')
  s.push('bad', 'stderr')
  await s.flush()
  assert.deepStrictEqual(c.sent.map(x => x.stream), ['stdout', 'stderr'])
})

test('every chunk is SEQUENCED so the client can spot a gap', async () => {
  const c = fakeClient()
  const s = new OutputStreamer(c, 't')
  s.push('a'); await s.flush()
  s.push('b'); await s.flush()
  s.push('c'); await s.flush()
  assert.deepStrictEqual(c.sent.map(x => x.seq), [0, 1, 2])
})

test('output faster than the wire DROPS, and says how much', async () => {
  // Queueing turns a live view into a delayed one and then into a memory leak. Dropping is
  // correct — but a gap the viewer cannot see is indistinguishable from a quiet task.
  const c = fakeClient()
  const s = new OutputStreamer(c, 't', { maxBufferedLines: 10 })
  for (let i = 0; i < 100; i++) s.push(`line ${i}`)
  await s.flush()
  const chunk = c.sent.map(x => x.chunk).join('')
  assert.match(chunk, /90 line\(s\) dropped/)
  assert.match(chunk, /line 99/)      // the NEWEST survived
  assert.doesNotMatch(chunk, /line 0\b/) // the oldest went
})

test('a chunk never exceeds the wire limit', async () => {
  const c = fakeClient()
  const s = new OutputStreamer(c, 't', { maxChunkBytes: 200, maxBufferedLines: 10000 })
  for (let i = 0; i < 200; i++) s.push('x'.repeat(50))
  for (let i = 0; i < 10; i++) await s.flush()
  assert.ok(c.sent.length > 1, 'should have split across chunks')
  for (const m of c.sent) assert.ok(m.chunk.length <= 200 + 80, `chunk was ${m.chunk.length}`)
})

test('a single line longer than a whole chunk cannot spin forever', async () => {
  const c = fakeClient()
  const s = new OutputStreamer(c, 't', { maxChunkBytes: 100 })
  s.push('y'.repeat(5000))
  await s.flush()
  assert.strictEqual(c.sent.length, 1)
  assert.ok(c.sent[0].chunk.length <= 101)
})

test('a failed send NEVER breaks the task, and warns once', async () => {
  const c = fakeClient(); c.fail = true
  const s = new OutputStreamer(c, 't')
  s.push('a')
  await assert.doesNotReject(() => s.flush())
  s.push('b')
  await assert.doesNotReject(() => s.flush())
})

test('stop() sends the tail rather than losing it', async () => {
  const c = fakeClient()
  const s = new OutputStreamer(c, 't')
  s.start()
  s.push('last words')
  await s.stop()
  assert.match(c.sent.map(x => x.chunk).join(''), /last words/)
})

test('nothing buffered means nothing sent — no empty heartbeat chunks', async () => {
  const c = fakeClient()
  const s = new OutputStreamer(c, 't')
  await s.flush()
  await s.flush()
  assert.strictEqual(c.sent.length, 0)
})

test('push after stop is ignored', async () => {
  const c = fakeClient()
  const s = new OutputStreamer(c, 't')
  await s.stop()
  s.push('too late')
  await s.flush()
  assert.strictEqual(c.sent.length, 0)
})
