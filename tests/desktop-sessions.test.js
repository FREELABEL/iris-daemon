'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const {
  desktopDataHomes, desktopDb, openReader, listDesktopSessions, desktopSessionHistory, literal
} = require('../lib/desktop-sessions')

// #190648 — Hive listed 25 opencode sessions on a Mac, none of them IRIS Desktop's.

function home () {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-sessions-'))
  fs.mkdirSync(path.join(h, '.iris', 'accounts', 'default', 'opencode'), { recursive: true })
  return h
}

/** A reader that answers from rows, so the logic is tested on any Node. */
function fakeReader (tables) {
  return () => ({
    all: (sql, params) => {
      if (/FROM session s WHERE s\.time_archived IS NULL/.test(sql)) return tables.list.slice(0, params[0])
      if (/FROM session WHERE id = \?/.test(sql)) return tables.list.filter((r) => r.id === params[0])
      if (/FROM message m JOIN part p/.test(sql)) return (tables.parts[params[0]] || [])
      return []
    },
    close: () => {}
  })
}

test('data homes: the default account plus every account folder, never a key', () => {
  const h = home()
  fs.writeFileSync(path.join(h, '.iris', 'accounts.json'), JSON.stringify({
    accounts: [{ user_id: 5498, key: 'iris_live_SECRET', data_dir: '/x/accounts/5498' }]
  }))
  const homes = desktopDataHomes(h)
  assert.deepStrictEqual(homes, [path.join(h, '.iris', 'accounts', 'default'), '/x/accounts/5498'])
  assert.ok(!JSON.stringify(homes).includes('SECRET'))
})

test('the released opencode.db wins over newer preview-build databases', () => {
  const h = home()
  const dir = path.join(h, '.iris', 'accounts', 'default', 'opencode')
  fs.writeFileSync(path.join(dir, 'opencode.db'), '')
  fs.writeFileSync(path.join(dir, 'opencode-preview-tonight.db'), '')
  assert.strictEqual(desktopDb(path.join(h, '.iris', 'accounts', 'default')), path.join(dir, 'opencode.db'))
  fs.unlinkSync(path.join(dir, 'opencode.db'))
  assert.strictEqual(desktopDb(path.join(h, '.iris', 'accounts', 'default')), path.join(dir, 'opencode-preview-tonight.db'))
})

test('lists Desktop sessions in the listing\'s shape, tagged as Desktop', () => {
  const h = home()
  fs.writeFileSync(path.join(h, '.iris', 'accounts', 'default', 'opencode', 'opencode.db'), '')
  const rows = listDesktopSessions({
    home: h,
    reader: fakeReader({ list: [
      { id: 'ses_new', title: 'Pricing', directory: '/Users/me/app', time_created: 1000, time_updated: 9000, messages: 4, model: 'iris/gpt-6-luna' },
      { id: 'ses_old', title: '', slug: 'old-slug', directory: null, time_created: 100, time_updated: 500, messages: 0, model: null }
    ] }),
    readGitBranch: (d) => (d ? 'main' : null)
  })
  assert.deepStrictEqual(rows.map((r) => r.session_id), ['ses_new', 'ses_old'])
  assert.deepStrictEqual(rows[0], {
    session_id: 'ses_new', name: 'Pricing', project_path: '/Users/me/app', git_branch: 'main', model: 'iris/gpt-6-luna',
    created_at: new Date(1000).toISOString(), updated_at: new Date(9000).toISOString(), message_count: 4,
    provider: 'opencode', summary: null, parent_id: null, source: 'iris_desktop'
  })
  assert.strictEqual(rows[1].name, 'old-slug')
})

test('never throws: no Desktop, no SQLite support, or a broken database all report nothing', () => {
  const h = home()
  assert.deepStrictEqual(listDesktopSessions({ home: h }), [])                    // no database file
  fs.writeFileSync(path.join(h, '.iris', 'accounts', 'default', 'opencode', 'opencode.db'), '')
  assert.deepStrictEqual(listDesktopSessions({ home: h, reader: () => null }), []) // no reader on this Node
  const boom = () => ({ all: () => { throw new Error('database is locked') }, close () {} })
  assert.deepStrictEqual(listDesktopSessions({ home: h, reader: boom }), [])
  assert.strictEqual(desktopSessionHistory('ses_x', { home: h, reader: boom }), null)
})

