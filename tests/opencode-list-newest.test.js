'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

/**
 * #191011 — at load 15 on a Mac, GET /api/sessions/opencode read all 232 old-store session files
 * (plus a readdir of each one's messages) to return 25, taking 4.7–10.8 s: over the heartbeat's 5 s
 * refresh timeout, so the Mac stopped reporting its Desktop chats at all. It now picks the newest
 * `limit` files by mtime before reading any, and counts=0 means no message counting.
 */
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
const route = SRC.slice(SRC.indexOf("app.get('/api/sessions/opencode', async"), SRC.indexOf("app.get('/api/sessions/opencode', async") + 6000)

test('chooses the newest limit files by mtime before reading any', () => {
  assert.match(route, /candidates\.sort\(\(a, b\) => b\.mtime - a\.mtime\)/)
  assert.match(route, /for \(const \{ projPath, file \} of candidates\.slice\(0, limit\)\)/)
  // and no longer reads every file in a project dir
  assert.doesNotMatch(route, /const files = fs\.readdirSync\(projPath\)\.filter\(f => f\.endsWith\('\.json'\)\)\s*\n\s*for \(const file of files\)/)
})

test('counts=0 skips message counting and reports null, not zero', () => {
  assert.match(route, /const withCounts = req\.query\.counts !== '0'/)
  assert.match(route, /let messageCount = withCounts \? 0 : null/)
  assert.match(route, /if \(withCounts && fs\.existsSync\(msgDir\)\)/)
})

// #191011 — the daemon froze for up to 9.5 s at a time at load 15-27; two of the synchronous calls
// on its regular path (battery poll, GPU probe) now run in the background.
test('battery and GPU probes no longer block the event loop', () => {
  const RM = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'resource-monitor.js'), 'utf8')
  const HP = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'hardware-profile.js'), 'utf8')
  assert.doesNotMatch(RM, /execSync\(/)
  const gpu = HP.slice(HP.indexOf('function gpuCapability'), HP.indexOf('function detectOllama'))
  assert.doesNotMatch(gpu, /execSync\(/)
  assert.match(gpu, /return _gpuCapability === true/)
})

test('parseBattery reads pmset the same way the synchronous version did', () => {
  const { parseBattery } = require('../daemon/resource-monitor')
  assert.deepStrictEqual(parseBattery('darwin', "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t57%; discharging"), { onBattery: true, percent: 57 })
  assert.deepStrictEqual(parseBattery('darwin', "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged"), { onBattery: false, percent: 100 })
  assert.deepStrictEqual(parseBattery('win32', '{"BatteryStatus":1,"EstimatedChargeRemaining":40}'), { onBattery: true, percent: 40 })
  assert.deepStrictEqual(parseBattery('win32', 'garbage'), { onBattery: false, percent: null })
})
