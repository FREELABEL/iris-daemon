const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const { ResourceMonitor } = require('../daemon/resource-monitor')

// Helper: create a monitor with controlled battery + CPU
function createMonitor (batteryOverride, cpuOverride) {
  const monitor = new ResourceMonitor({ intervalMs: 999999999 })

  // Override battery check to avoid calling pmset
  if (batteryOverride) {
    monitor._checkBattery = () => batteryOverride
  }

  // Override OS methods for CPU control if needed
  if (cpuOverride) {
    const origPoll = monitor._poll.bind(monitor)
    monitor._poll = function () {
      // Temporarily override os functions — restore after
      const origCpus = os.cpus
      const origLoadavg = os.loadavg
      const origFreemem = os.freemem
      const cores = cpuOverride.cores || 12

      os.cpus = () => Array(cores).fill({ model: 'test' })
      os.loadavg = () => [cpuOverride.loadAvg || 0, 0, 0]
      os.freemem = () => (cpuOverride.freeMemMB || 4096) * 1024 * 1024

      origPoll()

      os.cpus = origCpus
      os.loadavg = origLoadavg
      os.freemem = origFreemem
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
        { cores: 12, loadAvg: 1.2 } // ~10% CPU
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
        { cores: 10, loadAvg: 2.0 } // 20% CPU
      )
      monitor._poll()
      assert.equal(monitor.capacity.level, 'idle')
    })

    it('should report light when CPU 30-60%', () => {
      const monitor = createMonitor(
        { onBattery: false, percent: 100 },
        { cores: 10, loadAvg: 4.5 } // 45% CPU
      )
      monitor._poll()
      assert.equal(monitor.capacity.level, 'light')
    })

    it('should report busy when CPU 60-80%', () => {
      const monitor = createMonitor(
        { onBattery: false, percent: 100 },
        { cores: 10, loadAvg: 7.0 } // 70% CPU
      )
      monitor._poll()
      assert.equal(monitor.capacity.level, 'busy')
    })

    it('should report overloaded when CPU >= 80%', () => {
      const monitor = createMonitor(
        { onBattery: false, percent: 100 },
        { cores: 10, loadAvg: 9.0 } // 90% CPU
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
        { cores: 10, loadAvg: 9.0 }
      )
      monitor._poll()
      assert.equal(monitor.capacity.level, 'overloaded')
      assert.equal(monitor.canAcceptTasks(), false)
    })

    it('returns true for idle, light, and busy', () => {
      for (const [loadAvg, expected] of [[1.0, 'idle'], [4.0, 'light'], [7.0, 'busy']]) {
        const monitor = createMonitor(
          { onBattery: false, percent: 100 },
          { cores: 10, loadAvg }
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

      const origCpus = os.cpus
      const origLoadavg = os.loadavg
      const origFreemem = os.freemem
      os.cpus = () => Array(10).fill({ model: 'test' })
      os.loadavg = () => [5.5, 0, 0] // 55% — above 50% threshold
      os.freemem = () => 4096 * 1024 * 1024

      monitor._poll()

      os.cpus = origCpus
      os.loadavg = origLoadavg
      os.freemem = origFreemem

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

  // ─── Real CPU time, not load average (#191542) ────────────────
  //
  // macOS load average counts threads waiting on disk/IO, not just ones on a CPU, so a
  // 10-core Mac routinely sits at load 15-20 while its cores are mostly idle. Measured
  // 2026-10-28: Alexs-MacBook-Pro reported "CPU at 190%" and every pinned task was refused.

  describe('CPU from cpu time between polls', () => {
    // cumulative per-core times, as os.cpus() reports them
    const sample = (cores, busy, idle) =>
      Array(cores).fill(null).map(() => ({ model: 'test', times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }))

    function pollWith (monitor, { cpus, loadAvg }) {
      const origCpus = os.cpus
      const origLoadavg = os.loadavg
      os.cpus = () => cpus
      os.loadavg = () => [loadAvg, 0, 0]
      try { monitor._poll() } finally {
        os.cpus = origCpus
        os.loadavg = origLoadavg
      }
    }

    it('reports real CPU use when load average is inflated', () => {
      const monitor = createMonitor({ onBattery: false, percent: 100 })
      pollWith(monitor, { cpus: sample(10, 1000, 9000), loadAvg: 19 })
      // next 30s: 200 busy + 800 idle per core = 20% busy, while load average says 190%
      pollWith(monitor, { cpus: sample(10, 1200, 9800), loadAvg: 19 })
      assert.equal(monitor.capacity.cpu_pct, 20)
      assert.equal(monitor.capacity.level, 'idle')
      assert.equal(monitor.capacity.load_avg, 19)
    })

    it('still reports overloaded when the cores really are busy', () => {
      const monitor = createMonitor({ onBattery: false, percent: 100 })
      pollWith(monitor, { cpus: sample(10, 1000, 9000), loadAvg: 3 })
      pollWith(monitor, { cpus: sample(10, 1950, 9050), loadAvg: 3 })
      assert.equal(monitor.capacity.cpu_pct, 95)
      assert.equal(monitor.capacity.level, 'overloaded')
    })

    it('never reports more than 100% before it has two samples', () => {
      const monitor = createMonitor({ onBattery: false, percent: 100 })
      pollWith(monitor, { cpus: sample(10, 1000, 9000), loadAvg: 19 })
      assert.ok(monitor.capacity.cpu_pct <= 100, `cpu_pct was ${monitor.capacity.cpu_pct}`)
    })
  })
})