test('history: text and tool use, synthetic left out by the query, newest `limit` kept', () => {
  const h = home()
  fs.writeFileSync(path.join(h, '.iris', 'accounts', 'default', 'opencode', 'opencode.db'), '')
  const part = (o) => JSON.stringify(o)
  const out = desktopSessionHistory('ses_a', {
    home: h,
    reader: fakeReader({
      list: [{ id: 'ses_a', directory: '/Users/me/app', time_created: 1, time_updated: 2 }],
      parts: { ses_a: [
        { mid: 'm1', role: 'user', time: 10, part: part({ type: 'text', text: 'fix the build' }) },
        { mid: 'm2', role: 'assistant', time: 20, part: part({ type: 'tool', tool: 'bash', state: { input: { command: 'bun run build' } } }) },
        { mid: 'm2', role: 'assistant', time: 20, part: part({ type: 'tool', tool: 'edit', state: { input: { filePath: '/Users/me/app/a.ts' } } }) },
        { mid: 'm2', role: 'assistant', time: 20, part: part({ type: 'text', text: 'done' }) }
      ] }
    })
  })
  assert.strictEqual(out.source, 'iris_desktop')
  assert.deepStrictEqual(out.messages.map((m) => [m.role, m.type, m.text || m.tool]), [
    ['user', 'text', 'fix the build'], ['assistant', 'tool_use', 'bash'], ['assistant', 'tool_use', 'edit'], ['assistant', 'text', 'done']
  ])
  assert.deepStrictEqual(out.summary.files_edited, ['/Users/me/app/a.ts'])
  assert.deepStrictEqual(out.summary.commands_run, ['bun run build'])
  assert.strictEqual(desktopSessionHistory('ses_nope', { home: h, reader: fakeReader({ list: [], parts: {} }) }), null)
})

test('the sqlite3 fallback binds values as literals, quotes escaped', () => {
  assert.strictEqual(literal(5), '5')
  assert.strictEqual(literal("ses_x' OR '1'='1"), "'ses_x'' OR ''1''=''1'")
})

// The real thing, against a real SQLite file, when this runtime can open one.
test('end to end on a real database (node:sqlite or the sqlite3 CLI)', (t) => {
  const h = home()
  const db = path.join(h, '.iris', 'accounts', 'default', 'opencode', 'opencode.db')
  const sql = `
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, slug TEXT, directory TEXT, title TEXT,
      time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
    INSERT INTO session VALUES ('ses_live', NULL, 's', '/Users/me/app', 'Live work', 1, 5000, NULL);
    INSERT INTO session VALUES ('ses_gone', NULL, 'g', '/Users/me/app', 'Archived', 1, 9000, 9500);
    INSERT INTO message VALUES ('m1', 'ses_live', 10, '{"role":"user"}');
    INSERT INTO message VALUES ('m2', 'ses_live', 20, '{"role":"assistant","providerID":"iris","modelID":"gpt-6-luna"}');
    INSERT INTO part VALUES ('p1', 'm1', 'ses_live', '{"type":"text","text":"hello"}');
    INSERT INTO part VALUES ('p2', 'm2', 'ses_live', '{"type":"text","text":"reminder","synthetic":true}');
    INSERT INTO part VALUES ('p3', 'm2', 'ses_live', '{"type":"text","text":"hi"}');`
  try {
    const { DatabaseSync } = require('node:sqlite')
    const w = new DatabaseSync(db); w.exec(sql); w.close()
  } catch {
    try { execFileSync('sqlite3', [db, sql]) } catch { return t.skip('no node:sqlite and no sqlite3 CLI here') }
  }
  if (!openReader(db)) return t.skip('no SQLite reader on this runtime')

  const rows = listDesktopSessions({ home: h })
  assert.deepStrictEqual(rows.map((r) => [r.session_id, r.message_count, r.model]), [['ses_live', 2, 'iris/gpt-6-luna']])  // archived left out
  const hist = desktopSessionHistory('ses_live', { home: h })
  assert.deepStrictEqual(hist.messages.map((m) => m.text), ['hello', 'hi'])   // synthetic left out
  // read-only: a write through the reader is refused
  const r = openReader(db)
  assert.throws(() => r.all("INSERT INTO session (id) VALUES ('x')"))
  r.close()
})
