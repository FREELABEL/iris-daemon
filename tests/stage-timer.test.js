'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { stageTimer, SLOW_MS } = require('../lib/stage-timer')

// #191306 — the MacBook's opencode session list took 33 s with no stage measured to explain it.

test('each mark closes the stage that ran since the previous one', () => {
  let t = 1000
  const timer = stageTimer(() => t)
  t += 12; timer.mark('scan_files')
  t += 140; timer.mark('desktop_sqlite')
  t += 32800; timer.mark('ask_servers')
  assert.deepStrictEqual(timer.stages, { scan_files: 12, desktop_sqlite: 140, ask_servers: 32800 })
  assert.strictEqual(timer.total(), 32952)
  assert.strictEqual(timer.summary(), 'total 32952ms — ask_servers 32800ms, desktop_sqlite 140ms, scan_files 12ms')
})

test('a stage marked twice adds up', () => {
  let t = 0
  const timer = stageTimer(() => t)
  t += 5; timer.mark('read')
  t += 7; timer.mark('read')
  assert.strictEqual(timer.stages.read, 12)
})

test('slow means slower than the heartbeat can wait for', () => {
  assert.ok(SLOW_MS <= 5000)
})

test('the opencode list route marks every stage and can return the timings', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
  const route = src.slice(src.indexOf("app.get('/api/sessions/opencode'"), src.indexOf('// ─── Discover All Sessions Across Providers'))
  for (const stage of ['scan_files', 'read_files', 'desktop_sqlite', 'find_servers', 'ask_servers', 'live_activity', 'pending_questions']) {
    assert.ok(route.includes(`timer.mark('${stage}')`), `missing stage ${stage}`)
  }
  assert.ok(route.includes("req.query.timings === '1'"))
  assert.ok(!/\bres\.json\(/.test(route.replace(/return res\.json\(req\.query\.timings/, '')), 'every answer must go through finish() so it is timed')
})
