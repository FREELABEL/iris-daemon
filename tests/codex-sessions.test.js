'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { codexSessionFromChunks, listCodexSessions } = require('../lib/codex-sessions')

// #188539 — Codex sessions in the fleet. Lines below are the SHAPE Codex's own test helper writes
// (openai/codex codex-rs/app-server/tests/common/rollout.rs, read 2026-10-08): session_meta first,
// then response_item + event_msg user_message; turn_context carries the model.
const J = (o) => JSON.stringify(o)
const ID = '0199c3f2-6b1a-7c42-9d1e-1a2b3c4d5e6f'
const meta = (ts, extra = {}) => J({ timestamp: ts, type: 'session_meta', payload: { id: ID, timestamp: ts, cwd: '/home/u/shop/api', originator: 'codex_cli_rs', cli_version: '0.50.0', model_provider: 'openai', git: { commit_hash: 'abc', branch: 'feat/checkout', repository_url: 'https://github.com/u/shop' }, ...extra } })
const prompt = (ts, text) => [J({ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }), J({ timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message: text, kind: 'plain' } })].join('\n')
const turn = (ts, model) => J({ timestamp: ts, type: 'turn_context', payload: { cwd: '/home/u/shop/api', model } })

test('a rollout becomes a session: id, project, branch, model, first prompt, last activity', () => {
  const head = [meta('2026-10-08T09:00:00.000Z'), prompt('2026-10-08T09:00:01.000Z', 'Add Stripe checkout to the pricing page'), turn('2026-10-08T09:00:02.000Z', 'gpt-5-codex')].join('\n')
  const tail = turn('2026-10-08T09:40:00.000Z', 'gpt-5-codex')
  assert.deepStrictEqual(codexSessionFromChunks(head, tail, 'x'), {
    session_id: ID,
    name: 'Add Stripe checkout to the pricing page',
    project_path: '/home/u/shop/api',
    git_branch: 'feat/checkout',
    model: 'gpt-5-codex',
    created_at: '2026-10-08T09:00:00.000Z',
    updated_at: '2026-10-08T09:40:00.000Z',
    message_count: null,
    provider: 'codex'
  })
})

test('no session_meta → not a session; missing git/model/prompt degrade, never throw', () => {
  assert.strictEqual(codexSessionFromChunks(prompt('2026-10-08T09:00:00Z', 'hi'), '', 'x'), null)
  assert.strictEqual(codexSessionFromChunks('', '', 'x'), null)
  const s = codexSessionFromChunks(J({ timestamp: '2026-10-08T09:00:00Z', type: 'session_meta', payload: { id: ID, timestamp: '2026-10-08T09:00:00Z', cwd: '/x', model_provider: 'openai' } }), '{"cut', 'x')
  assert.strictEqual(s.git_branch, null)
  assert.strictEqual(s.model, 'openai')
  assert.strictEqual(s.name, 'Codex session')
})

function home (files) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'codexhome-'))
  for (const [rel, body, mtime] of files) {
    const p = path.join(h, 'sessions', rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body + '\n')
    if (mtime) fs.utimesSync(p, mtime, mtime)
  }
  return h
}

test('lists newest first across day directories, respects the limit, honours CODEX_HOME', () => {
  const older = meta('2026-10-01T10:00:00.000Z').replace(ID, '11111111-1111-1111-1111-111111111111')
  const newer = meta('2026-10-08T10:00:00.000Z').replace(ID, '22222222-2222-2222-2222-222222222222')
  const h = home([
    ['2026/10/01/rollout-2026-10-01T10-00-00-11111111-1111-1111-1111-111111111111.jsonl', older],
    ['2026/10/08/rollout-2026-10-08T10-00-00-22222222-2222-2222-2222-222222222222.jsonl', newer],
    ['2026/10/08/notes.txt', 'not a rollout']
  ])
  const all = listCodexSessions(fs, { CODEX_HOME: h, HOME: '/nowhere' }, 10)
  assert.deepStrictEqual(all.map((s) => s.session_id), ['22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111'])
  assert.strictEqual(listCodexSessions(fs, { CODEX_HOME: h }, 1).length, 1)
})

test('no Codex on this machine is an empty list, not an error', () => {
  assert.deepStrictEqual(listCodexSessions(fs, { HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'nocodex-')) }, 10), [])
})

test('wired: the bridge serves it and the heartbeat asks for it', () => {
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8'), /app\.get\('\/api\/sessions\/codex'/)
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'daemon', 'index.js'), 'utf8'), /\{ slug: 'codex', name: 'codex' \}/)
})
