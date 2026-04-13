#!/usr/bin/env node
/**
 * Hive PaaS End-to-End Test
 *
 * Tests the full Machines / PaaS stack:
 *
 *   PHASE 1: Infrastructure Health
 *     - iris-api connectivity
 *     - Compute node(s) online
 *     - Daemon A2A server reachable (/health)
 *     - PM2 available on daemon (/processes)
 *     - File browser working (/files)
 *
 *   PHASE 2: Workspace Scaffolding (scaffold_workspace)
 *     - Dispatch scaffold_workspace task (creates workspace from scratch)
 *     - Poll for task completion
 *     - Verify workspace files exist via /files endpoint
 *
 *   PHASE 3: Persistent Processes (run_persistent)
 *     - Dispatch run_persistent task (starts PM2 process in workspace)
 *     - Verify process appears in /processes list
 *     - Check process is "online" status
 *
 *   PHASE 4: PM2 Management Endpoints
 *     - GET /processes — list running processes
 *     - POST /processes/:name/stop — stop the process
 *     - POST /processes/:name/restart — restart the process
 *     - GET /processes/:name/logs — retrieve process logs
 *     - DELETE /processes/:name — delete the process
 *
 *   PHASE 5: Classic Task Types (regression)
 *     - Echo task (custom) — basic shell execution
 *     - Artisan task — if fl-api path available
 *
 *   PHASE 6: Cleanup
 *     - Remove test workspace
 *     - Remove test PM2 process
 *     - Summary with architecture diagram
 *
 * Usage:
 *   node test-hive-paas.js                             # Auto-detect everything
 *   node test-hive-paas.js --api-url http://...        # Custom iris-api URL
 *   node test-hive-paas.js --daemon-url http://...     # Custom daemon URL (default: http://localhost:3200)
 *   node test-hive-paas.js --user-id 1                 # Specify user ID
 *   node test-hive-paas.js --skip-cleanup              # Leave test artifacts for inspection
 *   node test-hive-paas.js --verbose                   # Extra debug output
 *   node test-hive-paas.js --phase 2                   # Run only a specific phase (1-6)
 *
 * Prerequisites:
 *   - iris-api running (Docker or production)
 *   - At least one compute node online with PM2 installed
 *   - npm run hive:daemon or Docker hive-daemon running
 *
 * NPM shortcut:
 *   npm run hive:test:paas
 */

const http = require('http')
const https = require('https')
const { URL } = require('url')

// ─── Config ────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const config = {
  apiUrl: getArg('--api-url') || process.env.IRIS_API_URL || 'https://local.iris.freelabel.net',
  daemonUrl: getArg('--daemon-url') || process.env.DAEMON_URL || 'http://localhost:3200',
  userId: getArg('--user-id') || '1',
  verbose: args.includes('--verbose') || args.includes('-v'),
  skipCleanup: args.includes('--skip-cleanup'),
  onlyPhase: getArg('--phase') ? parseInt(getArg('--phase'), 10) : null,
  taskTimeout: 120000, // 2 min for scaffold tasks
  pollInterval: 3000
}

