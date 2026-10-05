'use strict'

// #187919 — "Kill a 50-record sample-data run at 25; re-running finishes 26-50 without
// repeating 1-25." These tests are that sentence, plus the two properties it rests on:
// idempotency per record (not per position) and a server summary that carries no identifiers.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const pc = require('../lib/portal-checkpoint')
const { phiSafeResult } = require('../lib/phi-task')

const LIB = path.join(__dirname, '..', 'lib', 'portal-checkpoint.js')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'portal-cp-'))
const sample = (n) => Array.from({ length: n }, (_, i) => ({ id: `MRN${1000 + i}`, name: `Patient ${i}` }))

test('a run KILLED mid-record at 25 resumes at record 25 and never repeats 0-24', () => {
  const dir = tmp()
  const records = sample(50)
  const task = { type: 'custom_playwright', config: { script_content: 'x'.repeat(20), records } }
  const prep = pc.preparePortalRun(task, path.join(dir, 'ws1'), { dir: path.join(dir, 'runs') })
  const log = path.join(dir, 'visited.log')
  // A real process, really killed (process.exit inside record 25's work) — not a polite throw.
  const robot = `
    const fs = require('fs')
    const { forEachRecord, loadRecords } = require(process.env.IRIS_PORTAL_LIB)
    forEachRecord(loadRecords(), async (r, i, ctx) => {
      if (i === 25 && process.env.KILL_AT_25) process.exit(137)
      fs.appendFileSync(${JSON.stringify(log)}, i + (ctx.resumed ? 'R' : '') + '\\n')
    }, { out: { write () {} } })`
  const env = { ...process.env, ...prep.env }
  const first = spawnSync(process.execPath, ['-e', robot], { env: { ...env, KILL_AT_25: '1' } })
  assert.strictEqual(first.status, 137)
  assert.deepStrictEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), Array.from({ length: 25 }, (_, i) => String(i)))

  // The retry is a NEW task (new workspace) with the same script + records → same run key.
  const prep2 = pc.preparePortalRun({ ...task, id: 'retry' }, path.join(dir, 'ws2'), { dir: path.join(dir, 'runs') })
  assert.strictEqual(prep2.file, prep.file)
  fs.writeFileSync(log, '')
  const second = spawnSync(process.execPath, ['-e', robot], { env: { ...process.env, ...prep2.env } })
  assert.strictEqual(second.status, 0, String(second.stderr))
  const visited = fs.readFileSync(log, 'utf8').trim().split('\n')
  assert.strictEqual(visited[0], '25R', 'resumes AT the killed record, flagged as resumed')
  assert.deepStrictEqual(visited.slice(1), Array.from({ length: 24 }, (_, i) => String(i + 26)))

  const s = pc.readSummary(prep.file)
  assert.strictEqual(s.done, 50)
  assert.strictEqual(s.resumed_from, 25)
  assert.strictEqual(s.skipped_done, 25)
  assert.strictEqual(s.next_index, null)
})

test('a failing record stops the run there; the retry starts at it', async () => {
  const dir = tmp()
  const file = path.join(dir, 'k', 'checkpoint.json')
  const records = sample(10)
  const seen = []
  await assert.rejects(
    pc.forEachRecord(records, async (r, i) => { seen.push(i); if (i === 4) throw new Error(`portal choked on ${r.name}`) }, { file, out: { write () {} } }),
    (e) => e.portalIndex === 4 && !/Patient/.test(e.message) // index, never the record
  )
  assert.deepStrictEqual(seen, [0, 1, 2, 3, 4])
  const again = []
  const s = await pc.forEachRecord(records, async (r, i) => { again.push(i) }, { file, out: { write () {} } })
  assert.deepStrictEqual(again, [4, 5, 6, 7, 8, 9])
  assert.strictEqual(s.done, 10)
  assert.strictEqual(s.resumed_from, 4)
})

test('idempotent per RECORD: a re-ordered list still skips what was done', async () => {
  const dir = tmp()
  const file = path.join(dir, 'k', 'checkpoint.json')
  const records = sample(6)
  await assert.rejects(pc.forEachRecord(records, async (r, i) => { if (i === 3) throw new Error('x') }, { file, out: { write () {} } }))
  const reversed = [...records].reverse()
  const ran = []
  await pc.forEachRecord(reversed, async (r) => { ran.push(r.id) }, { file, out: { write () {} } })
  assert.deepStrictEqual(ran.sort(), ['MRN1003', 'MRN1004', 'MRN1005'])
})

test('the checkpoint file and the summary hold no record identifiers', async () => {
  const dir = tmp()
  const file = path.join(dir, 'k', 'checkpoint.json')
  const lines = []
  await pc.forEachRecord(sample(3), async () => {}, { file, out: { write (l) { lines.push(l) } } })
  const raw = fs.readFileSync(file, 'utf8') + lines.join('')
  assert.doesNotMatch(raw, /MRN|Patient/)
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600)
  assert.ok(lines.every(l => l.startsWith(pc.PROGRESS_PREFIX)))
})

test('PHI result: portal_run survives as counts/indexes; anything else in it is dropped', () => {
  const safe = phiSafeResult({
    status: 'failed',
    output: 'Jane Doe MRN1234',
    data: { portal_run: { total: 50, done: 25, failed: 'MRN7777', failed_indexes: [25, 'MRN1234'], patient: 'Jane Doe', next_index: 25 } },
  }, { localRef: '/x/phi-result.json' })
  assert.deepStrictEqual(safe.data.portal_run.failed_indexes, [25])
  assert.strictEqual(safe.data.portal_run.done, 25)
  assert.strictEqual(safe.data.portal_run.next_index, 25)
  assert.strictEqual(safe.data.portal_run.failed, null, 'a non-integer count is nulled, not forwarded')
  assert.doesNotMatch(JSON.stringify(safe), /Jane|MRN/)
})

test('run key: stable across retries, different for a different record list, explicit key wins', () => {
  const a = { type: 'custom_playwright', config: { script_content: 's', records: [1, 2] } }
  assert.strictEqual(pc.runKeyFor({ ...a, id: 1 }), pc.runKeyFor({ ...a, id: 2 }))
  assert.notStrictEqual(pc.runKeyFor(a), pc.runKeyFor({ ...a, config: { ...a.config, records: [1, 3] } }))
  assert.strictEqual(pc.runKeyFor({ config: { run_key: 'pathways-oct' } }), 'pathways-oct')
  assert.match(pc.runKeyFor({ config: { run_key: '../../etc' } }), /^k-[0-9a-f]{32}$/)
  assert.strictEqual(pc.preparePortalRun({ type: 'shell', config: {} }, tmp()), null)
})

test('the robot can load the lib by the path the executor hands it', () => {
  assert.strictEqual(pc.preparePortalRun({ config: { portal_run: true } }, tmp(), { dir: tmp() }).env.IRIS_PORTAL_LIB, LIB)
})
