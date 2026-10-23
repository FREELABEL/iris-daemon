'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { listServerSessions, mergeSessionRows, historyFromServerMessages, rowFromServerSession } = require('../lib/server-sessions')

/**
 * IRIS Desktop's chats were invisible to the fleet (epic #189446, K2): the lister read the 1.3.x
 * JSON store, and Desktop (opencode 1.18.23) keeps sessions in SQLite. These ask the running
 * servers instead — the shapes below are opencode 1.18.23's GlobalSession and {info, parts}.
 */

const T = Date.parse('2026-10-14T20:00:00Z')

const desktopRow = (id, updated, extra = {}) => ({
  id,
  slug: 'brave-otter',
  projectID: 'p1',
  directory: '/Users/alex/sites/freelabel',
  title: 'Fix the login page',
  version: '1.18.23',
  time: { created: updated - 60000, updated },
  model: { providerID: 'iris', modelID: 'gpt-4.1-nano' },
  project: { id: 'p1', worktree: '/Users/alex/sites/freelabel' },
  ...extra,
})

test('a Desktop session becomes a lister row, with its model and the server that holds it', () => {
  const r = rowFromServerSession(desktopRow('ses_1', T), 'http://127.0.0.1:61234')
  assert.equal(r.session_id, 'ses_1')
  assert.equal(r.name, 'Fix the login page')
  assert.equal(r.project_path, '/Users/alex/sites/freelabel')
  assert.equal(r.model, 'iris/gpt-4.1-nano')
  assert.equal(r.updated_at, new Date(T).toISOString())
  assert.equal(r.provider, 'opencode')
  assert.equal(r.server, 'http://127.0.0.1:61234')
})

test('rows without an id are dropped, not reported as "Session"', () => {
  assert.equal(rowFromServerSession({ title: 'x' }, 'b'), null)
  assert.equal(rowFromServerSession(null, 'b'), null)
})

test('asks every server once, for root sessions only, and ignores servers that answer HTML', async () => {
  const asked = []
  const fetchJson = async (url) => {
    asked.push(url)
    if (url.startsWith('http://127.0.0.1:61234')) return [desktopRow('ses_1', T)]
    return null // the 1.3.x CLI: unknown route → web UI HTML → null
  }
  const { rows, asked: n, answered } = await listServerSessions({
    servers: ['http://127.0.0.1:61234', 'http://127.0.0.1:4096'],
    fetchJson,
    limit: 25,
  })
  assert.equal(n, 2)
  assert.equal(answered, 1)
  assert.deepEqual(rows.map(r => r.session_id), ['ses_1'])
  assert.ok(asked.every(u => u.includes('/experimental/session?roots=true&limit=25')), asked.join('\n'))
})

test('a server that throws or times out contributes nothing and does not throw', async () => {
  const { rows, answered } = await listServerSessions({
    servers: ['http://a', 'http://b'],
    fetchJson: async (url) => { if (url.startsWith('http://a')) throw new Error('timeout'); return [desktopRow('ses_2', T)] },
  })
  assert.equal(answered, 1)
  assert.deepEqual(rows.map(r => r.session_id), ['ses_2'])
})

test('the same session from a file and a server is listed ONCE, freshest wins, gaps filled', () => {
  const file = { session_id: 'ses_1', name: 'old title', updated_at: new Date(T - 3600000).toISOString(), git_branch: 'main', model: null, provider: 'opencode' }
  const server = rowFromServerSession(desktopRow('ses_1', T), 'http://s')
  const [m, ...rest] = mergeSessionRows([file], [server], 25)
  assert.equal(rest.length, 0)
  assert.equal(m.name, 'Fix the login page') // server row is fresher
  assert.equal(m.model, 'iris/gpt-4.1-nano')
  assert.equal(m.git_branch, 'main') // filled from the file row, not nulled by the server row
})

test('merge sorts freshest first and honours the limit', () => {
  const rows = [
    rowFromServerSession(desktopRow('a', T - 3000), 's'),
    rowFromServerSession(desktopRow('b', T), 's'),
    rowFromServerSession(desktopRow('c', T - 1000), 's'),
  ]
  assert.deepEqual(mergeSessionRows([], rows, 2).map(r => r.session_id), ['b', 'c'])
})

test('a transcript from the server reads like the file-based history', () => {
  const items = [
    { info: { role: 'user', time: { created: T } }, parts: [{ type: 'text', text: 'fix the login page' }] },
    {
      info: { role: 'assistant', time: { created: T + 1000 } },
      parts: [
        { type: 'step-start' },
        { type: 'tool', tool: 'edit', state: { status: 'completed', input: { filePath: '/x/login.vue' } } },
        { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'npm test' } } },
        { type: 'text', text: 'Done.' },
        { type: 'text', text: 'injected', synthetic: true },
      ],
    },
  ]
  const h = historyFromServerMessages(items)
  assert.deepEqual(h.messages.map(m => m.type === 'text' ? m.text : m.tool), ['fix the login page', 'edit', 'bash', 'Done.'])
  assert.deepEqual(h.summary.files_edited, ['/x/login.vue'])
  assert.deepEqual(h.summary.commands_run, ['npm test'])
  assert.equal(h.summary.user_messages, 1)
  assert.equal(h.summary.assistant_messages, 1)
})

test('a long transcript keeps the NEWEST messages — it is opened to see what is happening now', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ info: { role: 'user', time: { created: T + i } }, parts: [{ type: 'text', text: `m${i}` }] }))
  assert.deepEqual(historyFromServerMessages(items, 3).messages.map(m => m.text), ['m7', 'm8', 'm9'])
})

// #190957 — a page must say how much it left out. 10 of 257 entries read as the whole chat.
test('historyFromServerMessages: messages_total is the whole session, summary counts all of it', () => {
  const { historyFromServerMessages } = require('../lib/server-sessions')
  const items = Array.from({ length: 6 }, (_, i) => ({ info: { role: i % 2 ? 'assistant' : 'user', time: { created: 1792771558371 + i } }, parts: [{ type: 'text', text: `m${i}` }] }))
  const h = historyFromServerMessages(items, 2)
  assert.strictEqual(h.messages.length, 2)
  assert.strictEqual(h.messages_total, 6)
  assert.strictEqual(h.summary.total_messages, 6)
  const { omittedFrom } = require('../lib/session-history-request')
  assert.strictEqual(omittedFrom(h.messages_total, 0, h.messages.length), 4)
})