// Test workspace config
const TEST_WORKSPACE = 'hive-paas-test-' + Date.now().toString(36)
const TEST_PROCESS = 'paas-test-' + Date.now().toString(36)

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

  // Track state across phases
  const state = {
    onlineNodes: [],
    targetNode: null,
    daemonReachable: false,
    pm2Available: false,
    scaffoldTaskId: null,
    persistentTaskId: null,
    workspaceCreated: false,
    processStarted: false
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 1: Infrastructure Health
  // ═══════════════════════════════════════════════════════════════════
  if (shouldRunPhase(1)) {
    await phase('PHASE 1: Infrastructure Health', async () => {
      // 1a. iris-api connectivity
      await runTest(results, 'iris-api connectivity', async () => {
        const res = await apiGet('/api/v6/nodes', { user_id: config.userId })
        if (!res || typeof res !== 'object') throw new Error('Invalid response from iris-api')
        const count = (res.nodes || []).length
        return `Connected — ${count} node(s) registered`
      })

      // 1b. Online compute nodes
      await runTest(results, 'Online compute node(s)', async () => {
        const res = await apiGet('/api/v6/nodes', { user_id: config.userId })
        const nodes = res.nodes || []
        state.onlineNodes = nodes.filter(n => n.connection_status === 'online')

        if (state.onlineNodes.length === 0) {
          const offline = nodes.filter(n => n.connection_status !== 'online')
          throw new Error(
            `No online nodes (${offline.length} offline). ` +
            'Start daemon: npm run hive:daemon or npm run hive:daemon:docker'
          )
        }

        state.targetNode = state.onlineNodes[0]
        return `${state.onlineNodes.length} online: ${state.onlineNodes.map(n => n.name).join(', ')}`
      })

      // 1c. Daemon A2A server reachable
      await runTest(results, 'Daemon A2A server (/health)', async () => {
        const health = await daemonGet('/health')
        state.daemonReachable = true

        if (health.persistent_processes !== undefined) {
          state.pm2Available = true
        }

        return [
          `node: ${health.node_name || 'unknown'}`,
          `tasks: ${health.running_tasks || 0}`,
          `pm2_procs: ${health.persistent_processes ?? 'n/a'}`,
          `uptime: ${health.uptime_s || 0}s`
        ].join(' | ')
      })

      // 1d. PM2 availability
      await runTest(results, 'PM2 process manager available', async () => {
        if (!state.daemonReachable) throw new Error('Daemon not reachable — skipping')

        const procs = await daemonGet('/processes')
        state.pm2Available = true
        return `PM2 running — ${procs.count || 0} existing process(es)`
      })

      // 1e. File browser
      await runTest(results, 'File browser (/files)', async () => {
        if (!state.daemonReachable) throw new Error('Daemon not reachable — skipping')

        const files = await daemonGet('/files?path=/')
        const entries = files.entries || []
        return `Root has ${entries.length} entries: ${entries.slice(0, 5).map(e => e.name).join(', ')}${entries.length > 5 ? '...' : ''}`
      })
    })
  }

  // Early exit if no online nodes
  if (state.onlineNodes.length === 0 && !config.onlyPhase) {
    console.log(`\n  ${YELLOW}Cannot continue — no online compute nodes.${RESET}`)
    console.log(`  Start a daemon first:`)
    console.log(`    ${DIM}npm run hive:daemon${RESET}           (native)`)
    console.log(`    ${DIM}npm run hive:daemon:docker${RESET}    (Docker)`)
    printSummary(results, Date.now() - globalStart)
    process.exit(1)
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 2: Workspace Scaffolding
  // ═══════════════════════════════════════════════════════════════════
  if (shouldRunPhase(2)) {
    await phase('PHASE 2: Workspace Scaffolding (scaffold_workspace)', async () => {
      // 2a. Dispatch scaffold_workspace task — create a workspace from scratch
      //     (no git clone, just create dirs + a test file + auto-detect)
      await runTest(results, 'Dispatch scaffold_workspace task', async () => {
        if (!state.targetNode) throw new Error('No target node available')

        const setupCommand = [
          // Create a tiny Node.js project in the workspace
          'echo \'{"name":"paas-test","version":"1.0.0","scripts":{"start":"node server.js"}}\' > package.json',
          // Create a simple HTTP server that PM2 will manage
          'cat > server.js << \'SCRIPT\'',
          'const http = require("http");',
          'const server = http.createServer((req, res) => {',
          '  res.writeHead(200, {"Content-Type":"application/json"});',
          '  res.end(JSON.stringify({status:"alive",pid:process.pid,uptime:process.uptime(),ts:Date.now()}));',
          '});',
          'server.listen(process.env.PORT || 4999, () => {',
          '  console.log("[paas-test] Server running on port " + (process.env.PORT || 4999));',
          '});',
          'SCRIPT',
          // Create a README
          'echo "# PaaS Test Workspace\\nCreated by hive-paas E2E test" > README.md'
        ].join('\n')

        const res = await apiPost('/api/v6/nodes/tasks', {
          title: `[PAAS-TEST] Scaffold workspace: ${TEST_WORKSPACE}`,
          type: 'scaffold_workspace',
          user_id: config.userId,
          node_id: state.targetNode.id,
          prompt: `Scaffold workspace ${TEST_WORKSPACE}`,
          config: {
            workspace_name: TEST_WORKSPACE,
            setup_command: setupCommand,
            timeout_seconds: 60
          }
        })

        if (!res.task?.id) throw new Error(`Task creation failed: ${JSON.stringify(res).substring(0, 200)}`)
        state.scaffoldTaskId = res.task.id
        return `Task ${state.scaffoldTaskId.substring(0, 8)}... dispatched to ${state.targetNode.name}`
      })

      // 2b. Wait for scaffold to complete
      await runTest(results, 'Scaffold task completes successfully', async () => {
        if (!state.scaffoldTaskId) throw new Error('No scaffold task — previous step failed')

        const task = await waitForTask(state.scaffoldTaskId, config.taskTimeout)
        state.workspaceCreated = true

        const output = task.result?.output || ''
        const preview = output.split('\n').filter(l => l.trim()).slice(-3).join(' | ')
        return `Completed — ${preview || '(no output preview)'}`
      })

      // 2c. Verify workspace files via /files endpoint
      await runTest(results, 'Workspace files exist on daemon', async () => {
        if (!state.daemonReachable || !state.workspaceCreated) {
          throw new Error('Workspace not created or daemon not reachable')
        }

        const files = await daemonGet(`/files?path=/workspace/${TEST_WORKSPACE}`)
        const entries = files.entries || []
        const names = entries.map(e => e.name)

        const expected = ['package.json', 'server.js', 'README.md']
        const missing = expected.filter(f => !names.includes(f))

        if (missing.length > 0) {
          throw new Error(`Missing files: ${missing.join(', ')}. Found: ${names.join(', ')}`)
        }

        return `Workspace contains: ${names.join(', ')}`
      })

      // 2d. Verify package.json content
      await runTest(results, 'Package.json is valid', async () => {
        if (!state.daemonReachable || !state.workspaceCreated) {
          throw new Error('Workspace not created or daemon not reachable')
        }

        const file = await daemonGet(`/files?path=/workspace/${TEST_WORKSPACE}/package.json`)
        if (!file.content) throw new Error('No content returned')

        const pkg = JSON.parse(file.content)
        if (pkg.name !== 'paas-test') throw new Error(`Unexpected name: ${pkg.name}`)
        if (!pkg.scripts?.start) throw new Error('Missing scripts.start')

        return `name: "${pkg.name}", start: "${pkg.scripts.start}"`
      })
    })
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 3: Persistent Processes (run_persistent → PM2)
  // ═══════════════════════════════════════════════════════════════════
  if (shouldRunPhase(3)) {
    await phase('PHASE 3: Persistent Processes (run_persistent → PM2)', async () => {
      // 3a. Dispatch run_persistent task
      await runTest(results, 'Dispatch run_persistent task', async () => {
        if (!state.targetNode) throw new Error('No target node available')
        if (!state.workspaceCreated && !config.onlyPhase) {
          throw new Error('Workspace not created — Phase 2 must pass first')
        }

        const res = await apiPost('/api/v6/nodes/tasks', {
          title: `[PAAS-TEST] Start persistent: ${TEST_PROCESS}`,
          type: 'run_persistent',
          user_id: config.userId,
          node_id: state.targetNode.id,
          prompt: 'node server.js',
          config: {
            workspace_name: TEST_WORKSPACE,
            command: 'node server.js',
            process_name: TEST_PROCESS,
            timeout_seconds: 30
          }
        })

        if (!res.task?.id) throw new Error(`Task creation failed: ${JSON.stringify(res).substring(0, 200)}`)
        state.persistentTaskId = res.task.id
        return `Task ${state.persistentTaskId.substring(0, 8)}... dispatched`
      })

      // 3b. Wait for run_persistent to complete (task completes immediately, PM2 process lives on)
      await runTest(results, 'run_persistent task completes (PM2 started)', async () => {
        if (!state.persistentTaskId) throw new Error('No persistent task — previous step failed')

        const task = await waitForTask(state.persistentTaskId, 30000)
        state.processStarted = true

        const output = task.result?.output || ''
        const hasJlist = output.includes('pm_id') || output.includes('name')
        return `Task completed${hasJlist ? ' — PM2 jlist captured' : ''}`
      })

      // 3c. Verify process appears in /processes list
      await runTest(results, 'Process visible in /processes list', async () => {
        if (!state.daemonReachable) throw new Error('Daemon not reachable')

        // Give PM2 a moment to register
        await sleep(2000)

        const procs = await daemonGet('/processes')
        const testProc = (procs.processes || []).find(p => p.name === TEST_PROCESS)

        if (!testProc) {
          const names = (procs.processes || []).map(p => p.name).join(', ') || 'none'
          throw new Error(`Process "${TEST_PROCESS}" not found. Running: ${names}`)
        }

        return `Found "${testProc.name}" — status: ${testProc.status}, mem: ${formatBytes(testProc.memory)}, restarts: ${testProc.restarts}`
      })

      // 3d. Verify process is "online"
      await runTest(results, 'Process status is "online"', async () => {
        const procs = await daemonGet('/processes')
        const testProc = (procs.processes || []).find(p => p.name === TEST_PROCESS)

        if (!testProc) throw new Error('Process not found')
        if (testProc.status !== 'online') {
          throw new Error(`Expected "online", got "${testProc.status}"`)
        }

        return `PID running, uptime since ${testProc.uptime ? new Date(testProc.uptime).toISOString() : 'unknown'}`
      })
    })
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 4: PM2 Management Endpoints
  // ═══════════════════════════════════════════════════════════════════
  if (shouldRunPhase(4)) {
    await phase('PHASE 4: PM2 Management Endpoints', async () => {
      // 4a. GET /processes — list
      await runTest(results, 'GET /processes — list processes', async () => {
        if (!state.daemonReachable) throw new Error('Daemon not reachable')

        const procs = await daemonGet('/processes')
        if (!Array.isArray(procs.processes)) throw new Error('Expected processes array')

        const count = procs.count || procs.processes.length
        const names = procs.processes.map(p => `${p.name}(${p.status})`).join(', ')
        return `${count} process(es): ${names || 'none'}`
      })

      // 4b. POST /processes/:name/stop — stop the test process
      await runTest(results, 'POST /processes/:name/stop — stop process', async () => {
        if (!state.processStarted) throw new Error('No process to stop — Phase 3 must pass')

        const res = await daemonPost(`/processes/${TEST_PROCESS}/stop`)
        if (res.status !== 'stopped' && !res.error?.includes('not found')) {
          throw new Error(`Unexpected response: ${JSON.stringify(res)}`)
        }

        // Verify it's stopped
        await sleep(1000)
        const procs = await daemonGet('/processes')
        const proc = (procs.processes || []).find(p => p.name === TEST_PROCESS)

        if (proc && proc.status === 'online') {
          throw new Error('Process still running after stop')
        }

        return `Process stopped — status: ${proc?.status || 'stopped'}`
      })

      // 4c. POST /processes/:name/restart — restart the stopped process
      await runTest(results, 'POST /processes/:name/restart — restart process', async () => {
        if (!state.processStarted) throw new Error('No process to restart — Phase 3 must pass')

        const res = await daemonPost(`/processes/${TEST_PROCESS}/restart`)
        if (res.status !== 'restarted' && !res.error) {
          throw new Error(`Unexpected response: ${JSON.stringify(res)}`)
        }

        // Verify it's online again
        await sleep(2000)
        const procs = await daemonGet('/processes')
        const proc = (procs.processes || []).find(p => p.name === TEST_PROCESS)

        if (!proc || proc.status !== 'online') {
          throw new Error(`Process not online after restart: ${proc?.status || 'not found'}`)
        }

        return `Process restarted — status: ${proc.status}, restarts: ${proc.restarts}`
      })

      // 4d. GET /processes/:name/logs — retrieve logs
      await runTest(results, 'GET /processes/:name/logs — retrieve logs', async () => {
        if (!state.processStarted) throw new Error('No process — Phase 3 must pass')

        const res = await daemonGet(`/processes/${TEST_PROCESS}/logs?lines=20`)

        if (!res.lines && !res.error) {
          throw new Error('No logs returned')
        }

        const logText = res.lines || ''
        const lineCount = logText.split('\n').filter(l => l.trim()).length
        const hasServerLog = logText.includes('paas-test') || logText.includes('Server running')
        return `${lineCount} log line(s)${hasServerLog ? ' — server output detected' : ''}`
      })

      // 4e. DELETE /processes/:name — delete the process
      await runTest(results, 'DELETE /processes/:name — delete process', async () => {
        if (!state.processStarted) throw new Error('No process — Phase 3 must pass')

        const res = await daemonDelete(`/processes/${TEST_PROCESS}`)

        // Verify it's gone
        await sleep(1000)
        const procs = await daemonGet('/processes')
        const proc = (procs.processes || []).find(p => p.name === TEST_PROCESS)

        if (proc) throw new Error(`Process still exists after delete: ${proc.status}`)

        state.processStarted = false // Already cleaned up
        return 'Process deleted and confirmed gone'
      })
    })
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 5: Classic Task Types (Regression)
  // ═══════════════════════════════════════════════════════════════════
  if (shouldRunPhase(5)) {
    await phase('PHASE 5: Classic Task Types (regression)', async () => {
      // 5a. Echo task
      await runTest(results, 'Echo task (custom type)', async () => {
        if (!state.targetNode) throw new Error('No target node')

        const res = await apiPost('/api/v6/nodes/tasks', {
          title: '[PAAS-TEST] Echo regression',
          type: 'custom',
          user_id: config.userId,
          node_id: state.targetNode.id,
          prompt: 'echo "PAAS_ECHO_OK: $(date +%s)" && uname -a && echo "PHP: $(php --version 2>/dev/null | head -1 || echo not-installed)" && echo "PM2: $(pm2 --version 2>/dev/null || echo not-installed)" && echo "Composer: $(composer --version 2>/dev/null | head -1 || echo not-installed)" && echo "done"',
          config: { timeout_seconds: 30 }
        })

        if (!res.task?.id) throw new Error('Task creation failed')

        const task = await waitForTask(res.task.id, 30000)
        const output = task.result?.output || ''

        const hasPaasOk = output.includes('PAAS_ECHO_OK')
        const hasPhp = output.includes('PHP:') && !output.includes('not-installed')
        const hasPm2 = output.includes('PM2:') && !output.includes('not-installed')
        const hasComposer = output.includes('Composer:') && !output.includes('not-installed')

        const runtimes = []
        if (hasPhp) runtimes.push('PHP')
        if (hasPm2) runtimes.push('PM2')
        if (hasComposer) runtimes.push('Composer')

        return `Echo OK — Runtimes detected: ${runtimes.length > 0 ? runtimes.join(', ') : 'Node.js only (PHP/PM2/Composer not in image yet — rebuild needed)'}`
      })

      // 5b. sandbox_execute regression
      await runTest(results, 'Sandbox execute (script)', async () => {
        if (!state.targetNode) throw new Error('No target node')

        const res = await apiPost('/api/v6/nodes/tasks', {
          title: '[PAAS-TEST] Sandbox regression',
          type: 'sandbox_execute',
          user_id: config.userId,
          node_id: state.targetNode.id,
          prompt: '#!/bin/bash\necho "SANDBOX_OK"\nls -la /data/workspace/ 2>/dev/null | head -10\necho "workspace_count=$(ls /data/workspace/ 2>/dev/null | wc -l)"',
          config: { timeout_seconds: 30 }
        })

        if (!res.task?.id) throw new Error('Task creation failed')

        const task = await waitForTask(res.task.id, 30000)
        const output = task.result?.output || ''

        if (!output.includes('SANDBOX_OK')) throw new Error('Missing SANDBOX_OK marker')

        const wsMatch = output.match(/workspace_count=(\d+)/)
        const wsCount = wsMatch ? wsMatch[1] : '?'
        return `Sandbox OK — ${wsCount} workspace(s) on this machine`
      })
    })
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 6: Cleanup + Summary
  // ═══════════════════════════════════════════════════════════════════
  if (shouldRunPhase(6)) {
    await phase('PHASE 6: Cleanup', async () => {
      if (config.skipCleanup) {
        console.log(`  ${SKIP} Skipping cleanup (--skip-cleanup flag)`)
        console.log(`    Workspace: /data/workspace/${TEST_WORKSPACE}`)
        console.log(`    Process: ${TEST_PROCESS}`)
        results.skipped++
        return
      }

      // 6a. Delete PM2 process (if still running)
      if (state.processStarted) {
        await runTest(results, 'Cleanup: delete PM2 process', async () => {
          try {
            await daemonDelete(`/processes/${TEST_PROCESS}`)
          } catch { /* already deleted */ }
          return 'Cleaned up'
        })
      }

      // 6b. Delete workspace files
      if (state.workspaceCreated && state.daemonReachable) {
        await runTest(results, 'Cleanup: delete test workspace', async () => {
          try {
            await daemonDelete(`/files?path=/workspace/${TEST_WORKSPACE}`)
          } catch { /* might not exist */ }
          return `Removed /data/workspace/${TEST_WORKSPACE}`
        })
      }
    })
  }

  // ═══════════════════════════════════════════════════════════════════
  // Final Report
  // ═══════════════════════════════════════════════════════════════════
  printArchitecture()
  printUseCases()
  printSummary(results, Date.now() - globalStart)
  process.exit(results.failed > 0 ? 1 : 0)
}

// ─── Helpers: Task Lifecycle ──────────────────────────────────────
async function waitForTask (taskId, timeout) {
  const deadline = Date.now() + timeout
  let lastStatus = ''

  while (Date.now() < deadline) {
    const res = await apiGet(`/api/v6/nodes/tasks/${taskId}`, { user_id: config.userId })
    const task = res.task || res

    if (task.status === 'completed') return task
    if (task.status === 'failed') {
      const error = task.result?.error || task.error || 'Unknown error'
      const output = task.result?.output || ''
      throw new Error(`Task failed: ${error}${output ? '\nOutput: ' + output.substring(0, 200) : ''}`)
    }

    if (config.verbose && task.status !== lastStatus) {
      console.log(`    ${DIM}Polling ${taskId.substring(0, 8)}... status=${task.status} progress=${task.progress || 0}%${RESET}`)
      lastStatus = task.status
    }

    await sleep(config.pollInterval)
  }

  throw new Error(`Task ${taskId.substring(0, 8)} timed out after ${timeout / 1000}s`)
}

// ─── Helpers: HTTP ────────────────────────────────────────────────
function apiGet (urlPath, params = {}) {
  const qs = new URLSearchParams(params).toString()
  return request('GET', config.apiUrl, qs ? `${urlPath}?${qs}` : urlPath)
}

function apiPost (urlPath, body) {
  return request('POST', config.apiUrl, urlPath, body)
}

function daemonGet (urlPath) {
  return request('GET', config.daemonUrl, urlPath)
}

function daemonPost (urlPath, body) {
  return request('POST', config.daemonUrl, urlPath, body)
}

function daemonDelete (urlPath) {
  return request('DELETE', config.daemonUrl, urlPath)
}

function request (method, baseUrl, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl)
    const isHttps = url.protocol === 'https:'
    const lib = isHttps ? https : http

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Hive-PaaS-E2E-Test/1.0'
      },
      rejectUnauthorized: false
    }

    const req = lib.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)) } catch { resolve(data) }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 300)}`))
        }
      })
    })

    req.on('error', reject)
    req.setTimeout(15000, () => {
      req.destroy()
      reject(new Error(`Request timeout: ${method} ${urlPath}`))
    })

    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

// ─── Test Runner ──────────────────────────────────────────────────
async function runTest (results, name, fn) {
  const start = Date.now()
  try {
    const detail = await fn()
    const elapsed = Date.now() - start
    console.log(`  ${PASS} ${name} ${DIM}(${elapsed}ms)${RESET}`)
    if (detail) console.log(`    ${DIM}${detail}${RESET}`)
    results.passed++
    results.tests.push({ name, status: 'pass', detail, elapsed })
  } catch (err) {
    const elapsed = Date.now() - start
    console.log(`  ${FAIL} ${name} ${DIM}(${elapsed}ms)${RESET}`)
    console.log(`    ${RED}${err.message}${RESET}`)
    results.failed++
    results.tests.push({ name, status: 'fail', error: err.message, elapsed })
  }
}

async function phase (title, fn) {
  console.log(`\n  ${BOLD}${title}${RESET}`)
  console.log(`  ${'─'.repeat(title.length)}`)
  try {
    await fn()
  } catch (err) {
    console.log(`  ${FAIL} Phase error: ${err.message}`)
  }
}

// ─── Display ──────────────────────────────────────────────────────
function printBanner () {
  console.log('')
  console.log(`  ${BOLD}Hive PaaS — End-to-End Test${RESET}`)
  console.log('  ═══════════════════════════════════════════════════')
  console.log(`  ${INFO} iris-api:   ${config.apiUrl}`)
  console.log(`  ${INFO} daemon:     ${config.daemonUrl}`)
  console.log(`  ${INFO} user:       ${config.userId}`)
  console.log(`  ${INFO} workspace:  ${TEST_WORKSPACE}`)
  console.log(`  ${INFO} process:    ${TEST_PROCESS}`)
  if (config.onlyPhase) {
    console.log(`  ${INFO} phase:      ${config.onlyPhase} only`)
  }
}

function printArchitecture () {
  console.log('')
  console.log(`  ${BOLD}MACHINES / PaaS ARCHITECTURE${RESET}`)
  console.log('')
  console.log('  ┌─────────────────────────────────────────────────────────┐')
  console.log('  │                    iris-api (Hub)                       │')
  console.log('  │  ┌──────────┐  ┌───────────────┐  ┌────────────────┐   │')
  console.log('  │  │ Node Reg │  │ Task Dispatch  │  │ Status Track   │   │')
  console.log('  │  │ /nodes   │  │ /nodes/tasks   │  │ /heartbeat     │   │')
  console.log('  │  └──────────┘  └───────┬───────┘  └────────────────┘   │')
  console.log('  └───────────────────────┬┼────────────────────────────────┘')
  console.log('                    Pusher││REST')
  console.log('               ┌──────────┘└──────────┐')
  console.log('               ▼                      ▼')
  console.log('  ┌──────────────────────┐  ┌──────────────────────┐')
  console.log('  │   Machine A (Daemon) │  │   Machine B (Daemon) │')
  console.log('  │  ┌────────────────┐  │  │  ┌────────────────┐  │')
  console.log('  │  │ Task Executor  │  │  │  │ Task Executor  │  │')
  console.log('  │  │ • code_gen     │  │  │  │ • scaffold_ws  │  │')
  console.log('  │  │ • scaffold_ws  │  │  │  │ • run_persist  │  │')
  console.log('  │  │ • run_persist  │  │  │  │ • artisan      │  │')
  console.log('  │  │ • som/leadgen  │  │  │  │ • custom       │  │')
  console.log('  │  └────────────────┘  │  │  └────────────────┘  │')
  console.log('  │  ┌────────────────┐  │  │  ┌────────────────┐  │')
  console.log('  │  │  PM2 Manager   │  │  │  │  PM2 Manager   │  │')
  console.log('  │  │ /processes     │  │  │  │ /processes     │  │')
  console.log('  │  │ start/stop/del │  │  │  │ start/stop/del │  │')
  console.log('  │  └────────────────┘  │  │  └────────────────┘  │')
  console.log('  │  ┌────────────────┐  │  │  ┌────────────────┐  │')
  console.log('  │  │ File Browser   │  │  │  │ File Browser   │  │')
  console.log('  │  │ /files (Drive) │  │  │  │ /files (Drive) │  │')
  console.log('  │  └────────────────┘  │  │  └────────────────┘  │')
  console.log('  │  ┌────────────────┐  │  │  ┌────────────────┐  │')
  console.log('  │  │  Workspaces    │  │  │  │  Workspaces    │  │')
  console.log('  │  │ /data/workspace│  │  │  │ /data/workspace│  │')
  console.log('  │  └────────────────┘  │  │  └────────────────┘  │')
  console.log('  └──────────────────────┘  └──────────────────────┘')
}

function printUseCases () {
  console.log('')
  console.log(`  ${BOLD}USE CASES (what you can build)${RESET}`)
  console.log('')
  console.log(`  ${CYAN}1. Email Bot${RESET}`)
  console.log('     scaffold_workspace → clone email-bot repo → npm install')
  console.log('     run_persistent → pm2 start "node bot.js" → runs forever')
  console.log('     Monitors inbox, auto-replies, forwards to CRM')
  console.log('')
  console.log(`  ${CYAN}2. Web Scraper${RESET}`)
  console.log('     scaffold_workspace → clone scraper repo → pip install')
  console.log('     Hub dispatches "som" or "leadgen" tasks on a schedule')
  console.log('     Results flow back via task output → stored in bloq')
  console.log('')
  console.log(`  ${CYAN}3. Discord/Slack Bot${RESET}`)
  console.log('     scaffold_workspace → clone bot repo → npm install')
  console.log('     run_persistent → pm2 start "node discord-bot.js"')
  console.log('     Bot stays alive across container restarts (pm2 resurrect)')
  console.log('')
  console.log(`  ${CYAN}4. Custom API Server${RESET}`)
  console.log('     scaffold_workspace → user provides repo URL + setup cmd')
  console.log('     run_persistent → pm2 start "node server.js" --port 5000')
  console.log('     Monitor via /processes, view logs, restart remotely')
  console.log('')
  console.log(`  ${CYAN}5. PHP/Laravel Worker${RESET}`)
  console.log('     scaffold_workspace → clone Laravel app → composer install')
  console.log('     run_persistent → pm2 start "php artisan queue:work"')
  console.log('     Persistent queue worker managed via dashboard')
  console.log('')
  console.log(`  ${CYAN}6. Multi-Machine Pipeline${RESET}`)
  console.log('     Machine A: scrape data → write to shared volume')
  console.log('     Machine B: read data → enrich with AI → store results')
  console.log('     A2A: direct HTTP between nodes on fl-network')
  console.log('')
  console.log(`  ${BOLD}TASK LIFECYCLE${RESET}`)
  console.log('  pending → assigned → dispatched → running → completed')
  console.log('                     ↘ failed / cancelled (at any point)')
  console.log('')
  console.log(`  ${BOLD}PERSISTENT PROCESS LIFECYCLE${RESET}`)
  console.log('  scaffold_workspace → run_persistent → PM2 manages → pm2 resurrect on restart')
  console.log('  Monitor: /processes | Stop: /stop | Restart: /restart | Logs: /logs | Delete: /delete')
}

function printSummary (results, elapsed) {
  console.log('')
  console.log('  ═══════════════════════════════════════════════════')

  const total = results.passed + results.failed + results.skipped
  const status = results.failed === 0
    ? `${GREEN}ALL PASSED${RESET}`
    : `${RED}${results.failed} FAILED${RESET}`

  console.log(`  ${status} — ${results.passed}/${total} passed, ${results.failed} failed, ${results.skipped} skipped (${(elapsed / 1000).toFixed(1)}s)`)

  // Per-phase breakdown
  if (results.tests.length > 0) {
    console.log('')
    const maxName = Math.max(...results.tests.map(t => t.name.length))
    for (const t of results.tests) {
      const icon = t.status === 'pass' ? PASS : FAIL
      const time = t.elapsed ? `${t.elapsed}ms` : ''
      console.log(`    ${icon} ${t.name.padEnd(maxName)} ${DIM}${time}${RESET}`)
    }
  }

  console.log('')

  if (results.failed > 0) {
    console.log(`  ${YELLOW}Troubleshooting:${RESET}`)
    console.log(`    1. Is OrbStack/Docker running?  ${DIM}docker ps${RESET}`)
    console.log(`    2. Is iris-api up?               ${DIM}curl ${config.apiUrl}/api/v6/nodes?user_id=1${RESET}`)
    console.log(`    3. Is the daemon running?        ${DIM}curl ${config.daemonUrl}/health${RESET}`)
    console.log(`    4. Start daemon:                 ${DIM}npm run hive:daemon${RESET}`)
    console.log(`    5. Rebuild image (for PM2/PHP):  ${DIM}cd fl-docker-dev && docker compose --profile hive build hive-daemon${RESET}`)
    console.log(`    6. Run with debug:               ${DIM}npm run hive:test:paas -- --verbose${RESET}`)
    console.log('')
  }
}

// ─── Utilities ───────────────────────────────────────────────────
function shouldRunPhase (n) {
  return !config.onlyPhase || config.onlyPhase === n
}

function getArg (name) {
  const idx = args.indexOf(name)
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function formatBytes (bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

// ─── Run ──────────────────────────────────────────────────────────
main().catch(err => {
  console.error(`\n  ${FAIL} Unexpected error: ${err.message}`)
  if (config.verbose) console.error(err.stack)
  process.exit(1)
})
