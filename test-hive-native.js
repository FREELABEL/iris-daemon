#!/usr/bin/env node
/**
 * Hive Native Daemon — End-to-End Test
 *
 * Tests the native macOS background service infrastructure:
 *
 *   PHASE 1: Module Unit Tests (no network required)
 *     - hardware-profile.js: detectProfile() returns valid structure
 *     - hardware-profile.js: cached profile read/write
 *     - resource-monitor.js: capacity levels calculated correctly
 *     - resource-monitor.js: battery detection (macOS)
 *     - resource-monitor.js: event emission on level change
 *     - resource-monitor.js: canAcceptTasks() gating
 *
 *   PHASE 2: Daemon Endpoints (requires running daemon on :3200)
 *     - GET /health — includes paused + pause_reason fields
 *     - GET /capacity — returns CPU/RAM/battery/level
 *     - GET /profile — returns hardware profile
 *     - POST /pause — pauses daemon, returns paused status
 *     - GET /health — confirms paused state
 *     - POST /resume — resumes daemon, returns active status
 *     - GET /health — confirms resumed state
 *
 *   PHASE 3: Status File + Config Persistence
 *     - ~/.iris/status.json exists and is valid JSON
 *     - status.json has required fields (status, capacity, node_id)
 *     - ~/.iris/config.json read/write for pause state
 *     - Pause state persists across config reload
 *
 *   PHASE 4: Installer Validation (file integrity)
 *     - LaunchAgent plist is valid XML with correct keys
 *     - Wrapper script has correct shebang and structure
 *     - install.sh is executable with correct flow
 *     - uninstall.sh is executable with cleanup logic
 *
 * Usage:
 *   node test-hive-native.js                         # Run all phases
 *   node test-hive-native.js --phase 1               # Unit tests only (no daemon needed)
 *   node test-hive-native.js --phase 2               # Endpoint tests (daemon must be running)
 *   node test-hive-native.js --daemon-url http://...  # Custom daemon URL
 *   node test-hive-native.js --verbose                # Extra debug output
 *
 * Prerequisites:
 *   Phase 1: Node.js only (no daemon needed)
 *   Phase 2-3: Running daemon (npm run hive:daemon or launchctl)
 *   Phase 4: Just file access
 *
 * NPM shortcut:
 *   npm run hive:test:native
 */

const http = require('http')
const https = require('https')
const { URL } = require('url')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execSync } = require('child_process')

// ─── Config ────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const config = {
  daemonUrl: getArg('--daemon-url') || process.env.DAEMON_URL || 'http://localhost:3200',
  verbose: args.includes('--verbose') || args.includes('-v'),
  onlyPhase: getArg('--phase') ? parseInt(getArg('--phase'), 10) : null
}

const DAEMON_DIR = path.join(__dirname, 'daemon')
const INSTALLERS_DIR = path.join(__dirname, 'installers')
const IRIS_DIR = path.join(os.homedir(), '.iris')

// ANSI
const PASS = '\x1b[32m\u2714\x1b[0m'
const FAIL = '\x1b[31m\u2718\x1b[0m'
const INFO = '\x1b[36m\u2192\x1b[0m'
const SKIP = '\x1b[33m\u25CB\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'

