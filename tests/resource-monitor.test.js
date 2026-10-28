const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const { ResourceMonitor, cpuPercent, cpuTimeTotals } = require('../daemon/resource-monitor')

// A fake os.cpus() snapshot: `cores` cores, each with `busyMs` busy and `idleMs` idle time.
function fakeCpus (cores, busyMs, idleMs) {
  return Array.from({ length: cores }, () => ({
    model: 'test', speed: 1000,
    times: { user: busyMs * 0.7, nice: 0, sys: busyMs * 0.3, idle: idleMs, irq: 0 }
  }))
}

// Run fn with os.cpus/loadavg/freemem replaced; always restores.
function withFakeOs ({ cpus, loadAvg = 0, freeMemMB = 4096 }, fn) {
  const orig = { cpus: os.cpus, loadavg: os.loadavg, freemem: os.freemem }
  os.cpus = () => cpus
  os.loadavg = () => [loadAvg, 0, 0]
  os.freemem = () => freeMemMB * 1024 * 1024
  try { return fn() } finally { Object.assign(os, orig) }
}

// Helper: create a monitor with controlled battery + CPU
function createMonitor (batteryOverride, cpuOverride) {
  const monitor = new ResourceMonitor({ intervalMs: 999999999 })

  // Override battery check to avoid calling pmset
  if (batteryOverride) {
    monitor._checkBattery = () => batteryOverride
  }

  // Override OS methods for CPU control if needed
  if (cpuOverride) {
    // cpuOverride: { cores, busyPct, loadAvg }. The first poll uses the since-boot times,
    // so a snapshot that is busyPct busy makes that poll report busyPct.
    const origPoll = monitor._poll.bind(monitor)
    monitor._poll = function () {
      const cores = cpuOverride.cores || 12
      const busy = cpuOverride.busyPct || 0
      withFakeOs({
        cpus: fakeCpus(cores, busy * 1000, (100 - busy) * 1000),
        loadAvg: cpuOverride.loadAvg || 0,
        freeMemMB: cpuOverride.freeMemMB
      }, origPoll)
    }
  }

  return monitor
}

