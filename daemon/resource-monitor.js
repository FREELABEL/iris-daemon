/**
 * ResourceMonitor — Battery-aware "Mycelium" throttling for sovereign nodes.
 *
 * Inspired by organic fungal networks: a tree doesn't share nutrients when
 * it's dying. A MacBook doesn't process AI tasks when it's on battery.
 *
 * Polls CPU load, free memory, and power state every 30s.
 * Reports capacity level to the hub so it can route tasks intelligently:
 *   - hibernating: on battery below 10% → rejects all new tasks
 *   - idle: load < 30% → accepts heavy tasks
 *   - light: load < 60% → accepts normal tasks
 *   - busy: load < 80% → accepts lightweight tasks only
 *   - overloaded: load >= 80% → rejects new tasks
 *
 * Emits 'capacity-changed' when level transitions (e.g., plugged in → unplugged).
 */

const os = require('os')
const { exec } = require('child_process')
const EventEmitter = require('events')

// ── Capacity thresholds (CPU % and battery %) ────────────────────────
const BATTERY_HIBERNATE_PCT = 10   // Hibernate when unplugged below this %
const CPU_OVERLOADED_PCT = 80
const CPU_BUSY_PCT = 60
const CPU_LIGHT_PCT = 30

class ResourceMonitor extends EventEmitter {
  constructor (options = {}) {
    super()
    this.intervalMs = options.intervalMs || 30000
    this.maxCpuThreshold = options.maxCpuThreshold || null // null = disabled
    this.timer = null
    this.lastLevel = null

    // Current state
    this.capacity = {
      level: 'idle',
      cpu_pct: 0,
      free_mem_mb: 0,
      total_mem_mb: 0,
      load_avg: 0,
      cpu_cores: os.cpus().length,
      on_battery: false,
      battery_pct: null
    }
  }

  start () {
    // Take an initial reading immediately
    this._poll()

    // Then poll on interval
    this.timer = setInterval(() => this._poll(), this.intervalMs)
    console.log(`[resource] Monitor started — polling every ${this.intervalMs / 1000}s`)
  }

  stop () {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    console.log('[resource] Monitor stopped')
  }

  /**
   * Get current capacity snapshot.
   */
  getCapacity () {
    return { ...this.capacity }
  }

  /**
   * Check if the node should accept new tasks based on current capacity.
   */
  canAcceptTasks () {
    return this.capacity.level !== 'hibernating' && this.capacity.level !== 'overloaded'
  }

  // ─── Internal polling ────────────────────────────────────────

  _poll () {
    const cores = os.cpus().length
    const loadAvg1m = os.loadavg()[0]
    const cpuPct = Math.round((loadAvg1m / cores) * 100)
    const freeMemMB = Math.round(os.freemem() / (1024 ** 2))
    const totalMemMB = Math.round(os.totalmem() / (1024 ** 2))

    // Battery check (macOS)
    const battery = this._checkBattery()

    // Determine capacity level
    let level
    if (battery.onBattery && battery.percent !== null && battery.percent < BATTERY_HIBERNATE_PCT) {
      level = 'hibernating'
    } else if (cpuPct >= CPU_OVERLOADED_PCT) {
      level = 'overloaded'
    } else if (cpuPct >= CPU_BUSY_PCT) {
      level = 'busy'
    } else if (cpuPct >= CPU_LIGHT_PCT) {
      level = 'light'
    } else {
      level = 'idle'
    }

    // Check optional max CPU threshold
    if (this.maxCpuThreshold && cpuPct >= this.maxCpuThreshold && level !== 'hibernating') {
      level = 'overloaded'
    }

    // Update state
    this.capacity = {
      level,
      cpu_pct: cpuPct,
      free_mem_mb: freeMemMB,
      total_mem_mb: totalMemMB,
      load_avg: Math.round(loadAvg1m * 100) / 100,
      cpu_cores: cores,
      on_battery: battery.onBattery,
      battery_pct: battery.percent
    }

    // Emit event if level changed
    if (level !== this.lastLevel) {
      const prev = this.lastLevel
      this.lastLevel = level

      if (prev !== null) {
        console.log(`[resource] Capacity changed: ${prev} → ${level}${battery.onBattery ? ' (battery)' : ''}`)
        this.emit('capacity-changed', { level, previous: prev, capacity: this.capacity })
      }
    }
  }

  /**
   * Battery state, { onBattery, percent } — the LAST reading, refreshed in the background (#191011).
   *
   * This ran `pmset -g batt` (or PowerShell on Windows) with execSync on every poll, so the whole
   * daemon — heartbeat, bridge, session lookups — waited on it. pmset takes 20 ms on an idle Mac;
   * at load 15-27 (measured 2026-10-23) every synchronous child waits seconds for CPU, and the
   * daemon froze for up to 9.5 s at a time, often enough that the Mac stopped reporting its chats.
   * A battery reading one poll old is fine; a frozen daemon is not.
   */
  _checkBattery () {
    const cmd = batteryCommand(os.platform())
    if (cmd && !this._batteryInFlight) {
      this._batteryInFlight = true
      exec(cmd, { encoding: 'utf-8', timeout: 5000 }, (err, out) => {
        this._batteryInFlight = false
        if (!err) this._battery = parseBattery(os.platform(), out)
      })
    }
    return this._battery || { onBattery: false, percent: null }
  }
}

function batteryCommand (platform) {
  if (platform === 'darwin') return 'pmset -g batt 2>/dev/null'
  if (platform === 'win32') return 'powershell -Command "(Get-CimInstance Win32_Battery | Select-Object -First 1 | ConvertTo-Json)" 2>nul'
  return null
}

function parseBattery (platform, output) {
  try {
    if (platform === 'darwin') {
      const onBattery = /Battery Power/i.test(output) && !/AC Power/i.test(String(output).split('\n')[0])
      const pctMatch = String(output).match(/(\d+)%/)
      return { onBattery, percent: pctMatch ? parseInt(pctMatch[1], 10) : null }
    }
    if (platform === 'win32') {
      const batt = JSON.parse(output)
      // BatteryStatus: 1=discharging, 2=AC, 3-5=charging variants
      return { onBattery: batt.BatteryStatus === 1, percent: batt.EstimatedChargeRemaining ?? null }
    }
  } catch { /* unparseable — no battery reading */ }
  return { onBattery: false, percent: null }
}

module.exports = { ResourceMonitor, parseBattery, batteryCommand }
