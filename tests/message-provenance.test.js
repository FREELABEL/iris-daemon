'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { provenanceOf, cleanProvenance } = require('../lib/message-provenance')

// #190650 — a message the Hive puts into a live session said who sent it only in visible text.
// A shared session needs it structured: sender, source session/node, model, and whose usage paid.

const NOW = Date.parse('2026-10-23T02:00:00Z')

test('fills what the daemon knows and what the sender supplied', () => {
  const p = provenanceOf(
    { id: 'tsk_1', user_id: 193 },
    { from: 'iris-hive-001', source_session_id: 'ses_abc', source_node: 'Alexs-MacBook', source_provider: 'claude_code', model: 'claude-x', room_id: 42 },
    NOW
  )
  assert.deepStrictEqual(p, {
    v: 1, via: 'iris_hive', sender: 'iris-hive-001', task_id: 'tsk_1', requested_by_user_id: 193, usage_owner_user_id: 193,
    source_session_id: 'ses_abc', source_node: 'Alexs-MacBook', source_provider: 'claude_code', model: 'claude-x', room_id: 42,
    sent_at: '2026-10-23T02:00:00.000Z'
  })
})

test('usage owner defaults to the requester, and a Room can name someone else', () => {
  assert.strictEqual(provenanceOf({ user_id: 5 }, {}, NOW).usage_owner_user_id, 5)
  assert.strictEqual(provenanceOf({ user_id: 5 }, { usage_owner_user_id: 7 }, NOW).usage_owner_user_id, 7)
})

test('whitelisted and bounded: unknown keys dropped, bad ids dropped, long text clipped', () => {
  const p = provenanceOf({ id: 'x; rm -rf /' }, { from: 'a'.repeat(500), model: 'm', evil: '<script>', source_session_id: '../../etc' }, NOW)
  assert.strictEqual(p.task_id, undefined)
  assert.strictEqual(p.source_session_id, undefined)
  assert.strictEqual(p.sender.length, 64)
  assert.ok(!('evil' in p))
})

test('the bridge re-checks what arrives over HTTP', () => {
  assert.strictEqual(cleanProvenance(null), null)
  assert.strictEqual(cleanProvenance('x'), null)
  assert.strictEqual(cleanProvenance([1]), null)
  const c = cleanProvenance({ sender: 'n', task_id: 't1', requested_by_user_id: 9, model: 'm', extra: { deep: 1 }, sent_at: '2026-10-23T02:00:00Z' })
  assert.deepStrictEqual(Object.keys(c).sort(), ['model', 'requested_by_user_id', 'sender', 'sent_at', 'task_id', 'usage_owner_user_id', 'v', 'via'].sort())
  assert.strictEqual(c.sent_at, '2026-10-23T02:00:00.000Z')
})

test('wired: the executor sends it and the opencode route attaches it to the part, prefix kept', () => {
  const EXEC = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'task-executor.js'), 'utf8')
  assert.match(EXEC, /provenance: require\('\.\.\/lib\/message-provenance'\)\.provenanceOf\(task, sessionConfig\)/)
  const BRIDGE = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
  assert.match(BRIDGE, /cleanProvenance\(req\.body && req\.body\.provenance\)/)
  assert.match(BRIDGE, /metadata: \{ iris_provenance: provenance \}/)
  assert.match(BRIDGE, /\[via iris \\u00b7 \$\{String\(from\)\.slice\(0, 64\)\}\]/)   // visible prefix unchanged
})