describe('ResourceMonitor', () => {
  // ─── Battery behavior (the actual bug domain) ────────────────

  describe('battery behavior', () => {
    it('should NOT hibernate at 93% battery unplugged (the real bug)', () => {
      const monitor = createMonitor({ onBattery: true, percent: 93 })
      monitor._poll()
      assert.notEqual(monitor.capacity.level, 'hibernating',
        'Battery at 93% should NOT hibernate — only < 20% should')
      assert.equal(monitor.capacity.on_battery, true)
      assert.equal(monitor.capacity.battery_pct, 93)
    })

    it('should hibernate at 9% battery unplugged', () => {
      const monitor = createMonitor({ onBattery: true, percent: 9 })
      monitor._poll()
      assert.equal(monitor.capacity.level, 'hibernating')
    })

    it('should NOT hibernate at exactly 10% (boundary)', () => {
      const monitor = createMonitor({ onBattery: true, percent: 10 })
      monitor._poll()
      assert.notEqual(monitor.capacity.level, 'hibernating',
        'Threshold is < 10, so 10% exactly should NOT hibernate')
    })

    it('should hibernate at 1% battery unplugged', () => {
      const monitor = createMonitor({ onBattery: true, percent: 1 })
      monitor._poll()
      assert.equal(monitor.capacity.level, 'hibernating')
    })

    it('should NOT hibernate at 5% plugged in (AC)', () => {
      const monitor = createMonitor({ onBattery: false, percent: 5 })
      monitor._poll()
      assert.notEqual(monitor.capacity.level, 'hibernating',
        'On AC power, battery percentage is irrelevant')
    })

    it('should NOT hibernate when battery percent is null and unplugged', () => {
      // Edge case: pmset returns onBattery=true but no percent parsed
      const monitor = createMonitor({ onBattery: true, percent: null })
      monitor._poll()
      assert.notEqual(monitor.capacity.level, 'hibernating',
        'null percent with onBattery should NOT hibernate (cannot confirm < 20%)')
    })

    it('should use CPU-based levels when on battery above 10%', () => {
      // 50% battery, low CPU = should be idle, not hibernating
      const monitor = createMonitor(
        { onBattery: true, percent: 50 },
        { cores: 12, busyPct: 10, loadAvg: 58 } // 10% CPU, load 483%
      )
      monitor._poll()
      assert.equal(monitor.capacity.level, 'idle')
    })
  })

  // ─── CPU-based capacity levels ────────────────────────────────

  describe('CPU capacity levels', () => {
    it('should report idle when CPU < 30%', () => {
      const monitor = createMonitor(
        { onBattery: false, percent: 100 },
        { cores: 10, busyPct: 20, loadAvg: 48.6 } // 20% CPU, load 486%
      )
      monitor._poll()
      assert.equal(monitor.capacity.level, 'idle')
    })

    it('should report light when CPU 30-60%', () => {
      const monitor = createMonitor(
        { onBattery: false, percent: 100 },
        { cores: 10, busyPct: 45 } // 45% CPU
      )
      monitor._poll()
      assert.equal(monitor.capacity.level, 'light')
    })

    it('should report busy when CPU 60-80%', () => {
      const monitor = createMonitor(
        { onBattery: false, percent: 100 },
        { cores: 10, busyPct: 70 } // 70% CPU
      )
      monitor._poll()
      assert.equal(monitor.capacity.level, 'busy')
    })

    it('should report overloaded when CPU >= 80%', () => {
      const monitor = createMonitor(
        { onBattery: false, percent: 100 },
        { cores: 10, busyPct: 90, loadAvg: 0.5 } // 90% CPU, load low
      )
      monitor._poll()
      assert.equal(monitor.capacity.level, 'overloaded')
    })
  })

  // ─── Event emission ───────────────────────────────────────────

  describe('capacity-changed event', () => {
    it('should emit capacity-changed when level transitions', () => {
      const monitor = createMonitor({ onBattery: false, percent: 100 })
      let emitted = null

      // First poll — sets lastLevel, no emission
      monitor._poll()
      assert.equal(monitor.lastLevel, monitor.capacity.level)

      // Listen for event
      monitor.on('capacity-changed', (data) => { emitted = data })

      // Force a different level by changing battery mock
      monitor._checkBattery = () => ({ onBattery: true, percent: 5 })
      monitor._poll()

      assert.ok(emitted, 'capacity-changed should have been emitted')
      assert.equal(emitted.level, 'hibernating')
      assert.ok(emitted.previous, 'should include previous level')
      assert.ok(emitted.capacity, 'should include capacity snapshot')
    })

    it('should NOT emit capacity-changed on first poll', () => {
      const monitor = createMonitor({ onBattery: false, percent: 100 })
      let emitted = false
      monitor.on('capacity-changed', () => { emitted = true })
      monitor._poll()
      assert.equal(emitted, false, 'First poll should not emit — prev is null')
    })

    it('should emit on battery-to-AC transition', () => {
      const monitor = createMonitor({ onBattery: true, percent: 5 })
      let emitted = null

      // First poll: hibernating
      monitor._poll()
      assert.equal(monitor.capacity.level, 'hibernating')

      monitor.on('capacity-changed', (data) => { emitted = data })

      // Plug in AC
      monitor._checkBattery = () => ({ onBattery: false, percent: 5 })
      monitor._poll()

      assert.ok(emitted)
      assert.equal(emitted.previous, 'hibernating')
      assert.notEqual(emitted.level, 'hibernating')
    })
  })

  // ─── canAcceptTasks() ─────────────────────────────────────────

  describe('canAcceptTasks()', () => {
    it('returns false when hibernating', () => {
      const monitor = createMonitor({ onBattery: true, percent: 5 })
      monitor._poll()
      assert.equal(monitor.capacity.level, 'hibernating')
      assert.equal(monitor.canAcceptTasks(), false)
    })

    it('returns false when overloaded', () => {
      const monitor = createMonitor(
        { onBattery: false, percent: 100 },
        { cores: 10, busyPct: 90 }
      )
      monitor._poll()
      assert.equal(monitor.capacity.level, 'overloaded')
      assert.equal(monitor.canAcceptTasks(), false)
    })

    it('returns true for idle, light, and busy', () => {
      for (const [busyPct, expected] of [[10, 'idle'], [40, 'light'], [70, 'busy']]) {
        const monitor = createMonitor(
          { onBattery: false, percent: 100 },
          { cores: 10, busyPct, loadAvg: 48.6 }
        )
        monitor._poll()
        assert.equal(monitor.capacity.level, expected)
        assert.equal(monitor.canAcceptTasks(), true, `${expected} should accept tasks`)
      }
    })
  })

  // ─── maxCpuThreshold option ───────────────────────────────────

  describe('maxCpuThreshold', () => {
    it('overrides to overloaded when CPU exceeds custom threshold', () => {
      const monitor = new ResourceMonitor({ intervalMs: 999999999, maxCpuThreshold: 50 })
      monitor._checkBattery = () => ({ onBattery: false, percent: 100 })

      withFakeOs({ cpus: fakeCpus(10, 55000, 45000), loadAvg: 0.1 }, () => monitor._poll()) // 55% CPU

      assert.equal(monitor.capacity.level, 'overloaded',
        'CPU at 55% should be overloaded when maxCpuThreshold=50')
    })

    it('does not override hibernating even when CPU exceeds threshold', () => {
      const monitor = new ResourceMonitor({ intervalMs: 999999999, maxCpuThreshold: 50 })
      monitor._checkBattery = () => ({ onBattery: true, percent: 5 })
      monitor._poll()
      assert.equal(monitor.capacity.level, 'hibernating',
        'Hibernating should win over maxCpuThreshold override')
    })
  })

  // ─── Real CPU, not load average (#191603) ─────────────────────

  describe('cpu_pct is CPU time, not load average (#191603)', () => {
    it('reports the CPU busy share between two polls, ignoring a huge load average', () => {
      const monitor = createMonitor({ onBattery: false, percent: 100 })
      // Boot to poll 1: 50% busy. Poll 1 to poll 2: 10 cores x (1000 busy + 9000 idle) = 10%.
      withFakeOs({ cpus: fakeCpus(10, 50000, 50000), loadAvg: 48.6 }, () => monitor._poll())
      withFakeOs({ cpus: fakeCpus(10, 51000, 59000), loadAvg: 48.6 }, () => monitor._poll())
      assert.equal(monitor.capacity.cpu_pct, 10)
      assert.equal(monitor.capacity.cpu_sample, 'interval')
      assert.equal(monitor.capacity.load_avg, 48.6, 'load_avg is still reported as its own field')
      assert.equal(monitor.capacity.level, 'idle', 'a full-disk Mac with idle cores is not overloaded')
      assert.equal(monitor.canAcceptTasks(), true)
    })

    it('reports a busy CPU as busy even when load is low', () => {
      const monitor = createMonitor({ onBattery: false, percent: 100 })
      withFakeOs({ cpus: fakeCpus(8, 0, 100000), loadAvg: 0.2 }, () => monitor._poll())
      withFakeOs({ cpus: fakeCpus(8, 9500, 100500), loadAvg: 0.2 }, () => monitor._poll())
      assert.equal(monitor.capacity.cpu_pct, 95)
      assert.equal(monitor.capacity.level, 'overloaded')
    })

    it('first poll uses the since-boot average, never a load-based guess', () => {
      const monitor = createMonitor({ onBattery: false, percent: 100 })
      withFakeOs({ cpus: fakeCpus(4, 25000, 75000), loadAvg: 19.4 }, () => monitor._poll())
      assert.equal(monitor.capacity.cpu_pct, 25)
      assert.equal(monitor.capacity.cpu_sample, 'since_boot')
    })

    it('never reports above 100 or below 0', () => {
      const cases = [
        [{ total: 0, idle: 0 }, { total: 1000, idle: -500 }],
        [{ total: 0, idle: 0 }, { total: 1000, idle: 2000 }],
        [{ total: 5000, idle: 4000 }, { total: 5000, idle: 4000 }],
        [{ total: 9000, idle: 8000 }, { total: 1000, idle: 500 }],
        [null, { total: 0, idle: 0 }]
      ]
      for (const [prev, cur] of cases) {
        const { pct } = cpuPercent(prev, cur)
        assert.ok(pct >= 0 && pct <= 100, `cpuPercent(${JSON.stringify(prev)}, ${JSON.stringify(cur)}) = ${pct}`)
      }
      // Fully pegged with huge load on one core still caps at 100.
      const monitor = createMonitor({ onBattery: false, percent: 100 })
      withFakeOs({ cpus: fakeCpus(1, 1000, 0), loadAvg: 40 }, () => monitor._poll())
      assert.equal(monitor.capacity.cpu_pct, 100)
    })

    it('cpuTimeTotals sums every core', () => {
      assert.deepEqual(cpuTimeTotals(fakeCpus(2, 300, 700)), { total: 2000, idle: 1400 })
    })
  })
})
