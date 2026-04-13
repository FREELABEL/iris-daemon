const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const http = require('http')
const { WorkspaceManager } = require('../daemon/workspace-manager')

// ─── Helpers ────────────────────────────────────────────────────

function httpPost (port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let chunks = ''
      res.on('data', d => { chunks += d })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }) }
        catch { resolve({ status: res.statusCode, body: chunks }) }
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

function httpGet (port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
      let chunks = ''
      res.on('data', d => { chunks += d })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }) }
        catch { resolve({ status: res.statusCode, body: chunks }) }
      })
    }).on('error', reject)
  })
}

// Minimal Express-like server that mounts just the execute-script + files routes
function createTestServer (dataDir) {
  const express = require('express')
  const { spawn } = require('child_process')
  const app = express()
  app.use(express.json())

  const prefix = ''

  // ─── execute-script (copied from daemon/index.js) ─────────────
  app.post(`${prefix}/execute-script`, (req, res) => {
    const { filename, content, args: scriptArgs, timeout_ms, persist } = req.body || {}

    if (!filename || !content) {
      return res.status(400).json({ error: 'filename and content required' })
    }

    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return res.status(400).json({ error: 'filename must be a plain name (no paths)' })
    }

    const baseDir = dataDir
    const scriptsDir = path.join(baseDir, 'scripts')
    if (!fs.existsSync(scriptsDir)) fs.mkdirSync(scriptsDir, { recursive: true })

    const scriptPath = path.join(scriptsDir, filename)
    fs.writeFileSync(scriptPath, content, 'utf-8')
    fs.chmodSync(scriptPath, '755')

    const ext = path.extname(filename).toLowerCase()
    const interpreters = { '.py': 'python3', '.js': 'node', '.ts': 'npx' }
    const cmd = interpreters[ext] || '/bin/bash'
    const spawnArgs = ext === '.ts' ? ['ts-node', scriptPath, ...(scriptArgs || [])] : [scriptPath, ...(scriptArgs || [])]

    const timeout = Math.min(Math.max(timeout_ms || 30000, 1000), 300000)

    const child = spawn(cmd, spawnArgs, {
      cwd: scriptsDir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let killed = false

    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })

    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL') }, timeout)

    child.on('close', (code) => {
      clearTimeout(timer)
      if (!persist && fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath)
      res.json({
        status: killed ? 'timeout' : (code === 0 ? 'completed' : 'failed'),
        exit_code: code,
        stdout: stdout.slice(-50000),
        stderr: stderr.slice(-10000),
        duration_ms: 0,
        script_path: persist ? '/scripts/' + filename : null,
        machine: 'test-node'
      })
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      if (!persist && fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath)
      res.status(500).json({ error: err.message })
    })
  })

  // ─── files browse (for verifying persist) ─────────────────────
  app.get(`${prefix}/files`, (req, res) => {
    const requestedPath = req.query.path || '/'
    const fullPath = path.resolve(dataDir, requestedPath.replace(/^\//, ''))
    if (!fullPath.startsWith(path.resolve(dataDir))) return res.status(403).json({ error: 'Access denied' })
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Not found' })
    const entries = fs.readdirSync(fullPath).map(name => {
      const fp = path.join(fullPath, name)
      const stat = fs.statSync(fp)
      return { name, type: stat.isDirectory() ? 'directory' : 'file', size: stat.size }
    })
    res.json({ path: requestedPath, entries })
  })

  return app
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe('execute-script endpoint', () => {
  let tmpDir, server, port

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-exec-test-'))
    const app = createTestServer(tmpDir)
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        port = server.address().port
        resolve()
      })
    })
  })

  afterEach(() => {
    server.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ─── Basic execution ──────────────────────────────────────────

  it('executes a bash script and returns stdout', async () => {
    const res = await httpPost(port, '/execute-script', {
      filename: 'hello.sh',
      content: '#!/bin/bash\necho "hello world"'
    })

    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'completed')
    assert.equal(res.body.exit_code, 0)
    assert.match(res.body.stdout, /hello world/)
    assert.equal(res.body.script_path, null, 'should not persist by default')
  })

  it('executes a python script with auto-detected interpreter', async () => {
    const res = await httpPost(port, '/execute-script', {
      filename: 'test.py',
      content: 'print("python works")'
    })

    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'completed')
    assert.match(res.body.stdout, /python works/)
  })

  it('executes a node script with auto-detected interpreter', async () => {
    const res = await httpPost(port, '/execute-script', {
      filename: 'test.js',
      content: 'console.log("node works")'
    })

    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'completed')
    assert.match(res.body.stdout, /node works/)
  })

  // ─── Arguments ────────────────────────────────────────────────

  it('passes arguments to the script', async () => {
    const res = await httpPost(port, '/execute-script', {
      filename: 'args.sh',
      content: '#!/bin/bash\necho "count=$#"\nfor a in "$@"; do echo "arg=$a"; done',
      args: ['--limit=50', '--dry-run']
    })

    assert.equal(res.body.status, 'completed')
    assert.match(res.body.stdout, /count=2/)
    assert.match(res.body.stdout, /arg=--limit=50/)
    assert.match(res.body.stdout, /arg=--dry-run/)
  })

  // ─── Persist flag ─────────────────────────────────────────────

  it('deletes script after execution when persist is false', async () => {
    await httpPost(port, '/execute-script', {
      filename: 'ephemeral.sh',
      content: '#!/bin/bash\necho "gone"',
      persist: false
    })

    const scriptPath = path.join(tmpDir, 'scripts', 'ephemeral.sh')
    assert.ok(!fs.existsSync(scriptPath), 'script should be deleted')
  })

  it('keeps script on disk when persist is true', async () => {
    const res = await httpPost(port, '/execute-script', {
      filename: 'keeper.sh',
      content: '#!/bin/bash\necho "still here"',
      persist: true
    })

    assert.equal(res.body.script_path, '/scripts/keeper.sh')

    const scriptPath = path.join(tmpDir, 'scripts', 'keeper.sh')
    assert.ok(fs.existsSync(scriptPath), 'script should be kept')

    // Verify via file browser endpoint
    const browse = await httpGet(port, '/files?path=/scripts')
    assert.equal(browse.status, 200)
    const names = browse.body.entries.map(e => e.name)
    assert.ok(names.includes('keeper.sh'))
  })

  // ─── Error handling ───────────────────────────────────────────

  it('returns failed status for non-zero exit code', async () => {
    const res = await httpPost(port, '/execute-script', {
      filename: 'fail.sh',
      content: '#!/bin/bash\necho "oops" >&2\nexit 1'
    })

    assert.equal(res.body.status, 'failed')
    assert.equal(res.body.exit_code, 1)
    assert.match(res.body.stderr, /oops/)
  })

  it('captures stderr output', async () => {
    const res = await httpPost(port, '/execute-script', {
      filename: 'stderr.sh',
      content: '#!/bin/bash\necho "stdout line"\necho "stderr line" >&2'
    })

    assert.match(res.body.stdout, /stdout line/)
    assert.match(res.body.stderr, /stderr line/)
  })

  // ─── Validation ───────────────────────────────────────────────

  it('rejects missing filename', async () => {
    const res = await httpPost(port, '/execute-script', {
      content: 'echo hi'
    })
    assert.equal(res.status, 400)
    assert.match(res.body.error, /filename.*content/)
  })

  it('rejects missing content', async () => {
    const res = await httpPost(port, '/execute-script', {
      filename: 'test.sh'
    })
    assert.equal(res.status, 400)
  })

  it('rejects path traversal in filename with ../', async () => {
    const res = await httpPost(port, '/execute-script', {
      filename: '../../etc/passwd',
      content: 'bad'
    })
    assert.equal(res.status, 400)
    assert.match(res.body.error, /plain name/)
  })

  it('rejects filename with forward slashes', async () => {
    const res = await httpPost(port, '/execute-script', {
      filename: 'scripts/evil.sh',
      content: 'bad'
    })
    assert.equal(res.status, 400)
    assert.match(res.body.error, /plain name/)
  })

  // ─── Timeout ──────────────────────────────────────────────────

  it('kills script that exceeds timeout', async () => {
    const res = await httpPost(port, '/execute-script', {
      filename: 'slow.sh',
      content: '#!/bin/bash\nsleep 30\necho "done"',
      timeout_ms: 1000
    })

    assert.equal(res.body.status, 'timeout')
    assert.ok(!res.body.stdout.includes('done'), 'should not have completed')
  })
})

