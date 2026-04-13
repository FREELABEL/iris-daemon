#!/usr/bin/env node
/**
 * Hive Integration Test
 *
 * Tests the full task dispatch pipeline:
 *   1. Check iris-api connectivity
 *   2. List compute nodes (verify at least one online)
 *   3. Dispatch a test task (echo command, no Playwright needed)
 *   4. Poll for task completion
 *   5. Verify result
 *
 * Usage:
 *   node test-hive-dispatch.js                          # Auto-detect iris-api URL
 *   node test-hive-dispatch.js --api-url http://...     # Custom iris-api URL
 *   node test-hive-dispatch.js --som-dry                # Test SOM dry run (needs daemon with Playwright)
 *   node test-hive-dispatch.js --user-id 1              # Specify user ID (default: 1)
 *
 * Prerequisites:
 *   - iris-api running (local Docker or production)
 *   - At least one compute node online (daemon running)
 */

const http = require('http')
const https = require('https')
const { URL } = require('url')

// ─── Config ────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const config = {
  apiUrl: getArg('--api-url') || process.env.IRIS_API_URL || 'https://local.iris.freelabel.net',
  userId: getArg('--user-id') || '1',
  somDry: args.includes('--som-dry'),
  verbose: args.includes('--verbose') || args.includes('-v'),
  timeout: 60000 // 60s max wait for task completion
}

const PASS = '\x1b[32m\u2714\x1b[0m'
const FAIL = '\x1b[31m\u2718\x1b[0m'
const INFO = '\x1b[36m\u2192\x1b[0m'
const WARN = '\x1b[33m!\x1b[0m'

// ─── Main ──────────────────────────────────────────────────────────
async function main () {
  console.log('')
  console.log('  \x1b[1mHive Integration Test\x1b[0m')
  console.log('  ═══════════════════════════════')
  console.log(`  ${INFO} API: ${config.apiUrl}`)
  console.log(`  ${INFO} User: ${config.userId}`)
  console.log(`  ${INFO} Mode: ${config.somDry ? 'SOM dry run' : 'Echo task'}`)
  console.log('')

  const results = { passed: 0, failed: 0, skipped: 0, tests: [] }
  const start = Date.now()

  // Test 1: iris-api connectivity
  await runTest(results, 'iris-api connectivity', async () => {
    const res = await apiGet('/api/v6/nodes', { user_id: config.userId })
    if (!res || typeof res !== 'object') throw new Error('Invalid response from iris-api')
    return `${(res.nodes || []).length} nodes found`
  })

  // Test 2: Online nodes
  let onlineNodes = []
  await runTest(results, 'Online compute nodes', async () => {
    const res = await apiGet('/api/v6/nodes', { user_id: config.userId })
    const nodes = res.nodes || []
    onlineNodes = nodes.filter(n => n.connection_status === 'online')

    if (onlineNodes.length === 0) {
      const offlineCount = nodes.length - onlineNodes.length
      throw new Error(`No online nodes (${offlineCount} offline). Start daemon: npm run hive:daemon`)
    }

    return `${onlineNodes.length} online: ${onlineNodes.map(n => n.name).join(', ')}`
  })

  if (onlineNodes.length === 0) {
    console.log(`  ${WARN} Skipping dispatch tests — no online nodes`)
    results.skipped += 3
    printSummary(results, Date.now() - start)
    process.exit(1)
  }

  // Test 3: Create task
  let taskId = null
  const targetNode = onlineNodes[0]

  await runTest(results, 'Dispatch test task', async () => {
    const taskPayload = config.somDry
      ? {
          title: '[TEST] SOM Dry Run',
          type: 'som',
          prompt: 'creators limit=1 dry=1',
          node_id: targetNode.id,
          user_id: config.userId,
          config: { timeout_seconds: 120 }
        }
      : {
          title: '[TEST] Echo Health Check',
          type: 'custom',
          prompt: 'echo "HIVE_TEST_OK: $(date +%s)" && sleep 2 && echo "done"',
          node_id: targetNode.id,
          user_id: config.userId,
          config: { timeout_seconds: 30 }
        }

    const res = await apiPost('/api/v6/nodes/tasks', taskPayload)

    if (!res.task || !res.task.id) {
      throw new Error(`Task creation failed: ${JSON.stringify(res)}`)
    }

    taskId = res.task.id
    return `Task ${taskId} created → status: ${res.task.status}`
  })

  if (!taskId) {
    console.log(`  ${WARN} Skipping completion tests — task creation failed`)
    results.skipped += 2
    printSummary(results, Date.now() - start)
    process.exit(1)
  }

  // Test 4: Task gets picked up (transitions from pending/assigned to running)
  await runTest(results, 'Task accepted by daemon', async () => {
    const deadline = Date.now() + 15000 // 15s to get picked up
    let task = null

    while (Date.now() < deadline) {
      const res = await apiGet(`/api/v6/nodes/tasks/${taskId}`, { user_id: config.userId })
      task = res.task || res

      if (['running', 'completed', 'failed'].includes(task.status)) {
        return `Status: ${task.status} (node: ${targetNode.name})`
      }

      if (config.verbose) {
        process.stdout.write(`  ${INFO} Polling... status=${task.status}\r`)
      }

      await sleep(2000)
    }

    throw new Error(`Task stuck at "${task?.status}" after 15s. Daemon may not be receiving Pusher events.`)
  })

  // Test 5: Task completes
  await runTest(results, 'Task execution completes', async () => {
    const deadline = Date.now() + config.timeout
    let task = null

    while (Date.now() < deadline) {
      const res = await apiGet(`/api/v6/nodes/tasks/${taskId}`, { user_id: config.userId })
      task = res.task || res

      if (task.status === 'completed') {
        const output = task.result?.output || ''
        const preview = output.substring(0, 100).replace(/\n/g, ' ')
        return `Completed in ${task.duration || '?'}s — output: ${preview || '(empty)'}`
      }

      if (task.status === 'failed') {
        const error = task.result?.error || task.error || 'Unknown error'
        throw new Error(`Task failed: ${error}`)
      }

      if (config.verbose) {
        process.stdout.write(`  ${INFO} Progress: ${task.progress || 0}% — ${task.progress_message || 'running...'}\r`)
      }

      await sleep(3000)
    }

    throw new Error(`Task timed out after ${config.timeout / 1000}s (status: ${task?.status})`)
  })

  printSummary(results, Date.now() - start)
  process.exit(results.failed > 0 ? 1 : 0)
}

