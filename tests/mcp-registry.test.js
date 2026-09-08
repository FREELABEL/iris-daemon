'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { loadRegistry, resolveServer, advertisement } = require('../daemon/mcp-registry')

/**
 * The allowlist IS the security model for mcp_call.
 *
 * A task names a server; it never supplies a command. So the only way the cloud can make this
 * machine run something is if this machine's owner already wrote it down. Every test here is
 * about one of two things: that an unknown name is refused, and that "I could not read the
 * list" never collapses into "the list is empty" — one is a broken node, the other is a node
 * that opted out, and they need opposite reactions.
 */

function tmp (contents) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-reg-')), 'mcp-servers.json')
  if (contents !== null) fs.writeFileSync(f, contents)
  return f
}

const GOOD = JSON.stringify({ argent: { command: 'npx', args: ['-y', '@swmansion/argent', 'mcp'] } })

test('a listed server resolves to something spawnable', () => {
  const r = resolveServer('argent', tmp(GOOD))
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.server.command, 'npx')
})

test('an UNLISTED name is refused, and the refusal names what IS allowed', () => {
  const r = resolveServer('anything-else', tmp(GOOD))
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /not allowed on this node/)
  assert.match(r.reason, /argent/) // tells you what you could have asked for
})

test('a task can never smuggle a command past the allowlist', () => {
  // The registry only ever reads the FILE. Whatever a task sends is a name and nothing else,
  // so there is no field here that could carry an executable.
  const { servers } = loadRegistry(tmp(GOOD))
  assert.deepStrictEqual(Object.keys(servers), ['argent'])
  const r = resolveServer('argent', tmp(GOOD))
  assert.ok(!('prompt' in r.server) && !('shell' in r.server))
})

test('a MALFORMED file is an error, not an empty allowlist', () => {
  // The bug this prevents: a trailing comma silently disables every MCP tool on the node and
  // the refusal says "not allowed", sending someone to edit a list that is already correct.
  const f = tmp('{ "argent": { "command": "npx" },, }')
  const reg = loadRegistry(f)
  assert.notStrictEqual(reg.error, null)
  const r = resolveServer('argent', f)
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /unreadable/)
  assert.doesNotMatch(r.reason, /not allowed/)
})

test('NO file at all is a clean opt-out, and says where to add one', () => {
  const r = resolveServer('argent', '/nonexistent/mcp-servers.json')
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /no MCP servers are configured/)
  assert.match(r.reason, /nonexistent/) // the path, so the fix is obvious
})

test('entries without a command are dropped rather than half-trusted', () => {
  const f = tmp(JSON.stringify({ ok: { command: 'npx' }, broken: { args: ['x'] }, alsoBroken: 'nope' }))
  assert.deepStrictEqual(Object.keys(loadRegistry(f).servers), ['ok'])
})

test('a name that is not a plain identifier is ignored', () => {
  const f = tmp(JSON.stringify({ 'evil; rm -rf /': { command: 'sh' }, fine: { command: 'npx' } }))
  assert.deepStrictEqual(Object.keys(loadRegistry(f).servers), ['fine'])
})

test('a Claude Desktop / Cursor style file works unmodified', () => {
  // People will copy the file they already have. Making them rewrite it is friction with no
  // security value — the shape differs, the trust model does not.
  const f = tmp(JSON.stringify({ mcpServers: { argent: { command: 'npx', args: [] } } }))
  assert.strictEqual(resolveServer('argent', f).ok, true)
})

test('the advert carries names, NEVER commands', () => {
  // This goes to the cloud on every heartbeat. The fleet needs to know which servers a node
  // offers so work can be routed; how they are launched is the machine's business.
  const a = advertisement(tmp(GOOD))
  assert.deepStrictEqual(a.functions, ['argent'])
  assert.ok(!JSON.stringify(a).includes('npx'))
})

test('an unreadable list advertises UNAVAILABLE with the reason, not silence', () => {
  const a = advertisement(tmp('not json at all'))
  assert.strictEqual(a.available, false)
  assert.match(a.reason, /not valid JSON/)
})