// ═══════════════════════════════════════════════════════════════════
// execute_file task type (unit test via TaskExecutor)
// ═══════════════════════════════════════════════════════════════════

describe('execute_file task type', () => {
  let tmpDir, workspaces

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-execfile-test-'))
    workspaces = new WorkspaceManager(tmpDir)

    // Pre-create scripts in the data directory
    const scriptsDir = path.join(tmpDir, 'scripts')
    fs.mkdirSync(scriptsDir, { recursive: true })
    fs.writeFileSync(path.join(scriptsDir, 'hello.sh'), '#!/bin/bash\necho "execute_file works"', 'utf-8')
    fs.chmodSync(path.join(scriptsDir, 'hello.sh'), '755')

    fs.writeFileSync(path.join(scriptsDir, 'greet.py'), 'import sys\nprint(f"Hello {sys.argv[1]}")', 'utf-8')
    fs.writeFileSync(path.join(scriptsDir, 'add.js'), 'console.log("sum=" + (parseInt(process.argv[2]) + parseInt(process.argv[3])))', 'utf-8')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // Helper: create executor with a mock cloud that captures submitResult calls
  function createExecutor (wm) {
    const { TaskExecutor } = require('../daemon/task-executor')
    let lastResult = null
    const mockCloud = {
      reportProgress: () => {},
      submitProgress: () => {},
      submitResult: (taskId, result) => { lastResult = result },
      submitTask: () => {},
      fetchTaskCredentials: () => Promise.resolve(null)
    }
    const executor = new TaskExecutor(mockCloud, wm)
    return { executor, getResult: () => lastResult }
  }

  it('executes a bash script from filesystem', async () => {
    const { executor, getResult } = createExecutor(workspaces)

    await executor.execute({
      id: 'test-ef-001',
      type: 'execute_file',
      title: 'Test execute_file',
      config: { file_path: '/scripts/hello.sh' }
    })

    const result = getResult()
    assert.equal(result.status, 'completed')
    assert.ok(result.output.includes('execute_file works'), `Expected "execute_file works" in output, got: ${result.output}`)
  })

  it('passes args to script', async () => {
    const { executor, getResult } = createExecutor(workspaces)

    await executor.execute({
      id: 'test-ef-002',
      type: 'execute_file',
      title: 'Test args',
      config: { file_path: '/scripts/add.js', args: ['3', '7'] }
    })

    const result = getResult()
    assert.equal(result.status, 'completed')
    assert.ok(result.output.includes('sum=10'), `Expected sum=10, got: ${result.output}`)
  })

  it('auto-detects python interpreter for .py files', async () => {
    const { executor, getResult } = createExecutor(workspaces)

    await executor.execute({
      id: 'test-ef-003',
      type: 'execute_file',
      title: 'Test python',
      config: { file_path: '/scripts/greet.py', args: ['World'] }
    })

    const result = getResult()
    assert.equal(result.status, 'completed')
    assert.ok(result.output.includes('Hello World'), `Expected "Hello World", got: ${result.output}`)
  })

  it('reports failure for missing file_path config', async () => {
    const { executor, getResult } = createExecutor(workspaces)

    await executor.execute({
      id: 'test-ef-004',
      type: 'execute_file',
      title: 'No path',
      config: {}
    })

    const result = getResult()
    assert.equal(result.status, 'failed')
    assert.match(result.error, /file_path/)
  })

  it('reports failure for path traversal attempts', async () => {
    const { executor, getResult } = createExecutor(workspaces)

    await executor.execute({
      id: 'test-ef-005',
      type: 'execute_file',
      title: 'Traversal',
      config: { file_path: '/../../../etc/passwd' }
    })

    const result = getResult()
    assert.equal(result.status, 'failed')
    assert.match(result.error, /must be within data directory|not found/i)
  })

  it('reports failure for non-existent script', async () => {
    const { executor, getResult } = createExecutor(workspaces)

    await executor.execute({
      id: 'test-ef-006',
      type: 'execute_file',
      title: 'Missing',
      config: { file_path: '/scripts/nonexistent.sh' }
    })

    const result = getResult()
    assert.equal(result.status, 'failed')
    assert.match(result.error, /not found/i)
  })
})
