'use strict'
// Runs the file-search engines on the REAL OS (#188665). The unit tests in disk-search.test.js
// cover every platform's commands from one machine; only a real Windows answers whether
// PowerShell accepts the scripts, whether the query really stays out of them, and what the
// Windows Search index does on a fresh box. Run by the Windows leg of daemon-smoke.yml.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { searchDisk, listProviders } = require('../daemon/disk-search')

const tag = `iris-locate-probe-${process.pid}-${Date.now()}`
const dir = path.join(os.homedir(), tag)
const file = path.join(dir, `${tag}.txt`)
test.before(() => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, 'probe') })
test.after(() => { fs.rmSync(dir, { recursive: true, force: true }) })

test('this platform lists its providers and picks one', () => {
  const p = listProviders()
  console.log(JSON.stringify(p))
  assert.ok(p.providers.length >= 2)
  assert.ok(p.chosen, 'some engine is usable')
})

test('the home-folder scan finds a file we just made', async () => {
  const r = await searchDisk(tag, { provider: 'scan', limit: 5 })
  console.log(JSON.stringify(r))
  assert.ok(r.rows.some((x) => path.resolve(x.match) === path.resolve(file)), 'scan found the probe file')
})

test('the default chain answers — the best engine, or a named fallback — and never throws', async () => {
  const r = await searchDisk(tag, { limit: 5 })
  console.log(JSON.stringify({ backend: r.backend, fellBackFrom: r.fellBackFrom, rows: r.rows.length, note: r.note }))
  assert.ok(r.backend, 'an engine answered')
  if (r.backend === 'scan') assert.ok(r.rows.length >= 1, 'the fallback scan found the file')
})

test('a hostile query stays a query: nothing runs, the file the query names survives', async () => {
  const victim = path.join(dir, 'victim.txt')
  fs.writeFileSync(victim, 'x')
  const evil = process.platform === 'win32'
    ? `x'; Remove-Item -Force '${victim}'; '`
    : `x'; rm -f '${victim}'; '`
  for (const provider of [null, 'scan']) {
    const r = await searchDisk(evil, { provider, limit: 3 })
    assert.ok(r && typeof r === 'object')
  }
  assert.ok(fs.existsSync(victim), 'the injected command did not run')
})
