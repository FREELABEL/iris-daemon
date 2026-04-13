#!/usr/bin/env node

/**
 * Browser Agent — entry point for Hive browser automation tasks.
 *
 * Usage:
 *   node browser-agent/index.js --task-file /path/to/.task.json --output-dir /path/to/.output
 *   node browser-agent/index.js --prompt "Go to example.com and get the page title"
 *   node browser-agent/index.js --prompt "Search Google for IRIS AI" --headed
 */

const { chromium } = require('playwright')
const { agentLoop } = require('./agent-loop')
const fs = require('fs')
const path = require('path')

// ── Parse CLI args ──────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2)
  const opts = {
    taskFile: null,
    outputDir: null,
    prompt: null,
    headed: false,
    url: null,
    maxSteps: 15,
    model: null,
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--task-file': opts.taskFile = args[++i]; break
      case '--output-dir': opts.outputDir = args[++i]; break
      case '--prompt': opts.prompt = args[++i]; break
      case '--headed': opts.headed = true; break
      case '--url': opts.url = args[++i]; break
      case '--max-steps': opts.maxSteps = parseInt(args[++i], 10); break
      case '--model': opts.model = args[++i]; break
    }
  }

  return opts
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs()

  // Load task from file or build from CLI args
  let task
  if (opts.taskFile && fs.existsSync(opts.taskFile)) {
    task = JSON.parse(fs.readFileSync(opts.taskFile, 'utf-8'))
  } else {
    task = {
      prompt: opts.prompt || 'Navigate to example.com and extract the page title',
      config: {},
    }
  }

  // CLI overrides
  if (opts.prompt) task.prompt = opts.prompt
  if (opts.model) task.config = { ...task.config, model: opts.model }
  if (opts.maxSteps) task.config = { ...task.config, max_steps: opts.maxSteps }

  const outputDir = opts.outputDir || process.env.OUTPUT_DIR || path.join(process.cwd(), '.output')
  fs.mkdirSync(outputDir, { recursive: true })

  console.log(`[browser-agent] Starting`)
  console.log(`[browser-agent] Task: ${task.prompt || task.title}`)
  console.log(`[browser-agent] Headed: ${opts.headed}`)
  console.log(`[browser-agent] Output: ${outputDir}`)

  // Launch browser
  const browser = await chromium.launch({
    headless: !opts.headed && !task.config?.headed,
    args: ['--disable-blink-features=AutomationControlled'],
  })

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  })

  // Load session cookies if provided
  const sessionFile = process.env.BROWSER_SESSION_FILE || task.config?.session_file
  if (sessionFile && fs.existsSync(sessionFile)) {
    try {
      const sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'))
      if (Array.isArray(sessionData.cookies)) {
        await context.addCookies(sessionData.cookies)
        console.log(`[browser-agent] Loaded ${sessionData.cookies.length} session cookies`)
      } else if (Array.isArray(sessionData)) {
        await context.addCookies(sessionData)
        console.log(`[browser-agent] Loaded ${sessionData.length} session cookies`)
      }
    } catch (e) {
      console.warn(`[browser-agent] Failed to load session: ${e.message}`)
    }
  }

  const page = await context.newPage()

  // Navigate to starting URL if provided
  const startUrl = opts.url || task.config?.start_url
  if (startUrl) {
    console.log(`[browser-agent] Navigating to: ${startUrl}`)
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })
  }

  // Run the agent loop
  const result = await agentLoop(page, task, {
    maxSteps: task.config?.max_steps || opts.maxSteps,
    model: task.config?.model || opts.model,
    outputDir,
  })

  // Save final screenshot
  try {
    await page.screenshot({ path: path.join(outputDir, 'final-state.png'), fullPage: false })
  } catch (e) {
    console.warn(`[browser-agent] Could not save final screenshot: ${e.message}`)
  }

  // Save result summary
  const summary = {
    success: result.success,
    result: result.result,
    error: result.error,
    steps: result.steps,
    history: result.history,
    url: page.url(),
    title: await page.title().catch(() => ''),
    timestamp: new Date().toISOString(),
  }
  fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify(summary, null, 2))

  // Output for daemon stdout capture
  console.log(`\n[browser-agent] ──────────────────────────────────`)
  console.log(`[browser-agent] ${result.success ? 'SUCCESS' : 'FAILED'}`)
  console.log(`[browser-agent] Steps: ${result.steps}`)
  if (result.result) console.log(`[browser-agent] Result: ${result.result}`)
  if (result.error) console.log(`[browser-agent] Error: ${result.error}`)
  console.log(`[browser-agent] History:`)
  for (const h of result.history || []) {
    console.log(`[browser-agent]   ${h}`)
  }
  console.log(`[browser-agent] ──────────────────────────────────`)

  // Cleanup
  await browser.close()

  process.exit(result.success ? 0 : 1)
}

main().catch(err => {
  console.error(`[browser-agent] Fatal: ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
