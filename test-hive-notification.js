#!/usr/bin/env node
/**
 * Test Hive notification dispatch — run locally first, then dispatch remotely.
 *
 * Usage:
 *   node test-hive-notification.js local          # Test notification on THIS machine
 *   node test-hive-notification.js remote <node>   # Send to a specific Hive node
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const os = require('os')

const IRIS_DIR = path.join(os.homedir(), '.iris')
const CONFIG_FILE = path.join(IRIS_DIR, 'config.json')

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error('No config at', CONFIG_FILE)
    process.exit(1)
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
}

function sendLocalNotification(title, subtitle, message) {
  const scpt = `display notification "${message}" with title "${title}" subtitle "${subtitle}"`
  const tmpFile = '/tmp/iris-hive-notify.scpt'
  fs.writeFileSync(tmpFile, scpt)
  try {
    execSync(`osascript ${tmpFile}`, { timeout: 5000, stdio: 'pipe' })
    console.log('Notification sent locally')
    return true
  } catch (err) {
    console.error('osascript failed:', err.stderr?.toString() || err.message)
    return false
  } finally {
    try { fs.unlinkSync(tmpFile) } catch {}
  }
}

async function dispatchRemoteNotification(nodeId, title, subtitle, message) {
  const config = loadConfig()
  const apiUrl = config.api_url || 'https://freelabel.net'
  const apiKey = config.node_api_key

  // The task prompt is a Node.js script that writes an osascript file and runs it
  const script = [
    'const fs = require("fs");',
    'const {execSync} = require("child_process");',
    `const scpt = 'display notification "${message}" with title "${title}" subtitle "${subtitle}"';`,
    'fs.writeFileSync("/tmp/iris-hive-notify.scpt", scpt);',
    'try { execSync("osascript /tmp/iris-hive-notify.scpt", {timeout:5000,stdio:"pipe"}); console.log("OK"); }',
    'catch(e) { console.error("FAIL:", e.stderr?.toString() || e.message); process.exit(1); }',
    'finally { try{fs.unlinkSync("/tmp/iris-hive-notify.scpt")}catch{} }',
  ].join('\n')

  console.log('Dispatching to node:', nodeId)
  console.log('Script:', script.substring(0, 100) + '...')

  const res = await fetch(`${apiUrl}/api/v6/nodes/tasks`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      user_id: config.user_id,
      title: 'hive-notification',
      type: 'hive_script',
      prompt: script,
      node_id: nodeId,
    }),
  })

  const data = await res.json()
  const task = data.task || data
  console.log('Task ID:', task.id)
  console.log('Status:', task.status)
  console.log('Node:', task.node?.name || 'unknown')

  if (task.id) {
    // Poll for result
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000))
      const check = await fetch(`${apiUrl}/api/v6/nodes/tasks?user_id=${config.user_id}&limit=1`, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
      })
      const checkData = await check.json()
      const t = (checkData.tasks || [])[0]
      if (t && t.id === task.id) {
        console.log(`  Poll ${i + 1}: ${t.status}${t.error ? ' — ' + t.error : ''}`)
        if (t.result?.output) console.log(`  Output: ${t.result.output.substring(0, 200)}`)
        if (t.status === 'completed' || t.status === 'failed') break
      }
    }
  }
}

// ── Main ──
const mode = process.argv[2] || 'local'

if (mode === 'local') {
  console.log('=== Testing notification locally ===')
  const ok = sendLocalNotification('IRIS Hive', 'Test', 'Hello from the Hive mesh!')
  process.exit(ok ? 0 : 1)
} else if (mode === 'remote') {
  const nodeId = process.argv[3]
  if (!nodeId) {
    console.error('Usage: node test-hive-notification.js remote <node-id>')
    process.exit(1)
  }
  console.log('=== Dispatching notification to remote node ===')
  dispatchRemoteNotification(nodeId, 'IRIS Hive', '2-node mesh is LIVE', 'Hello from the Hive mesh! Sent from your other MacBook.')
    .catch(err => { console.error(err); process.exit(1) })
} else {
  console.error('Usage: node test-hive-notification.js [local|remote <node-id>]')
  process.exit(1)
}
