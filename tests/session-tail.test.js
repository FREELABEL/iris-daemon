'use strict'

const test = require('node:test')
const assert = require('node:assert')

const {
  chunkStart, dropPartialLine, messagesFromChunk, readTail, readSince,
  FIRST_TAIL_BYTES, MAX_TAIL_BYTES, MAX_TEXT,
} = require('../lib/session-tail')

/**
 * A transcript page is the TAIL of an append-only file, and a refresh is the bytes appended since.
 *
 * MEASURED 2026-09-17: the history route parsed the whole file to answer either question — 40.7MB
 * read and 1,876 message objects built to return 60, when the 60 lived in the last 704KB. 57:1 on
 * bytes, 31:1 on objects, 1.09s of CPU per poll per viewer.
 */

// A fake fs that serves one string, so the read arithmetic is tested without touching a disk.
const fakeFs = (content) => {
  const buf = Buffer.from(content, 'utf8')
  return {
    size: buf.length,
    openSync: () => 1,
    closeSync: () => {},
    readSync: (_fd, out, off, len, pos) => buf.copy(out, off, pos, Math.min(pos + len, buf.length)),
  }
}

const line = (o) => JSON.stringify(o) + '\n'
const said = (role, text, ts) => line({ type: role, timestamp: ts, message: { role, content: [{ type: 'text', text }] } })

test('the read starts near the END of the file, and never before it begins', () => {
  assert.strictEqual(chunkStart(40_000_000, 1_000_000), 39_000_000)
  assert.strictEqual(chunkStart(500, 1_000_000), 0, 'a small file is read whole')
  assert.strictEqual(chunkStart(0, 1_000_000), 0)
})

test('a tail landing mid-line discards the truncated line — but a read from byte 0 does not', () => {
  const chunk = 'ted":"x"}\n{"whole":1}\n'
  assert.strictEqual(dropPartialLine(chunk, 100), '{"whole":1}\n')
  assert.strictEqual(dropPartialLine(chunk, 0), chunk, 'byte 0 is a real line start')
  // A tail with no newline at all is entirely one truncated line: nothing usable.
  assert.strictEqual(dropPartialLine('no newline here', 100), '')
})

test('a chunk becomes the messages the panel renders, and nothing else', () => {
  const chunk = [
    said('user', 'fix the gate', '2026-09-17T10:00:00Z'),
    line({ type: 'system', message: { role: 'user', content: [{ type: 'text', text: 'NOT a message' }] } }),
    line({ type: 'assistant', timestamp: '2026-09-17T10:01:00Z', message: { role: 'assistant', content: [
      { type: 'text', text: 'running it' },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/a/b/Gate.php' } },
      { type: 'tool_use', name: 'Read', input: { file_path: '/a/b/Gate.php' } },
      { type: 'tool_use', name: 'WebSearch', input: { q: 'x' } },
      { type: 'tool_result', content: 'huge output that must never be sent' },
    ] } }),
  ].join('')

  const msgs = messagesFromChunk(chunk)
  assert.deepStrictEqual(msgs.map((m) => [m.role, m.type, m.tool || m.text || '']), [
    ['user', 'text', 'fix the gate'],
    ['assistant', 'text', 'running it'],
    ['assistant', 'tool_use', 'Bash'],
    ['assistant', 'tool_use', 'Edit'],
    ['assistant', 'tool_use', 'Read'],
    ['assistant', 'tool_use', 'WebSearch'],
  ])
  assert.strictEqual(msgs[2].command, 'npm test')
  assert.strictEqual(msgs[3].file_path, '/a/b/Gate.php')
  assert.strictEqual(msgs.some((m) => m.type === 'tool_result'), false, 'tool results never leave the machine')
})

test('a message body is bounded, and a truncated JSON line is skipped not thrown', () => {
  const chunk = said('user', 'x'.repeat(5000), '2026-09-17T10:00:00Z') + '{"type":"user","mess\n'
  const msgs = messagesFromChunk(chunk)
  assert.strictEqual(msgs.length, 1)
  assert.strictEqual(msgs[0].text.length, MAX_TEXT)
})

test('readTail returns the LAST n messages and says where it started reading', () => {
  const content = Array.from({ length: 200 }, (_, i) => said('user', `m${i}`, `2026-09-17T10:00:${String(i % 60).padStart(2, '0')}Z`)).join('')
  const fs = fakeFs(content)
  const out = readTail(fs, '/x.jsonl', fs.size, 5)
  assert.deepStrictEqual(out.messages.map((m) => m.text), ['m195', 'm196', 'm197', 'm198', 'm199'])
  assert.strictEqual(out.offset, fs.size, 'the cursor is the file size at read time')
})

test('a tail too small for the page is widened, not answered short', () => {
  // Each message is ~120 bytes; asking for 40 from a 300-byte window must read further back.
  const content = Array.from({ length: 200 }, (_, i) => said('user', `m${i}`, '2026-09-17T10:00:00Z')).join('')
  const fs = fakeFs(content)
  const out = readTail(fs, '/x.jsonl', fs.size, 40, { tailBytes: 300 })
  assert.strictEqual(out.messages.length, 40)
  assert.strictEqual(out.messages[39].text, 'm199')
})

