const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')

const { ScheduleRegistry } = require('../daemon/schedule-registry')

// ─── Helpers ──────────────────────────────────────────────────────

function makeTempDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sched-test-'))
}

function rmTempDir (dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

const _registries = []
function makeRegistry (overrides = {}) {
  const dataDir = makeTempDir()
  fs.mkdirSync(path.join(dataDir, 'scripts'), { recursive: true })
  const cloud = overrides.cloud || {
    submitScheduleResult: async () => ({ ok: true })
  }
  const config = { dataDir }
  const reg = new ScheduleRegistry(config, cloud)
  _registries.push(reg)
  return { reg, dataDir, cloud }
}

function writeScript (dataDir, filename, content = '#!/bin/bash\necho hi') {
  const scriptPath = path.join(dataDir, 'scripts', filename)
  fs.writeFileSync(scriptPath, content)
  fs.chmodSync(scriptPath, 0o755)
  return scriptPath
}

// ─── Tests ────────────────────────────────────────────────────────

describe('ScheduleRegistry', () => {
  let dirs = []

  afterEach(() => {
    // CRITICAL: stop registries first so leaked cron jobs don't fire after dir cleanup
    while (_registries.length) {
      try { _registries.pop().stop() } catch { /* ignore */ }
    }
    dirs.forEach(rmTempDir)
    dirs = []
  })

  describe('persistence', () => {
    it('starts empty when no schedules.json exists', () => {
      const { reg, dataDir } = makeRegistry()
      dirs.push(dataDir)
      assert.equal(reg.list().length, 0)
    })

    it('loads existing schedules from schedules.json on construction', () => {
      const { dataDir } = makeRegistry()
      dirs.push(dataDir)
      const seed = [
        { id: 'sched_1', filename: 'a.sh', cron: '0 0 1 1 *', enabled: true, run_count: 5 }
      ]
      fs.writeFileSync(path.join(dataDir, 'schedules.json'), JSON.stringify(seed))
      const reg2 = new ScheduleRegistry({ dataDir }, {})
      assert.equal(reg2.list().length, 1)
      assert.equal(reg2.list()[0].run_count, 5)
    })

    it('survives corrupted schedules.json gracefully', () => {
      const { dataDir } = makeRegistry()
      dirs.push(dataDir)
      fs.writeFileSync(path.join(dataDir, 'schedules.json'), '{not valid json')
      // Should NOT throw
      const reg2 = new ScheduleRegistry({ dataDir }, {})
      assert.equal(reg2.list().length, 0)
    })
  })

  describe('add()', () => {
    it('rejects invalid cron expressions', () => {
      const { reg, dataDir } = makeRegistry()
      dirs.push(dataDir)
      writeScript(dataDir, 'test.sh')
      assert.throws(() => reg.add('test.sh', 'not a cron'), /Invalid cron/)
    })

    it('rejects when script file does not exist', () => {
      const { reg, dataDir } = makeRegistry()
      dirs.push(dataDir)
      assert.throws(() => reg.add('missing.sh', '0 0 1 1 *'), /Script not found/)
    })

    it('creates schedule with sensible defaults', () => {
      const { reg, dataDir } = makeRegistry()
      dirs.push(dataDir)
      writeScript(dataDir, 'test.sh')
      const s = reg.add('test.sh', '*/5 * * * *')
      assert.match(s.id, /^sched_/)
      assert.equal(s.filename, 'test.sh')
      assert.equal(s.cron, '*/5 * * * *')
      assert.equal(s.enabled, true)
      assert.equal(s.run_count, 0)
      assert.equal(s.last_status, null)
      assert.deepEqual(s.args, [])
    })

    it('persists to disk immediately after add', () => {
      const { reg, dataDir } = makeRegistry()
      dirs.push(dataDir)
      writeScript(dataDir, 'test.sh')
      reg.add('test.sh', '0 0 1 1 *')
      const fileContent = JSON.parse(fs.readFileSync(path.join(dataDir, 'schedules.json'), 'utf-8'))
      assert.equal(fileContent.length, 1)
    })

    it('generates unique IDs even when added in tight loop', () => {
      const { reg, dataDir } = makeRegistry()
      dirs.push(dataDir)
      writeScript(dataDir, 'test.sh')
      const ids = new Set()
      for (let i = 0; i < 50; i++) {
        ids.add(reg.add('test.sh', '0 0 1 1 *').id)
      }
      assert.equal(ids.size, 50, 'all IDs should be unique')
    })
  })

  describe('remove()', () => {
    it('throws when removing nonexistent schedule', () => {
      const { reg, dataDir } = makeRegistry()
      dirs.push(dataDir)
      assert.throws(() => reg.remove('does_not_exist'), /not found/)
    })

    it('stops the cron job and deletes from map', () => {
      const { reg, dataDir } = makeRegistry()
      dirs.push(dataDir)
      writeScript(dataDir, 'test.sh')
      const s = reg.add('test.sh', '0 0 1 1 *')
      assert.equal(reg.cronJobs.has(s.id), true)
      reg.remove(s.id)
      assert.equal(reg.cronJobs.has(s.id), false)
      assert.equal(reg.schedules.has(s.id), false)
    })
  })

  describe('pause / resume', () => {
    it('pause() stops the cron job and marks disabled', () => {
      const { reg, dataDir } = makeRegistry()
      dirs.push(dataDir)
      writeScript(dataDir, 'test.sh')
      const s = reg.add('test.sh', '0 0 1 1 *')
      reg.pause(s.id)
      assert.equal(reg.schedules.get(s.id).enabled, false)
      assert.equal(reg.cronJobs.has(s.id), false)
    })

    it('pause() then resume() restores cron job', () => {
      const { reg, dataDir } = makeRegistry()
      dirs.push(dataDir)
      writeScript(dataDir, 'test.sh')
      const s = reg.add('test.sh', '0 0 1 1 *')
      reg.pause(s.id)
      reg.resume(s.id)
      assert.equal(reg.schedules.get(s.id).enabled, true)
    })

    it('pause throws on missing schedule', () => {
      const { reg, dataDir } = makeRegistry()
      dirs.push(dataDir)
      assert.throws(() => reg.pause('nope'), /not found/)
    })
  })

  describe('_fire() — running state tracking (the new behavior)', () => {
    it('marks schedule as running=true when fired, clears on close', async () => {
      const { reg, dataDir } = makeRegistry()
      dirs.push(dataDir)
      writeScript(dataDir, 'quick.sh', '#!/bin/bash\nexit 0')
      const s = reg.add('quick.sh', '0 0 1 1 *')

      const firePromise = reg._fire(s.id)
      // Synchronously after _fire starts, the schedule should be marked running
      assert.equal(reg.schedules.get(s.id).running, true, 'should be running synchronously')
      assert.ok(reg.schedules.get(s.id).started_at, 'started_at should be set')

      await firePromise
      assert.equal(reg.schedules.get(s.id).running, false, 'should NOT be running after close')
      assert.equal(reg.schedules.get(s.id).started_at, null, 'started_at should be cleared')
      assert.equal(reg.schedules.get(s.id).last_status, 'completed')
      assert.equal(reg.schedules.get(s.id).run_count, 1)
      assert.ok(reg.schedules.get(s.id).last_duration_ms >= 0)
    })

    it('clears running state on script failure (non-zero exit)', async () => {
      const { reg, dataDir } = makeRegistry()
      dirs.push(dataDir)
      writeScript(dataDir, 'fail.sh', '#!/bin/bash\nexit 1')
      const s = reg.add('fail.sh', '0 0 1 1 *')
      await reg._fire(s.id)
      assert.equal(reg.schedules.get(s.id).running, false)
      assert.equal(reg.schedules.get(s.id).last_status, 'failed')
    })

    it('marks last_status="file_missing" without crashing if script disappears', async () => {
      const { reg, dataDir } = makeRegistry()
      dirs.push(dataDir)
      writeScript(dataDir, 'soon-deleted.sh', '#!/bin/bash\nexit 0')
      const s = reg.add('soon-deleted.sh', '0 0 1 1 *')
      // Delete the script after add, before fire
      fs.unlinkSync(path.join(dataDir, 'scripts', 'soon-deleted.sh'))
      await reg._fire(s.id)
      assert.equal(reg.schedules.get(s.id).last_status, 'file_missing')
      // EDGE CASE: running flag may not be cleared because we return early
      // before setting running=true. Verify it's not stuck in running state.
      assert.notEqual(reg.schedules.get(s.id).running, true, 'should not be stuck running')
    })

    it('_fire() on missing schedule id is a no-op (does not throw)', async () => {
      const { reg, dataDir } = makeRegistry()
      dirs.push(dataDir)
      // Should not throw
      await reg._fire('nonexistent_id')
    })

    it('increments run_count on each successful fire', async () => {
      const { reg, dataDir } = makeRegistry()
      dirs.push(dataDir)
      writeScript(dataDir, 'counter.sh', '#!/bin/bash\nexit 0')
      const s = reg.add('counter.sh', '0 0 1 1 *')
      await reg._fire(s.id)
      await reg._fire(s.id)
      await reg._fire(s.id)
      assert.equal(reg.schedules.get(s.id).run_count, 3)
    })

    it('persists running=false to disk after each fire', async () => {
      const { reg, dataDir } = makeRegistry()
      dirs.push(dataDir)
      writeScript(dataDir, 'persist.sh', '#!/bin/bash\nexit 0')
      const s = reg.add('persist.sh', '0 0 1 1 *')
      await reg._fire(s.id)
      const fileContent = JSON.parse(fs.readFileSync(path.join(dataDir, 'schedules.json'), 'utf-8'))
      const persisted = fileContent.find(x => x.id === s.id)
      assert.equal(persisted.running, false)
      assert.equal(persisted.last_status, 'completed')
      assert.equal(persisted.run_count, 1)
    })
  })

  describe('cloud reporting + offline fallback', () => {
    it('falls back to pending file when cloud submission throws', async () => {
      const { reg, dataDir } = makeRegistry({
        cloud: {
          submitScheduleResult: async () => { throw new Error('network down') }
        }
      })
      dirs.push(dataDir)
      writeScript(dataDir, 'test.sh', '#!/bin/bash\nexit 0')
      const s = reg.add('test.sh', '0 0 1 1 *')
      await reg._fire(s.id)

      const pendingFile = path.join(dataDir, 'pending-results.json')
      assert.equal(fs.existsSync(pendingFile), true, 'pending-results.json should exist')
      const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf-8'))
      assert.equal(pending.length, 1)
      assert.equal(pending[0].schedule_id, s.id)
    })

    it('flushPending() drains the pending file when cloud recovers', async () => {
      let attempts = 0
      const { reg, dataDir } = makeRegistry({
        cloud: {
          submitScheduleResult: async () => {
            attempts++
            if (attempts === 1) throw new Error('network down')
            return { ok: true }
          }
        }
      })
      dirs.push(dataDir)
      writeScript(dataDir, 'test.sh', '#!/bin/bash\nexit 0')
      const s = reg.add('test.sh', '0 0 1 1 *')
      await reg._fire(s.id)

      // First attempt failed → pending file should exist
      assert.equal(fs.existsSync(path.join(dataDir, 'pending-results.json')), true)

      // Now flush — second submission succeeds
      await reg.flushPending()
      assert.equal(fs.existsSync(path.join(dataDir, 'pending-results.json')), false, 'pending file should be deleted')
    })

    it('caps pending file at 1000 entries (memory protection)', async () => {
      const { reg, dataDir } = makeRegistry({
        cloud: {
          submitScheduleResult: async () => { throw new Error('offline') }
        }
      })
      dirs.push(dataDir)
      // Pre-seed pending file with 1005 entries
      const big = Array.from({ length: 1005 }, (_, i) => ({ schedule_id: `s_${i}` }))
      fs.writeFileSync(path.join(dataDir, 'pending-results.json'), JSON.stringify(big))
      // Append one more
      reg._appendPending({ schedule_id: 'newest' })
      const after = JSON.parse(fs.readFileSync(path.join(dataDir, 'pending-results.json'), 'utf-8'))
      assert.equal(after.length, 1000, 'should cap at 1000')
      assert.equal(after[after.length - 1].schedule_id, 'newest', 'newest should survive')
    })
  })

  describe('list() — what the heartbeat sees', () => {
    it('returns all schedules with running flags reflecting current state', async () => {
      const { reg, dataDir } = makeRegistry()
      dirs.push(dataDir)
      writeScript(dataDir, 'a.sh', '#!/bin/bash\nexit 0')
      writeScript(dataDir, 'b.sh', '#!/bin/bash\nexit 0')
      reg.add('a.sh', '0 0 1 1 *')
      const sb = reg.add('b.sh', '0 0 1 1 *')

      // Manually mark sb as running (simulates mid-execution heartbeat)
      reg.schedules.get(sb.id).running = true

      const list = reg.list()
      assert.equal(list.length, 2)
      const running = list.filter(s => s.running === true)
      assert.equal(running.length, 1)
      assert.equal(running[0].filename, 'b.sh')
    })
  })
})