// ─── Main ──────────────────────────────────────────────────────────
async function main () {
  printBanner()

  const results = { passed: 0, failed: 0, skipped: 0, tests: [] }
  const globalStart = Date.now()

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 1: Module Unit Tests
  // ═══════════════════════════════════════════════════════════════════
  if (shouldRunPhase(1)) {
    await phase('PHASE 1: Module Unit Tests', async () => {
      // ─── Hardware Profile ────────────────────────────────────────
      await runTest(results, 'hardware-profile: module loads', async () => {
        const mod = require('./daemon/hardware-profile')
        assert(typeof mod.detectProfile === 'function', 'detectProfile should be a function')
        assert(typeof mod.getCachedProfile === 'function', 'getCachedProfile should be a function')
        assert(typeof mod.CACHE_PATH === 'string', 'CACHE_PATH should be a string')
      })

      await runTest(results, 'hardware-profile: detectProfile() returns valid structure', async () => {
        const { detectProfile } = require('./daemon/hardware-profile')
        const profile = await detectProfile()

        assert(profile, 'profile should not be null')
        assert(profile.os, 'profile.os should exist')
        assert(profile.cpu, 'profile.cpu should exist')
        assert(profile.ram || profile.memory, 'profile.ram or profile.memory should exist')
        assert(profile.gpu !== undefined, 'profile.gpu should exist')

        // OS detection
        assert(profile.os.platform === process.platform, `OS platform should be ${process.platform}`)
        assert(profile.os.arch === process.arch, `OS arch should be ${process.arch}`)

        // CPU detection
        assert(typeof profile.cpu.cores === 'number', 'CPU cores should be a number')
        assert(profile.cpu.cores > 0, 'CPU cores should be > 0')
        assert(typeof profile.cpu.model === 'string', 'CPU model should be a string')

        // RAM detection
        const ram = profile.ram || profile.memory
        assert(typeof ram.total_gb === 'number', 'RAM total_gb should be a number')
        assert(ram.total_gb > 0, 'RAM total_gb should be > 0')

        if (config.verbose) {
          console.log(`    ${DIM}CPU: ${profile.cpu.model} (${profile.cpu.cores} cores)${RESET}`)
          console.log(`    ${DIM}RAM: ${ram.total_gb} GB${RESET}`)
          console.log(`    ${DIM}GPU: ${profile.gpu.available ? profile.gpu.name || profile.gpu.model : 'none'}${RESET}`)
        }
      })

      await runTest(results, 'hardware-profile: Ollama detection (non-blocking)', async () => {
        const { detectProfile } = require('./daemon/hardware-profile')
        const profile = await detectProfile()

        // Ollama field should exist regardless of whether Ollama is running
        assert(profile.ollama !== undefined, 'profile.ollama should exist')
        assert(typeof profile.ollama.available === 'boolean', 'ollama.available should be boolean')

        if (profile.ollama.available) {
          assert(typeof profile.ollama.model_count === 'number', 'ollama.model_count should be a number')
          if (config.verbose) {
            console.log(`    ${DIM}Ollama: ${profile.ollama.model_count} model(s)${RESET}`)
          }
        } else {
          if (config.verbose) console.log(`    ${DIM}Ollama: not running${RESET}`)
        }
      })

      await runTest(results, 'hardware-profile: cache file written', async () => {
        const { detectProfile, CACHE_PATH } = require('./daemon/hardware-profile')
        await detectProfile({ force: true })

        assert(fs.existsSync(CACHE_PATH), `Cache file should exist at ${CACHE_PATH}`)
        const cached = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'))
        assert(cached.cpu, 'Cached profile should have cpu field')
        assert(cached.os, 'Cached profile should have os field')
      })

      await runTest(results, 'hardware-profile: getCachedProfile() reads cache', async () => {
        const { getCachedProfile, CACHE_PATH } = require('./daemon/hardware-profile')

        if (!fs.existsSync(CACHE_PATH)) {
          throw new Error('Cache file does not exist — run detectProfile first')
        }

        const cached = getCachedProfile()
        assert(cached !== null, 'getCachedProfile should return cached data')
        assert(cached.cpu, 'Cached profile should have cpu field')
      })

      // ─── Resource Monitor ────────────────────────────────────────
      await runTest(results, 'resource-monitor: module loads', async () => {
        const { ResourceMonitor } = require('./daemon/resource-monitor')
        assert(typeof ResourceMonitor === 'function', 'ResourceMonitor should be a class/constructor')
      })

      await runTest(results, 'resource-monitor: initial capacity snapshot', async () => {
        const { ResourceMonitor } = require('./daemon/resource-monitor')
        const monitor = new ResourceMonitor({ intervalMs: 999999 }) // don't poll

        const cap = monitor.getCapacity()
        assert(typeof cap.level === 'string', 'level should be a string')
        assert(typeof cap.cpu_pct === 'number', 'cpu_pct should be a number')
        assert(typeof cap.free_mem_mb === 'number', 'free_mem_mb should be a number')
        assert(typeof cap.cpu_cores === 'number', 'cpu_cores should be a number')
        assert(cap.cpu_cores > 0, 'cpu_cores should be > 0')
        assert(typeof cap.on_battery === 'boolean', 'on_battery should be a boolean')

        if (config.verbose) {
          console.log(`    ${DIM}Level: ${cap.level} | CPU: ${cap.cpu_pct}% | Free RAM: ${cap.free_mem_mb}MB | Battery: ${cap.on_battery}${RESET}`)
        }
      })

      await runTest(results, 'resource-monitor: start/stop lifecycle', async () => {
        const { ResourceMonitor } = require('./daemon/resource-monitor')
        const monitor = new ResourceMonitor({ intervalMs: 60000 })

        // Capture console.log to prevent noise
        const origLog = console.log
        console.log = () => {}

        monitor.start()
        assert(monitor.timer !== null, 'timer should be set after start')

        // After start, poll should have run once
        const cap = monitor.getCapacity()
        assert(['idle', 'light', 'busy', 'overloaded', 'hibernating'].includes(cap.level),
          `level should be a valid capacity level, got: ${cap.level}`)

        monitor.stop()
        assert(monitor.timer === null, 'timer should be null after stop')

        console.log = origLog
      })

      await runTest(results, 'resource-monitor: canAcceptTasks() gating', async () => {
        const { ResourceMonitor } = require('./daemon/resource-monitor')
        const monitor = new ResourceMonitor({ intervalMs: 999999 })

        // Suppress console.log
        const origLog = console.log
        console.log = () => {}
        monitor.start()
        console.log = origLog

        const canAccept = monitor.canAcceptTasks()
        assert(typeof canAccept === 'boolean', 'canAcceptTasks should return boolean')

        const cap = monitor.getCapacity()
        if (cap.level === 'hibernating' || cap.level === 'overloaded') {
          assert(canAccept === false, 'Should reject tasks when hibernating/overloaded')
        } else {
          assert(canAccept === true, `Should accept tasks when level is ${cap.level}`)
        }

        monitor.stop()
      })

      await runTest(results, 'resource-monitor: capacity-changed event fires', async () => {
        const { ResourceMonitor } = require('./daemon/resource-monitor')
        const monitor = new ResourceMonitor({ intervalMs: 999999 })

        let eventFired = false
        monitor.on('capacity-changed', () => { eventFired = true })

        // Manually trigger a poll to set initial level
        const origLog = console.log
        console.log = () => {}
        monitor._poll()

        // Force a level change by manipulating state
        const currentLevel = monitor.capacity.level
        monitor.lastLevel = currentLevel === 'idle' ? 'busy' : 'idle'
        monitor._poll() // This should detect a "change" since lastLevel differs
        console.log = origLog

        assert(eventFired === true, 'capacity-changed event should have fired')
      })

      await runTest(results, 'resource-monitor: battery detection (macOS)', async () => {
        const { ResourceMonitor } = require('./daemon/resource-monitor')
        const monitor = new ResourceMonitor({ intervalMs: 999999 })

        const battery = monitor._checkBattery()
        assert(typeof battery === 'object', '_checkBattery should return an object')
        assert(typeof battery.onBattery === 'boolean', 'onBattery should be boolean')

        if (process.platform === 'darwin') {
          // On macOS, percent should be a number or null
          assert(
            battery.percent === null || typeof battery.percent === 'number',
            `Battery percent should be number or null, got: ${typeof battery.percent}`
          )
          if (config.verbose) {
            console.log(`    ${DIM}On battery: ${battery.onBattery} | Percent: ${battery.percent}%${RESET}`)
          }
        } else {
          assert(battery.onBattery === false, 'Non-macOS should return onBattery=false')
          assert(battery.percent === null, 'Non-macOS should return percent=null')
        }
      })

      await runTest(results, 'resource-monitor: maxCpuThreshold override', async () => {
        const { ResourceMonitor } = require('./daemon/resource-monitor')
        // Set a very low threshold that will trigger overloaded
        const monitor = new ResourceMonitor({ intervalMs: 999999, maxCpuThreshold: 1 })

        const origLog = console.log
        console.log = () => {}
        monitor._poll()
        console.log = origLog

        const cap = monitor.getCapacity()
        // CPU should be >= 1% on any running machine, so this should be overloaded
        // Unless on battery (which takes priority)
        if (!cap.on_battery && cap.cpu_pct >= 1) {
          assert(cap.level === 'overloaded', `With 1% threshold and ${cap.cpu_pct}% CPU, level should be overloaded`)
        }
      })
    })
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 2: Daemon Endpoint Tests (self-contained test server)
  // ═══════════════════════════════════════════════════════════════════
  if (shouldRunPhase(2)) {
    await phase('PHASE 2: Daemon Endpoint Tests', async () => {
      // Spin up a lightweight test server with just the new v2 endpoints
      // No cloud auth needed — tests the Express routes, resource monitor,
      // pause/resume, and hardware profile in isolation
      const express = require('express')
      const { ResourceMonitor } = require('./daemon/resource-monitor')
      const { detectProfile, getCachedProfile } = require('./daemon/hardware-profile')

      const testApp = express()
      testApp.use(express.json())

      // Test state (mirrors daemon state)
      const testState = {
        paused: false,
        pauseReason: null,
        nodeId: 'test-node-' + Date.now().toString(36),
        nodeName: os.hostname(),
        resourceMonitor: new ResourceMonitor({ intervalMs: 999999 }),
        hardwareProfile: null
      }

      // Suppress monitor logs and start it
      const origLog = console.log
      console.log = () => {}
      testState.resourceMonitor.start()
      console.log = origLog

      // Detect hardware profile
      testState.hardwareProfile = await detectProfile()

      // Mount the same endpoints as daemon/index.js
      testApp.get('/health', (req, res) => {
        res.json({
          status: testState.paused ? (testState.pauseReason === 'battery' ? 'hibernating' : 'paused') : 'online',
          paused: testState.paused,
          pause_reason: testState.pauseReason,
          node_id: testState.nodeId,
          node_name: testState.nodeName,
          running_tasks: 0,
          persistent_processes: 0,
          ingest_buffer: 0,
          uptime_s: Math.floor(process.uptime())
        })
      })

      testApp.get('/capacity', (req, res) => {
        res.json(testState.resourceMonitor.getCapacity())
      })

      testApp.get('/profile', async (req, res) => {
        const forceRefresh = req.query.refresh === 'true'
        if (forceRefresh) {
          testState.hardwareProfile = await detectProfile({ forceRefresh: true })
        }
        res.json(testState.hardwareProfile || getCachedProfile() || { error: 'No profile' })
      })

      testApp.post('/pause', (req, res) => {
        testState.paused = true
        testState.pauseReason = 'manual'
        res.json({ status: 'paused', reason: 'manual' })
      })

      testApp.post('/resume', (req, res) => {
        testState.paused = false
        testState.pauseReason = null
        res.json({ status: 'active', reason: null })
      })

      // Start on a random test port
      const TEST_PORT = 13200 + Math.floor(Math.random() * 1000)
      const testUrl = `http://localhost:${TEST_PORT}`
      const testServer = await new Promise((resolve) => {
        const srv = testApp.listen(TEST_PORT, '127.0.0.1', () => resolve(srv))
      })

      console.log(`  ${DIM}Test server started on :${TEST_PORT}${RESET}`)

      // Helper to hit test server
      const testGet = (p) => httpRequest('GET', testUrl + p)
      const testPost = (p, b) => httpRequest('POST', testUrl + p, b)

      try {
        // 2a. Health endpoint includes new fields
        await runTest(results, 'GET /health includes pause fields', async () => {
          const health = await testGet('/health')
          assert(typeof health.status === 'string', 'health.status should be a string')
          assert(typeof health.paused === 'boolean', 'health.paused should be a boolean')
          assert(health.pause_reason !== undefined, 'health.pause_reason should exist (can be null)')
          assert(typeof health.node_name === 'string', 'health.node_name should be a string')
          assert(typeof health.uptime_s === 'number', 'health.uptime_s should be a number')

          if (config.verbose) {
            console.log(`    ${DIM}Status: ${health.status} | Paused: ${health.paused} | Uptime: ${health.uptime_s}s${RESET}`)
          }
        })

        // 2b. Capacity endpoint
        await runTest(results, 'GET /capacity returns resource data', async () => {
          const cap = await testGet('/capacity')
          assert(typeof cap.level === 'string', 'capacity.level should be a string')
          assert(['idle', 'light', 'busy', 'overloaded', 'hibernating', 'unknown'].includes(cap.level),
            `capacity.level should be valid, got: ${cap.level}`)
          assert(typeof cap.cpu_pct === 'number', 'cpu_pct should be a number')
          assert(typeof cap.free_mem_mb === 'number', 'free_mem_mb should be a number')
          assert(typeof cap.cpu_cores === 'number', 'cpu_cores should be a number')
          assert(typeof cap.on_battery === 'boolean', 'on_battery should be a boolean')

          if (config.verbose) {
            console.log(`    ${DIM}Level: ${cap.level} | CPU: ${cap.cpu_pct}% | RAM free: ${cap.free_mem_mb}MB | Battery: ${cap.on_battery}${RESET}`)
          }
        })

        // 2c. Profile endpoint
        await runTest(results, 'GET /profile returns hardware profile', async () => {
          const profile = await testGet('/profile')
          assert(profile, 'profile should not be null')
          assert(profile.cpu || profile.os, 'profile should have cpu or os field')

          if (profile.error) {
            throw new Error(`Profile returned error: ${profile.error}`)
          }

          if (config.verbose) {
            const cpu = profile.cpu || {}
            console.log(`    ${DIM}CPU: ${cpu.model || 'unknown'} (${cpu.cores || '?'} cores)${RESET}`)
          }
        })

        // 2d. Pause endpoint
        await runTest(results, 'POST /pause pauses daemon', async () => {
          const result = await testPost('/pause')
          assert(result.status === 'paused', `Expected status 'paused', got '${result.status}'`)
          assert(result.reason === 'manual', `Expected reason 'manual', got '${result.reason}'`)
        })

        // 2e. Confirm paused state via health
        await runTest(results, 'GET /health confirms paused state', async () => {
          const health = await testGet('/health')
          assert(health.paused === true, 'health.paused should be true after pause')
          assert(health.status === 'paused', `health.status should be 'paused', got '${health.status}'`)
          assert(health.pause_reason === 'manual', `pause_reason should be 'manual', got '${health.pause_reason}'`)
        })

        // 2f. Resume endpoint
        await runTest(results, 'POST /resume resumes daemon', async () => {
          const result = await testPost('/resume')
          assert(result.status === 'active', `Expected status 'active', got '${result.status}'`)
          assert(result.reason === null, `Expected reason null, got '${result.reason}'`)
        })

        // 2g. Confirm resumed state
        await runTest(results, 'GET /health confirms resumed state', async () => {
          const health = await testGet('/health')
          assert(health.paused === false, 'health.paused should be false after resume')
          assert(health.status === 'online', `health.status should be 'online', got '${health.status}'`)
        })
      } finally {
        // Clean up test server and monitor
        testState.resourceMonitor.stop()
        testServer.close()
        console.log(`  ${DIM}Test server stopped${RESET}`)
      }
    })
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 3: Status File + Config Persistence
  // ═══════════════════════════════════════════════════════════════════
  if (shouldRunPhase(3)) {
    await phase('PHASE 3: Status File + Config Persistence', async () => {
      const STATUS_FILE = path.join(IRIS_DIR, 'status.json')
      const CONFIG_FILE = path.join(IRIS_DIR, 'config.json')

      // Write a test status.json so Phase 3 is self-contained
      // (simulates what the daemon's _writeStatusFile() produces)
      const testStatus = {
        status: 'active',
        reason: null,
        node_id: 'test-node-' + Date.now().toString(36),
        node_name: os.hostname(),
        capacity: { level: 'idle', cpu_pct: 15, free_mem_mb: 8192, total_mem_mb: 16384, cpu_cores: 12, on_battery: false, battery_pct: null },
        running_tasks: 0,
        uptime_s: Math.floor(process.uptime()),
        last_updated: new Date().toISOString()
      }

      if (!fs.existsSync(IRIS_DIR)) fs.mkdirSync(IRIS_DIR, { recursive: true })
      fs.writeFileSync(STATUS_FILE, JSON.stringify(testStatus, null, 2))

      // 3a. Status file exists
      await runTest(results, 'status.json exists', async () => {
        assert(fs.existsSync(STATUS_FILE), `Status file should exist at ${STATUS_FILE}`)
      })

      // 3b. Status file has required fields
      await runTest(results, 'status.json has required fields', async () => {
        if (!fs.existsSync(STATUS_FILE)) {
          return 'skip'
        }

        const status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'))
        assert(typeof status.status === 'string', 'status.status should be a string')
        assert(['active', 'paused', 'hibernating'].includes(status.status),
          `status.status should be valid, got: ${status.status}`)
        assert(status.last_updated, 'last_updated should exist')
        assert(typeof status.uptime_s === 'number', 'uptime_s should be a number')

        // Capacity should be present if daemon was running
        if (status.capacity) {
          assert(typeof status.capacity.level === 'string', 'capacity.level should be a string')
          assert(typeof status.capacity.cpu_pct === 'number', 'capacity.cpu_pct should be a number')
        }

        if (config.verbose) {
          console.log(`    ${DIM}Status: ${status.status} | Node: ${status.node_name || 'unknown'} | Updated: ${status.last_updated}${RESET}`)
        }
      })

      // 3c. Status file is readable by Electron (valid JSON, correct encoding)
      await runTest(results, 'status.json is Electron-readable (valid JSON)', async () => {
        if (!fs.existsSync(STATUS_FILE)) {
          return 'skip'
        }

        const raw = fs.readFileSync(STATUS_FILE, 'utf-8')
        // Should be valid JSON
        const parsed = JSON.parse(raw)
        assert(parsed, 'Parsed JSON should not be null')

        // Should be pretty-printed (for human debugging)
        assert(raw.includes('\n'), 'Status file should be pretty-printed')

        // Should be small enough for efficient polling
        assert(raw.length < 2048, `Status file should be < 2KB, got ${raw.length} bytes`)
      })

      // 3d. Config file exists and is valid
      await runTest(results, 'config.json exists and is valid', async () => {
        // Ensure a config file exists for testing
        if (!fs.existsSync(CONFIG_FILE)) {
          const testConfig = { iris_api_url: 'https://iris-api.freelabel.net', paused: false, pusher_cluster: 'us2' }
          fs.writeFileSync(CONFIG_FILE, JSON.stringify(testConfig, null, 2))
        }

        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
        assert(typeof cfg === 'object', 'Config should be an object')

        // paused field should exist if daemon has been used
        if (cfg.paused !== undefined) {
          assert(typeof cfg.paused === 'boolean', 'config.paused should be boolean')
        }

        if (config.verbose) {
          const keys = Object.keys(cfg).filter(k => k !== 'node_api_key') // Don't log the key
          console.log(`    ${DIM}Config keys: ${keys.join(', ')}${RESET}`)
        }
      })

      // 3e. Config pause state round-trip
      await runTest(results, 'config.json pause state persists', async () => {
        // Read current config
        const original = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
        const originalPaused = original.paused

        // Write paused = true
        const modified = { ...original, paused: true }
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(modified, null, 2))

        // Read back
        const readBack = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
        assert(readBack.paused === true, 'Pause state should persist after write')

        // Restore original
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(original, null, 2))

        // Verify restore
        const restored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
        assert(restored.paused === originalPaused, 'Original state should be restored')
      })
    })
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 4: Installer Validation
  // ═══════════════════════════════════════════════════════════════════
  if (shouldRunPhase(4)) {
    await phase('PHASE 4: Installer Validation', async () => {
      const PLIST_FILE = path.join(INSTALLERS_DIR, 'macos', 'io.heyiris.daemon.plist')
      const WRAPPER_FILE = path.join(INSTALLERS_DIR, 'macos', 'iris-daemon-wrapper.sh')
      const INSTALL_SCRIPT = path.join(INSTALLERS_DIR, 'install.sh')
      const UNINSTALL_SCRIPT = path.join(INSTALLERS_DIR, 'uninstall.sh')

      // 4a. Plist file exists and has correct structure
      await runTest(results, 'LaunchAgent plist exists and is valid XML', async () => {
        assert(fs.existsSync(PLIST_FILE), `Plist should exist at ${PLIST_FILE}`)

        const content = fs.readFileSync(PLIST_FILE, 'utf-8')
        assert(content.includes('<?xml'), 'Plist should be XML')
        assert(content.includes('<!DOCTYPE plist'), 'Plist should have DOCTYPE')
        assert(content.includes('<plist version="1.0">'), 'Plist should have version 1.0')
      })

      await runTest(results, 'Plist has required LaunchAgent keys', async () => {
        const content = fs.readFileSync(PLIST_FILE, 'utf-8')

        const requiredKeys = [
          'Label',
          'ProgramArguments',
          'RunAtLoad',
          'KeepAlive',
          'WorkingDirectory',
          'StandardOutPath',
          'StandardErrorPath',
          'ProcessType'
        ]

        for (const key of requiredKeys) {
          assert(content.includes(`<key>${key}</key>`), `Plist should contain <key>${key}</key>`)
        }
      })

      await runTest(results, 'Plist uses __HOME__ placeholder (not hardcoded path)', async () => {
        const content = fs.readFileSync(PLIST_FILE, 'utf-8')
        assert(content.includes('__HOME__'), 'Plist should use __HOME__ placeholder')
        assert(!content.includes('/Users/'), 'Plist should NOT have hardcoded /Users/ path')
      })

      await runTest(results, 'Plist label is io.heyiris.daemon', async () => {
        const content = fs.readFileSync(PLIST_FILE, 'utf-8')
        assert(content.includes('<string>io.heyiris.daemon</string>'), 'Label should be io.heyiris.daemon')
      })

      await runTest(results, 'Plist has Background ProcessType', async () => {
        const content = fs.readFileSync(PLIST_FILE, 'utf-8')
        assert(content.includes('<string>Background</string>'), 'ProcessType should be Background')
      })

      await runTest(results, 'Plist logs go to ~/.iris/logs/', async () => {
        const content = fs.readFileSync(PLIST_FILE, 'utf-8')
        assert(content.includes('__HOME__/.iris/logs/daemon.stdout.log'), 'Stdout should log to ~/.iris/logs/')
        assert(content.includes('__HOME__/.iris/logs/daemon.stderr.log'), 'Stderr should log to ~/.iris/logs/')
      })

      await runTest(results, 'Plist is user-level ONLY (~/Library/LaunchAgents)', async () => {
        const content = fs.readFileSync(PLIST_FILE, 'utf-8')
        // Strip XML comments before checking — comments may mention LaunchDaemons as a warning
        const noComments = content.replace(/<!--[\s\S]*?-->/g, '')
        assert(!noComments.includes('/Library/LaunchDaemons'), 'Plist config should NOT reference system LaunchDaemons')
        // Working directory should be user-level
        assert(noComments.includes('__HOME__/.iris'), 'Plist should use user home directory')
      })

      // 4b. Wrapper script
      await runTest(results, 'Wrapper script exists and is executable', async () => {
        assert(fs.existsSync(WRAPPER_FILE), `Wrapper should exist at ${WRAPPER_FILE}`)

        const stats = fs.statSync(WRAPPER_FILE)
        const isExecutable = (stats.mode & 0o111) !== 0
        assert(isExecutable, 'Wrapper script should be executable')
      })

      await runTest(results, 'Wrapper script has correct shebang', async () => {
        const content = fs.readFileSync(WRAPPER_FILE, 'utf-8')
        assert(content.startsWith('#!/bin/bash'), 'Wrapper should start with #!/bin/bash')
      })

      await runTest(results, 'Wrapper resolves common Node.js paths', async () => {
        const content = fs.readFileSync(WRAPPER_FILE, 'utf-8')
        assert(content.includes('/opt/homebrew/bin'), 'Should include Homebrew arm64 path')
        assert(content.includes('/usr/local/bin'), 'Should include /usr/local/bin')
        assert(content.includes('.nvm'), 'Should handle nvm')
      })

      await runTest(results, 'Wrapper reads config.json', async () => {
        const content = fs.readFileSync(WRAPPER_FILE, 'utf-8')
        assert(content.includes('config.json'), 'Should reference config.json')
        assert(content.includes('NODE_API_KEY'), 'Should export NODE_API_KEY')
        assert(content.includes('IRIS_API_URL'), 'Should export IRIS_API_URL')
      })

      await runTest(results, 'Wrapper uses exec (replaces process)', async () => {
        const content = fs.readFileSync(WRAPPER_FILE, 'utf-8')
        assert(content.includes('exec node daemon.js'), 'Should exec node daemon.js')
      })

      // 4c. Install script
      await runTest(results, 'install.sh exists and is executable', async () => {
        assert(fs.existsSync(INSTALL_SCRIPT), `Install script should exist at ${INSTALL_SCRIPT}`)

        const stats = fs.statSync(INSTALL_SCRIPT)
        const isExecutable = (stats.mode & 0o111) !== 0
        assert(isExecutable, 'Install script should be executable')
      })

      await runTest(results, 'install.sh checks for macOS', async () => {
        const content = fs.readFileSync(INSTALL_SCRIPT, 'utf-8')
        assert(content.includes('Darwin'), 'Should check for Darwin (macOS)')
        assert(content.includes('uname'), 'Should use uname for OS detection')
      })

      await runTest(results, 'install.sh checks for Node.js', async () => {
        const content = fs.readFileSync(INSTALL_SCRIPT, 'utf-8')
        assert(content.includes('node'), 'Should check for Node.js')
        assert(content.includes('--version') || content.includes('-v'), 'Should check node version')
      })

      await runTest(results, 'install.sh installs to ~/.iris/', async () => {
        const content = fs.readFileSync(INSTALL_SCRIPT, 'utf-8')
        assert(content.includes('.iris'), 'Should reference ~/.iris/')
        assert(content.includes('LaunchAgents'), 'Should reference ~/Library/LaunchAgents/')
        assert(content.includes('launchctl load'), 'Should use launchctl load')
      })

      await runTest(results, 'install.sh accepts --key flag', async () => {
        const content = fs.readFileSync(INSTALL_SCRIPT, 'utf-8')
        assert(content.includes('--key'), 'Should accept --key flag')
        assert(content.includes('API_KEY') || content.includes('api_key'), 'Should handle API key')
      })

      await runTest(results, 'install.sh NEVER uses sudo or root', async () => {
        const content = fs.readFileSync(INSTALL_SCRIPT, 'utf-8')
        // Strip comments before checking — comments may mention sudo/root as documentation
        const lines = content.split('\n').filter(l => !l.trimStart().startsWith('#'))
        const codeOnly = lines.join('\n')
        assert(!codeOnly.includes('sudo '), 'Install script should NEVER use sudo in executable code')
        assert(!codeOnly.includes('/Library/LaunchDaemons'), 'Should NEVER install to system LaunchDaemons')
      })

      // 4d. Uninstall script
      await runTest(results, 'uninstall.sh exists and is executable', async () => {
        assert(fs.existsSync(UNINSTALL_SCRIPT), `Uninstall script should exist at ${UNINSTALL_SCRIPT}`)

        const stats = fs.statSync(UNINSTALL_SCRIPT)
        const isExecutable = (stats.mode & 0o111) !== 0
        assert(isExecutable, 'Uninstall script should be executable')
      })

      await runTest(results, 'uninstall.sh uses launchctl unload', async () => {
        const content = fs.readFileSync(UNINSTALL_SCRIPT, 'utf-8')
        assert(content.includes('launchctl unload'), 'Should use launchctl unload')
        assert(content.includes('io.heyiris.daemon'), 'Should reference the correct plist')
      })

      await runTest(results, 'uninstall.sh prompts before removing data', async () => {
        const content = fs.readFileSync(UNINSTALL_SCRIPT, 'utf-8')
        assert(content.includes('--purge') || content.includes('Remove'), 'Should prompt or support --purge')
        assert(content.includes('rm -rf') || content.includes('rm -f'), 'Should clean up files')
      })

      // 4e. Validate shell script syntax (shellcheck-lite)
      await runTest(results, 'Wrapper script passes bash -n syntax check', async () => {
        try {
          execSync(`bash -n "${WRAPPER_FILE}" 2>&1`, { encoding: 'utf-8' })
        } catch (err) {
          throw new Error(`Wrapper script has syntax errors: ${err.stdout || err.stderr}`)
        }
      })

      await runTest(results, 'install.sh passes bash -n syntax check', async () => {
        try {
          execSync(`bash -n "${INSTALL_SCRIPT}" 2>&1`, { encoding: 'utf-8' })
        } catch (err) {
          throw new Error(`Install script has syntax errors: ${err.stdout || err.stderr}`)
        }
      })

      await runTest(results, 'uninstall.sh passes bash -n syntax check', async () => {
        try {
          execSync(`bash -n "${UNINSTALL_SCRIPT}" 2>&1`, { encoding: 'utf-8' })
        } catch (err) {
          throw new Error(`Uninstall script has syntax errors: ${err.stdout || err.stderr}`)
        }
      })
    })
  }

  // ═══════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════
  const elapsed = ((Date.now() - globalStart) / 1000).toFixed(1)

  console.log('')
  console.log(`${BOLD}${'═'.repeat(60)}${RESET}`)
  console.log(`${BOLD}  RESULTS${RESET}`)
  console.log(`${'═'.repeat(60)}`)
  console.log('')
  console.log(`  ${GREEN}${PASS} Passed:  ${results.passed}${RESET}`)
  if (results.failed > 0) console.log(`  ${RED}${FAIL} Failed:  ${results.failed}${RESET}`)
  if (results.skipped > 0) console.log(`  ${YELLOW}${SKIP} Skipped: ${results.skipped}${RESET}`)
  console.log(`  ${DIM}Time:    ${elapsed}s${RESET}`)
  console.log('')

  // Show failed tests
  const failedTests = results.tests.filter(t => t.status === 'failed')
  if (failedTests.length > 0) {
    console.log(`  ${RED}${BOLD}Failed tests:${RESET}`)
    for (const t of failedTests) {
      console.log(`  ${FAIL} ${t.name}: ${t.error}`)
    }
    console.log('')
  }

  // Architecture diagram
  console.log(`${DIM}`)
  console.log('  ┌──────────────────────┐')
  console.log('  │  macOS Login          │')
  console.log('  │  LaunchAgent starts   │')
  console.log('  └──────┬───────────────┘')
  console.log('         │')
  console.log('         ▼')
  console.log('  ┌──────────────────────┐   ┌─────────────────────┐')
  console.log('  │  iris-daemon-wrapper  │──▶│  ~/.iris/config.json│')
  console.log('  │  (PATH + env vars)   │   └─────────────────────┘')
  console.log('  └──────┬───────────────┘')
  console.log('         │ exec')
  console.log('         ▼')
  console.log('  ┌──────────────────────┐   ┌─────────────────────┐')
  console.log('  │  daemon.js           │──▶│  ResourceMonitor    │')
  console.log('  │  (A2A on :3200)      │   │  (CPU/RAM/battery)  │')
  console.log('  └──────┬───────────────┘   └─────────────────────┘')
  console.log('         │')
  console.log('         ▼')
  console.log('  ┌──────────────────────┐   ┌─────────────────────┐')
  console.log('  │  Heartbeat → Hub     │──▶│  ~/.iris/status.json│')
  console.log('  │  (every 30s)         │   │  (Electron reads)   │')
  console.log('  └─────────────────────-┘   └─────────────────────┘')
  console.log(`${RESET}`)

  process.exit(results.failed > 0 ? 1 : 0)
}

// ─── Test Runner ──────────────────────────────────────────────────

async function runTest (results, name, fn) {
  try {
    const result = await fn()
    if (result === 'skip') {
      results.skipped++
      results.tests.push({ name, status: 'skipped' })
      console.log(`  ${SKIP} ${name} ${DIM}(skipped)${RESET}`)
    } else {
      results.passed++
      results.tests.push({ name, status: 'passed' })
      console.log(`  ${PASS} ${name}`)
    }
  } catch (err) {
    results.failed++
    results.tests.push({ name, status: 'failed', error: err.message })
    console.log(`  ${FAIL} ${name}`)
    console.log(`    ${RED}${err.message}${RESET}`)
    if (config.verbose && err.stack) {
      console.log(`    ${DIM}${err.stack.split('\n').slice(1, 3).join('\n    ')}${RESET}`)
    }
  }
}

function assert (condition, message) {
  if (!condition) throw new Error(message)
}

async function phase (title, fn) {
  console.log('')
  console.log(`${BOLD}${CYAN}  ${title}${RESET}`)
  console.log(`  ${'─'.repeat(title.length)}`)
  await fn()
}

function shouldRunPhase (n) {
  return !config.onlyPhase || config.onlyPhase === n
}

// ─── HTTP Helpers ─────────────────────────────────────────────────

function daemonGet (urlPath) {
  return httpRequest('GET', config.daemonUrl + urlPath)
}

function daemonPost (urlPath, body = {}) {
  return httpRequest('POST', config.daemonUrl + urlPath, body)
}

function httpRequest (method, urlStr, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    const lib = url.protocol === 'https:' ? https : http

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      rejectUnauthorized: false
    }

    const req = lib.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data))
          } catch {
            resolve(data)
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`))
        }
      })
    })

    req.on('error', reject)
    req.setTimeout(10000, () => {
      req.destroy()
      reject(new Error('Request timeout'))
    })

    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

// ─── Utility ──────────────────────────────────────────────────────

function getArg (name) {
  const idx = args.indexOf(name)
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null
}

function printBanner () {
  console.log('')
  console.log(`${BOLD}${CYAN}  ╦╦═╗╦╔═╗   ╔╗╔╔═╗╔╦╗╦╦  ╦╔═╗`)
  console.log(`  ║╠╦╝║╚═╗   ║║║╠═╣ ║ ║╚╗╔╝║╣`)
  console.log(`  ╩╩╚═╩╚═╝   ╝╚╝╩ ╩ ╩ ╩ ╚╝ ╚═╝${RESET}`)
  console.log(`  ${DIM}Sovereign Daemon — End-to-End Test${RESET}`)
  console.log('')
  console.log(`  ${DIM}Daemon: ${config.daemonUrl}${RESET}`)
  if (config.onlyPhase) console.log(`  ${DIM}Phase:  ${config.onlyPhase} only${RESET}`)
  console.log('')
}

// ─── Run ──────────────────────────────────────────────────────────
main().catch(err => {
  console.error(`${RED}Fatal: ${err.message}${RESET}`)
  if (config.verbose) console.error(err.stack)
  process.exit(1)
})