// ─── Test Runner ───────────────────────────────────────────────────
async function runTest (results, name, fn) {
  try {
    const detail = await fn()
    console.log(`  ${PASS} ${name}`)
    if (detail) console.log(`    ${detail}`)
    results.passed++
    results.tests.push({ name, status: 'pass', detail })
  } catch (err) {
    console.log(`  ${FAIL} ${name}`)
    console.log(`    \x1b[31m${err.message}\x1b[0m`)
    results.failed++
    results.tests.push({ name, status: 'fail', error: err.message })
  }
}

function printSummary (results, elapsed) {
  console.log('')
  console.log('  ───────────────────────────────')
  const status = results.failed === 0 ? '\x1b[32mALL PASSED\x1b[0m' : '\x1b[31mFAILED\x1b[0m'
  console.log(`  ${status} — ${results.passed} passed, ${results.failed} failed, ${results.skipped} skipped (${(elapsed / 1000).toFixed(1)}s)`)
  console.log('')
}

// ─── HTTP Helpers ──────────────────────────────────────────────────
function apiGet (path, params = {}) {
  const qs = new URLSearchParams(params).toString()
  const fullPath = qs ? `${path}?${qs}` : path
  return request('GET', fullPath)
}

function apiPost (path, body) {
  return request('POST', path, body)
}

function request (method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, config.apiUrl)
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
        'User-Agent': 'Hive-Integration-Test/1.0'
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
      reject(new Error('Request timeout'))
    })

    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

// ─── Helpers ───────────────────────────────────────────────────────
function getArg (name) {
  const idx = args.indexOf(name)
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

main().catch(err => {
  console.error(`\n  ${FAIL} Unexpected error: ${err.message}`)
  process.exit(1)
})
