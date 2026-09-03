'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { sessionLabel } = require('../daemon/session-label')

const base = { session_id: 'ses_abcdef12345678', project_path: '/Users/x/Sites/freelabel', provider: 'opencode' }

const BOX = String.fromCharCode(0x2500)
const PUA = String.fromCharCode(0xf558)
const ESC = String.fromCharCode(0x1b)

test('a real name is kept', () => {
  assert.strictEqual(sessionLabel({ ...base, name: 'Fixing the intake review flow' }), 'Fixing the intake review flow')
})

test('a box-drawing rule falls back — measured on the live fleet', () => {
  assert.strictEqual(sessionLabel({ ...base, name: BOX.repeat(52) }), 'freelabel · 12345678')
})

test('Nerd Font private-use glyphs are stripped, real text survives', () => {
  // Live value shape: 'agentsmemory<PUA>ATLAS<PUA>Agents…'
  const out = sessionLabel({ ...base, name: `agentsmemory${PUA}ATLAS${PUA}Agents` })
  assert.ok(!out.includes(PUA), 'no private-use characters may survive')
  assert.match(out, /ATLAS/)
})

test('a generated placeholder falls back rather than being shown', () => {
  // 'New session - <iso>' tells you strictly less than the id does.
  for (const n of ['New session - 2026-08-31T16:08:47.414Z', 'OpenCode Session', 'Session', 'untitled']) {
    assert.strictEqual(sessionLabel({ ...base, name: n }), 'freelabel · 12345678', `should fall back: ${n}`)
  }
})

test('control characters cannot reach a terminal', () => {
  const out = sessionLabel({ ...base, name: `hello ${ESC}[31mworld` })
  assert.ok(!out.includes(ESC), 'no escape characters may survive')
  assert.match(out, /hello/)
  assert.match(out, /world/)
})

test('an empty or missing name still yields something usable', () => {
  assert.strictEqual(sessionLabel({ ...base, name: '' }), 'freelabel · 12345678')
  assert.strictEqual(sessionLabel({ ...base }), 'freelabel · 12345678')
})

test('it NEVER returns empty, even with nothing to work from', () => {
  // A blank label in a list is indistinguishable from a rendering bug.
  assert.ok(sessionLabel({}).length > 0)
  assert.ok(sessionLabel(null).length > 0)
  assert.ok(sessionLabel({ provider: 'opencode' }).length > 0)
})

test('a very long name is truncated with an ellipsis', () => {
  const out = sessionLabel({ ...base, name: 'x'.repeat(200) })
  assert.ok(out.length <= 72, `got ${out.length}`)
  assert.ok(out.endsWith('…'))
})

test('the input is not mutated — this only derives', () => {
  const s = { ...base, name: 'Session' }
  sessionLabel(s)
  assert.strictEqual(s.name, 'Session')
})
