'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const YAML = require('yaml')
const { FILE, load, problemsOf, agentOf, collectors, publicView } = require('../lib/coding-agents')

const reg = load()

test('the shipped registry loads with no problems', () => {
  assert.deepStrictEqual(problemsOf(YAML.parse(fs.readFileSync(FILE, 'utf8'))), [])
})

test('the session report asks for exactly the providers it asked for before the registry', () => {
  // _refreshSessionCache hard-coded these five until #194315. Same routes, same fleet names.
  const before = [['claude-code', 'claude_code'], ['opencode', 'opencode'], ['ollama', 'ollama'], ['codex', 'codex'], ['acp', 'acp']]
  const now = collectors(reg).map((c) => [c.slug, c.name])
  assert.deepStrictEqual(new Set(now.map(String)), new Set(before.map(String)))
  assert.strictEqual(now.length, before.length, 'a collector is asked twice')
})

test('every name the three old tables used lands on one agent', () => {
  // daemon report names, CLI ACP ids, Desktop mark keys — they disagreed; the registry reconciles them.
  const cases = {
    claude_code: 'claude_code', 'claude-code': 'claude_code', claude: 'claude_code',
    codex: 'codex', gemini: 'gemini_cli', gemini_cli: 'gemini_cli', opencode: 'opencode', iris: 'iris', ollama: 'ollama'
  }
  for (const [name, id] of Object.entries(cases)) assert.strictEqual(agentOf(name, null, reg).id, id, name)
})

test('names are matched case-insensitively', () => {
  assert.strictEqual(agentOf('Claude-Code', null, reg).id, 'claude_code')
})

test('an ACP session belongs to the agent underneath it', () => {
  assert.strictEqual(agentOf('acp', 'gemini', reg).id, 'gemini_cli')
  assert.strictEqual(agentOf('acp', 'claude', reg).id, 'claude_code')
})

test('an agent nobody has registered still shows, under its own name, marked unknown', () => {
  assert.deepStrictEqual(agentOf('brand-new-agent', null, reg), { id: null, name: 'brand-new-agent', mark: 'other', status: 'unknown' })
})

test('a bad registry is refused with every problem named, never half-loaded', () => {
  const doc = YAML.parse(fs.readFileSync(FILE, 'utf8'))
  doc.agents.push({ id: 'Bad Id', name: 'x', status: 'planned' })
  doc.agents.push({ id: 'dupe', name: 'Dupe', status: 'weird', aliases: ['claude'] })
  doc.agents.push({ id: 'collected_no_route', name: 'C', status: 'supported', sessions: { can: ['list', 'teleport'] } })
  const p = problemsOf(doc)
  assert.ok(p.some((s) => s.includes('Bad Id') && s.includes('snake_case')), p.join('\n'))
  assert.ok(p.some((s) => s.includes('"claude" belongs to both claude_code and dupe')), p.join('\n'))
  assert.ok(p.some((s) => s.includes('status "weird"')), p.join('\n'))
  assert.ok(p.some((s) => s.includes('collected_no_route') && s.includes('needs sessions.collector')), p.join('\n'))
  assert.ok(p.some((s) => s.includes('"teleport"')), p.join('\n'))
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reg-')), 'coding-agents.yaml')
  fs.writeFileSync(tmp, YAML.stringify(doc))
  assert.throws(() => load(tmp), /not usable/)
})

test('a planned agent cannot carry a collector — it would be asked for sessions it cannot serve', () => {
  const doc = YAML.parse(fs.readFileSync(FILE, 'utf8'))
  doc.agents.find((a) => a.id === 'cursor').sessions.collector = 'cursor'
  assert.ok(problemsOf(doc).some((s) => s.includes('cursor') && s.includes('must not have a collector')))
})

test('the public view carries no paths from this machine', () => {
  const v = JSON.stringify(publicView(reg))
  assert.ok(!v.includes('~/.') && !v.includes(os.homedir()), 'a storage path leaked into the public view')
  assert.ok(publicView(reg).agents.find((a) => a.id === 'codex').can.includes('list'))
})