test('a file smaller than the window is read whole, and a short session is not padded', () => {
  const fs = fakeFs(said('user', 'only one', '2026-09-17T10:00:00Z'))
  const out = readTail(fs, '/x.jsonl', fs.size, 60)
  assert.strictEqual(out.messages.length, 1)
  assert.strictEqual(out.from, 0)
})

test('readSince reads ONLY the appended bytes — the whole point', () => {
  const head = Array.from({ length: 50 }, (_, i) => said('user', `old${i}`, '2026-09-17T10:00:00Z')).join('')
  const tail = said('assistant', 'brand new', '2026-09-17T11:00:00Z')
  const fs = fakeFs(head + tail)
  const out = readSince(fs, '/x.jsonl', fs.size, head.length)
  assert.deepStrictEqual(out.messages.map((m) => m.text), ['brand new'])
  assert.strictEqual(out.offset, fs.size)
  assert.strictEqual(out.bytesRead, tail.length, 'reads the appended bytes and not one more')
})

test('a half-written line is neither returned nor skipped — the cursor waits for the newline', () => {
    // Claude Code is appending WHILE we read. Consuming a fragment would lose that message for
    // good, because the next read starts after it. The cursor stops at the last complete line.
    const done = said('user', 'complete', '2026-09-17T10:00:00Z')
    const half = '{"type":"assistant","timestamp":"2026-09-17T10:01:00Z","mess'
    const fs1 = fakeFs(done + half)
    const a = readSince(fs1, '/x.jsonl', fs1.size, 0)
    assert.deepStrictEqual(a.messages.map((m) => m.text), ['complete'])
    assert.strictEqual(a.offset, done.length, 'the cursor stops before the fragment, not after it')

    // The line finishes; reading from that cursor returns it exactly once.
    const fs2 = fakeFs(done + said('assistant', 'was half written', '2026-09-17T10:01:00Z'))
    const b = readSince(fs2, '/x.jsonl', fs2.size, a.offset)
    assert.deepStrictEqual(b.messages.map((m) => m.text), ['was half written'])
    assert.strictEqual(b.offset, fs2.size)
})

test('a tail read also stops at the last complete line', () => {
    const content = Array.from({ length: 20 }, (_, i) => said('user', `m${i}`, '2026-09-17T10:00:00Z')).join('') + '{"partial'
    const fs = fakeFs(content)
    const out = readTail(fs, '/x.jsonl', fs.size, 3)
    assert.deepStrictEqual(out.messages.map((m) => m.text), ['m17', 'm18', 'm19'])
    assert.strictEqual(out.offset, fs.size - '{"partial'.length)
})

test('nothing appended costs nothing and returns nothing', () => {
  const content = said('user', 'hi', '2026-09-17T10:00:00Z')
  const fs = fakeFs(content)
  let reads = 0
  const counted = { ...fs, readSync: (...a) => { reads += 1; return fs.readSync(...a) } }
  const out = readSince(counted, '/x.jsonl', fs.size, fs.size)
  assert.deepStrictEqual(out.messages, [])
  assert.strictEqual(out.offset, fs.size)
  assert.strictEqual(reads, 0, 'an unchanged file is never opened')
})

test('a file that SHRANK means the cursor is meaningless — say reset, do not read garbage', () => {
  const fs = fakeFs(said('user', 'hi', '2026-09-17T10:00:00Z'))
  const out = readSince(fs, '/x.jsonl', fs.size, fs.size + 5000)
  assert.strictEqual(out.reset, true)
  assert.deepStrictEqual(out.messages, [])
})

test('the windows are bounded so one request cannot read an unbounded file', () => {
  assert.ok(FIRST_TAIL_BYTES <= MAX_TAIL_BYTES)
  assert.ok(MAX_TAIL_BYTES <= 64 * 1024 * 1024)
})

test('a reader too far behind is told to refetch, not handed an unbounded response', () => {
    // Away for ten minutes, 400 messages appended: streaming them all grows the panel without
    // bound and the client would have to reconcile a page with a flood. A page refetch IS the
    // answer at that point, so say so instead of inventing a merge.
    const content = Array.from({ length: 300 }, (_, i) => said('user', `m${i}`, '2026-09-17T10:00:00Z')).join('')
    const fs = fakeFs(content)
    const out = readSince(fs, '/x.jsonl', fs.size, 0, { max: 60 })
    assert.strictEqual(out.truncated, true)
    assert.deepStrictEqual(out.messages, [])

    // Just under the cap streams normally.
    const small = fakeFs(Array.from({ length: 5 }, (_, i) => said('user', `m${i}`, '2026-09-17T10:00:00Z')).join(''))
    const ok = readSince(small, '/x.jsonl', small.size, 0, { max: 60 })
    assert.strictEqual(ok.truncated, undefined)
    assert.strictEqual(ok.messages.length, 5)
})
