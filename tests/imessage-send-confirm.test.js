'use strict'
/**
 * The daemon must not call an iMessage "sent" because osascript returned (companion to CLI
 * #193288). chat.db — Messages' own is_sent / error columns — decides. A not-confirmed send
 * RETURNS (never throws), because a throw sends the route down a second send path.
 * Fixture DBs only; osascript is stubbed; nothing is sent.
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { classifyOutgoing, confirmOutgoing, sqliteRunner, httpResult } = require('../drivers/imessage-confirm')
const NativeIMessageDriver = require('../drivers/native-imessage')

const EPOCH = 978307200
const ns = (unix) => Math.floor((unix - EPOCH) * 1e9)
const now = Date.now() / 1000
const fast = { timeoutMs: 60, intervalMs: 10 }

function fixtureDb(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imsg-confirm-'))
  const db = path.join(dir, 'chat.db')
  const sql = [
    'CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT);',
    'CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);',
    'CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);',
    'CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);',
    'CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, is_from_me INTEGER, date INTEGER, handle_id INTEGER, is_sent INTEGER, is_delivered INTEGER, error INTEGER);',
  ]
  const handles = new Map()
  rows.forEach((r, i) => {
    if (!handles.has(r.handle)) {
      const id = handles.size + 1
      handles.set(r.handle, id)
      sql.push(`INSERT INTO handle VALUES (${id}, '${r.handle}');`)
      sql.push(`INSERT INTO chat VALUES (${id}, 'iMessage;-;${r.handle}', '${r.handle}');`)
      sql.push(`INSERT INTO chat_handle_join VALUES (${id}, ${id});`)
    }
    const h = handles.get(r.handle)
    sql.push(`INSERT INTO message VALUES (${i + 1}, ${r.text == null ? 'NULL' : `'${r.text}'`}, ${r.fromMe ?? 1}, ${ns(r.at)}, ${h}, ${r.sent ?? 0}, ${r.delivered ?? 0}, ${r.error ?? 0});`)
    sql.push(`INSERT INTO chat_message_join VALUES (${h}, ${i + 1});`)
  })
  execFileSync('/usr/bin/sqlite3', [db, sql.join('\n')])
  return db
}

test('classifyOutgoing: sent / failed / pending / none', () => {
  assert.deepStrictEqual(classifyOutgoing([{ rowid: 1, text: 'hi', is_sent: 1, is_delivered: 0, error: 0 }], 'hi'), { state: 'sent', rowid: 1, delivered: false })
  assert.deepStrictEqual(classifyOutgoing([{ rowid: 1, text: 'hi', is_sent: 0, is_delivered: 0, error: 22 }], 'hi'), { state: 'failed', rowid: 1, error: 22 })
  assert.deepStrictEqual(classifyOutgoing([{ rowid: 1, text: 'hi', is_sent: 0, is_delivered: 0, error: 0 }], 'hi'), { state: 'pending', rowid: 1 })
  assert.strictEqual(classifyOutgoing([{ rowid: 1, text: 'other', is_sent: 1, is_delivered: 0, error: 0 }], 'hi'), null)
})

test('real sqlite3 runner: confirmed by chat guid and by formatted phone', async () => {
  const db = fixtureDb([{ handle: '+15550100123', text: 'hi mom', at: now, sent: 1, delivered: 1 }])
  const runSql = sqliteRunner(db)
  assert.strictEqual((await confirmOutgoing({ runSql, chatGuid: 'iMessage;-;+15550100123', text: 'hi mom', sinceUnix: now - 1, ...fast })).state, 'sent')
  assert.strictEqual((await confirmOutgoing({ runSql, handle: '(555) 010-0123', text: 'hi mom', sinceUnix: now - 1, ...fast })).state, 'sent')
})

test('Not Delivered row → failed; no row → missing; other recipient / incoming do not count', async () => {
  const db = fixtureDb([
    { handle: '+15550100123', text: 'bad', at: now, error: 22 },
    { handle: '+15550100999', text: 'hi mom', at: now, sent: 1 },
    { handle: '+15550100123', text: 'hi mom', fromMe: 0, at: now },
  ])
  const runSql = sqliteRunner(db)
  assert.strictEqual((await confirmOutgoing({ runSql, handle: '+15550100123', text: 'bad', sinceUnix: now - 1, ...fast })).state, 'failed')
  assert.strictEqual((await confirmOutgoing({ runSql, handle: '+15550100123', text: 'hi mom', sinceUnix: now - 1, ...fast })).state, 'missing')
})

test('unreadable chat.db → unknown, never sent', async () => {
  const c = await confirmOutgoing({ runSql: sqliteRunner('/nonexistent/chat.db'), handle: '+15550100123', text: 'x', sinceUnix: now, ...fast })
  assert.strictEqual(c.state, 'unknown')
})

test('httpResult: only a confirmed send is 2xx (fl-api treats any 2xx as sent)', () => {
  assert.strictEqual(httpResult({ state: 'sent', delivered: true }, 'x').status, 200)
  for (const c of [{ state: 'failed', error: 22 }, { state: 'missing' }, { state: 'pending' }, { state: 'unknown', reason: 'r' }]) {
    const { status, body } = httpResult(c, 'x')
    assert.ok(status >= 500, `${c.state} → ${status}`)
    assert.strictEqual(body.ok, false)
    assert.ok(body.error)
  }
})

test('driver: confirm:true RETURNS ok:false for a send that never appeared (no throw → no double send)', async () => {
  const db = fixtureDb([{ handle: '+15550100123', text: 'older', at: now - 3600, sent: 1 }])
  const d = new NativeIMessageDriver({ chatDbPath: db, confirmTimeoutMs: 80 })
  d._runOsascript = async () => ''
  const r = await d.sendMessage('iMessage;-;+15550100123', 'never arrived', { confirm: true })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.confirmation.state, 'missing')

  const sent = fixtureDb([{ handle: '+15550100123', text: 'arrived', at: now + 1, sent: 1 }])
  const d2 = new NativeIMessageDriver({ chatDbPath: sent, confirmTimeoutMs: 80 })
  d2._runOsascript = async () => ''
  const ok = await d2.sendToHandle('+15550100123', 'arrived', { confirm: true })
  assert.strictEqual(ok.ok, true)
  assert.strictEqual(ok.confirmation.state, 'sent')
})

test('driver: without confirm the old contract is unchanged', async () => {
  const d = new NativeIMessageDriver({ chatDbPath: '/nonexistent' })
  d._runOsascript = async () => ''
  assert.deepStrictEqual(await d.sendMessage('iMessage;-;+1', 'x'), { ok: true })
})
