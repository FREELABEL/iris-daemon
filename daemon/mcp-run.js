#!/usr/bin/env node
'use strict'

/**
 * Run one MCP request and print the result as JSON. Invoked by the `mcp_call` task type as
 *
 *   node daemon/mcp-run.js <request-file.json>
 *
 * A REAL FILE, SPAWNED LIKE EVERY OTHER TASK, on purpose. task-executor.js is 4,000 lines
 * because capabilities kept buying themselves a bespoke completion path, and a branch that
 * finishes differently from the others is a branch nobody tests. This one sets cmd/args and
 * falls through the same output capture, timeout and reporting as everything else.
 *
 * The request never carries a command — only a server NAME, resolved against this node's own
 * allowlist. See daemon/mcp-registry.js.
 *
 * Request:  { "server": "argent", "tool": "list-devices", "arguments": {...},
 *             "timeout_ms": 120000, "cwd": "/path" }
 *           `tool` omitted  ->  tools/list (discovery)
 */

const fs = require('fs')
const { resolveServer } = require('./mcp-registry')
const { listTools, callTool } = require('./mcp-client')

function die (message) {
  // Structured on stdout so the caller gets the reason, non-zero so the task is a failure.
  // A silent exit(1) here would surface as "the task failed" with nothing to act on.
  process.stdout.write(JSON.stringify({ ok: false, error: message }, null, 2) + '\n')
  process.exit(1)
}

async function main () {
  const file = process.argv[2]
  if (!file) die('usage: mcp-run.js <request-file.json>')

  let req
  try {
    req = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch (e) {
    die(`could not read request: ${e.message}`)
  }

  const resolved = resolveServer(req.server)
  if (!resolved.ok) die(resolved.reason)

  const opts = { timeoutMs: req.timeout_ms, cwd: req.cwd }
  const res = req.tool
    ? await callTool(resolved.server, req.tool, req.arguments, opts)
    : await listTools(resolved.server, opts)

  if (!res.ok) {
    die(res.stderr ? `${res.error}\n--- server stderr ---\n${res.stderr}` : res.error)
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    server: resolved.name,
    tool: req.tool || null,
    result: res.result
  }, null, 2) + '\n')
}

main().catch((e) => die(`mcp-run crashed: ${(e && e.message) || e}`))
