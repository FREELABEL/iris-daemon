/**
 * TmuxManager — Invisible tmux orchestration layer for Hive tasks.
 *
 * Every spawned task runs inside a tmux session (tmux -L iris) for:
 *   - Session persistence (survives terminal close)
 *   - Multi-pane swarms (one pane per agent role)
 *   - Output scrollback (capture-pane for debugging)
 *   - Inter-agent IPC (send-keys between panes)
 *
 * The user never interacts with tmux directly. They use:
 *   - iris hive tasks / iris hive panes (CLI)
 *   - TUI sidebar (visual)
 *   - MCP tools (hive_swarm, hive_panes, hive_send_input)
 *
 * Power users CAN attach via: tmux -L iris attach -t <session>
 */

const { execSync, execFileSync, spawn: nodeSpawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const SOCKET = 'iris'
const LOG_DIR = path.join(os.homedir(), '.iris', 'tmux-logs')
const EXIT_DIR = path.join(os.homedir(), '.iris', 'tmux-exit')
const LEDGER_FILE = path.join(os.homedir(), '.iris', 'tmux-ledger.jsonl')
const MIN_VERSION = 3.0
const MAX_LOG_SIZE = 50 * 1024 * 1024 // 50MB
const ZOMBIE_AGE_MS = 2 * 60 * 60 * 1000 // 2 hours
const MAX_LEDGER_LINES = 500

class TmuxManager {
  constructor () {
    this.sessions = new Map() // sessionName -> { taskId, type, source, userId, outputFile, created }
    this._verified = false
    this.available = false
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.mkdirSync(EXIT_DIR, { recursive: true })
  }

  // ── Verification ──────────────────────────────────────────────────────────

  /**
   * Check tmux is installed and >= 3.0. Called once during Daemon.start().
   * Throws if missing (unless IRIS_NO_TMUX=1 for CI).
   */
  verify () {
    if (this._verified) return this.available

    if (process.env.IRIS_NO_TMUX === '1') {
      console.log('[tmux] IRIS_NO_TMUX=1 — tmux disabled (CI mode)')
      this.available = false
      this._verified = true
      return false
    }

    try {
      const versionOutput = execSync('tmux -V', { timeout: 5000, stdio: 'pipe' }).toString().trim()
      const match = versionOutput.match(/(\d+\.\d+)/)
      if (!match) {
        throw new Error(`Could not parse tmux version from: ${versionOutput}`)
      }
      const version = parseFloat(match[1])
      if (version < MIN_VERSION) {
        throw new Error(`tmux ${version} found but >= ${MIN_VERSION} required. Run: brew install tmux (macOS) or sudo apt install tmux (Linux)`)
      }
      console.log(`[tmux] Verified: ${versionOutput} (socket: ${SOCKET})`)
      this.available = true
      this._verified = true
      return true
    } catch (err) {
      if (err.message && err.message.includes('tmux')) {
        throw err // re-throw our own version error
      }
      throw new Error('tmux not found. Install with: brew install tmux (macOS) or sudo apt install tmux (Linux)')
    }
  }

  // ── Session helpers ───────────────────────────────────────────────────────

  /**
   * Generate a safe session name from task metadata.
   * Format: iris-{type}-{first 8 chars of taskId}
   */
  _sessionName (task) {
    const type = (task.type || 'task').replace(/[^a-zA-Z0-9_-]/g, '')
    const shortId = (task.id || '').substring(0, 8).replace(/[^a-zA-Z0-9]/g, '')
    return `iris-${type}-${shortId}`
  }

  /**
   * Run a tmux command synchronously. Returns stdout string.
   * All commands use -L iris for socket isolation.
   * Uses execFileSync (no shell) to avoid argument escaping issues.
   */
  _exec (args, opts = {}) {
    return execFileSync('tmux', ['-L', SOCKET, ...args], {
      timeout: opts.timeout || 10000,
      stdio: 'pipe',
      ...opts
    }).toString().trim()
  }

  /**
   * Run a tmux command, return null on error instead of throwing.
   */
  _execSafe (args, opts = {}) {
    try {
      return this._exec(args, opts)
    } catch {
      return null
    }
  }

  // ── Single-task sessions ──────────────────────────────────────────────────

  /**
   * Create a tmux session for a single task.
   *
   * The command runs inside the tmux pane. Output is piped to a log file
   * via pipe-pane so the daemon can stream progress to the cloud.
   *
   * Exit detection uses tmux wait-for: the command is wrapped in a bash
   * script that writes exit code to a file, then signals the channel.
   *
   * @param {object} task - Task object with id, type, prompt, config
   * @param {string} cmd - Command to run
   * @param {string[]} args - Arguments
   * @param {object} env - Environment variables
   * @param {string} cwd - Working directory
   * @returns {{ sessionName: string, outputFile: string, exitFile: string, channel: string }}
   */
  createForTask (task, cmd, args, env, cwd) {
    if (!this.available) {
      throw new Error('tmux not available — call verify() first')
    }

    const sessionName = this._sessionName(task)
    const outputFile = path.join(LOG_DIR, `${sessionName}.log`)
    const exitFile = path.join(EXIT_DIR, `${sessionName}.exit`)
    const channel = `${sessionName}-done`

    // Clean up any stale session with same name
    this._execSafe(['kill-session', '-t', sessionName])

    // Clean up stale files
    try { fs.unlinkSync(outputFile) } catch {}
    try { fs.unlinkSync(exitFile) } catch {}

    // Touch the output file so watchers can start immediately
    fs.writeFileSync(outputFile, '')

    // Build the full command string for tmux
    // Wrap in bash to capture exit code + signal wait-for channel
    const fullCmd = this._buildWrappedCommand(cmd, args, exitFile, channel)

    // Build env string for tmux (export key=value pairs)
    const envPairs = Object.entries(env || {})
      .filter(([k, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${this._shellEscape(String(v))}`)
      .join(' ')

    // Create detached session
    const newSessionArgs = [
      'new-session', '-d',
      '-s', sessionName,
      '-c', cwd || process.cwd(),
      '-x', '200', '-y', '50' // generous pane size for output
    ]
    this._exec(newSessionArgs)

    // Set environment variables in the session
    if (envPairs) {
      // Use tmux set-environment for each var (safer than inline export)
      for (const [k, v] of Object.entries(env || {})) {
        if (v !== undefined && v !== null) {
          this._execSafe(['set-environment', '-t', sessionName, k, String(v)])
        }
      }
    }

    // Set up pipe-pane to stream output to log file
    this._exec(['pipe-pane', '-t', sessionName, '-o', `cat >> ${this._shellEscape(outputFile)}`])

    // Send the wrapped command to the pane
    this._exec(['send-keys', '-t', sessionName, fullCmd, 'Enter'])

    // Track session (in-memory + persistent ledger)
    const source = task._source || 'unknown'
    const userId = task.user_id || task._userId || null
    const record = {
      sessionName,
      taskId: task.id,
      type: task.type,
      source,
      userId,
      title: task.title || null,
      outputFile,
      exitFile,
      channel,
      created: Date.now(),
      status: 'running'
    }
    this.sessions.set(sessionName, record)
    this._appendLedger(record)

    console.log(`[tmux] Created session: ${sessionName} [${source}] (${cmd} ${(args || []).slice(0, 2).join(' ')}...)`)
    return { sessionName, outputFile, exitFile, channel }
  }

  /**
   * Build a bash wrapper that runs the command, captures exit code,
   * and signals the tmux wait-for channel.
   */
  _buildWrappedCommand (cmd, args, exitFile, channel) {
    const escapedCmd = this._shellEscape(cmd)
    const escapedArgs = (args || []).map(a => this._shellEscape(a)).join(' ')
    const escapedExitFile = this._shellEscape(exitFile)

    // The wrapper:
    // 1. Runs the command
    // 2. Captures $? to exit file
    // 3. Signals the wait-for channel
    // 4. Exits the pane (which kills the session if it's the only pane)
    return `${escapedCmd} ${escapedArgs}; echo $? > ${escapedExitFile}; tmux -L ${SOCKET} wait-for -S ${channel}; exit`
  }

  /**
   * Wait for a task to complete. Returns a promise that resolves
   * when the tmux wait-for channel is signaled.
   *
   * @param {string} channel - The wait-for channel name
   * @param {number} timeoutMs - Max time to wait
   * @returns {Promise<number>} Exit code from the exit file
   */
  waitForCompletion (channel, exitFile, timeoutMs = 600000) {
    return new Promise((resolve, reject) => {
      const waiter = nodeSpawn('tmux', ['-L', SOCKET, 'wait-for', channel], {
        stdio: 'ignore',
        timeout: timeoutMs
      })

      const timer = setTimeout(() => {
        waiter.kill('SIGTERM')
        reject(new Error(`tmux wait-for timed out after ${timeoutMs / 1000}s`))
      }, timeoutMs)

      waiter.on('close', () => {
        clearTimeout(timer)
        // Read exit code from file
        try {
          const code = parseInt(fs.readFileSync(exitFile, 'utf-8').trim(), 10)
          resolve(isNaN(code) ? 1 : code)
        } catch {
          // Exit file missing — session may have been killed
          resolve(1)
        }
      })

      waiter.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  // ── Swarm sessions (multi-pane) ───────────────────────────────────────────

  /**
   * Create a multi-pane swarm session. Each role gets its own pane.
   *
   * @param {string} taskId - Parent task ID
   * @param {Array<{name: string, cmd: string, args: string[], env: object, cwd: string}>} roles
   * @returns {{ sessionName: string, panes: Array<{index: number, role: string, exitFile: string, channel: string}> }}
   */
  createSwarm (taskId, roles) {
    if (!this.available) {
      throw new Error('tmux not available — call verify() first')
    }

    if (!roles || roles.length === 0) {
      throw new Error('Swarm requires at least one role')
    }

    const shortId = (taskId || '').substring(0, 8).replace(/[^a-zA-Z0-9]/g, '')
    const sessionName = `iris-swarm-${shortId}`
    const outputFile = path.join(LOG_DIR, `${sessionName}.log`)

    // Clean up stale
    this._execSafe(['kill-session', '-t', sessionName])
    try { fs.unlinkSync(outputFile) } catch {}
    fs.writeFileSync(outputFile, '')

    const panes = []

    // Create session with first role
    const firstRole = roles[0]
    const firstExitFile = path.join(EXIT_DIR, `${sessionName}-0.exit`)
    const firstChannel = `${sessionName}-0-done`
    try { fs.unlinkSync(firstExitFile) } catch {}

    this._exec([
      'new-session', '-d',
      '-s', sessionName,
      '-c', firstRole.cwd || process.cwd(),
      '-x', '200', '-y', '50'
    ])

    // Set env for first pane
    for (const [k, v] of Object.entries(firstRole.env || {})) {
      if (v !== undefined && v !== null) {
        this._execSafe(['set-environment', '-t', sessionName, k, String(v)])
      }
    }

    // Pipe pane 0 output to shared log + per-pane log
    const pane0Log = path.join(LOG_DIR, `${sessionName}-0.log`)
    try { fs.unlinkSync(pane0Log) } catch {}
    fs.writeFileSync(pane0Log, '')
    this._exec(['pipe-pane', '-t', `${sessionName}:0.0`, '-o', `cat >> ${this._shellEscape(pane0Log)}`])
    // Also pipe to the shared log
    this._execSafe(['pipe-pane', '-t', sessionName, '-o', `cat >> ${this._shellEscape(outputFile)}`])

    // Send first role command
    const firstCmd = this._buildWrappedCommand(firstRole.cmd, firstRole.args, firstExitFile, firstChannel)
    this._exec(['send-keys', '-t', `${sessionName}:0.0`, firstCmd, 'Enter'])
    panes.push({ index: 0, role: firstRole.name, exitFile: firstExitFile, channel: firstChannel, logFile: pane0Log })

    // Split panes for remaining roles
    for (let i = 1; i < roles.length; i++) {
      const role = roles[i]
      const exitFile = path.join(EXIT_DIR, `${sessionName}-${i}.exit`)
      const channel = `${sessionName}-${i}-done`
      const paneLog = path.join(LOG_DIR, `${sessionName}-${i}.log`)
      try { fs.unlinkSync(exitFile) } catch {}
      try { fs.unlinkSync(paneLog) } catch {}
      fs.writeFileSync(paneLog, '')

      // Split horizontally (stacked)
      this._exec(['split-window', '-t', sessionName, '-c', role.cwd || process.cwd()])

      // Pipe this pane's output to its own log
      this._execSafe(['pipe-pane', '-t', `${sessionName}:0.${i}`, '-o', `cat >> ${this._shellEscape(paneLog)}`])

      // Set env for this pane
      for (const [k, v] of Object.entries(role.env || {})) {
        if (v !== undefined && v !== null) {
          this._execSafe(['set-environment', '-t', sessionName, k, String(v)])
        }
      }

      // Send command
      const roleCmd = this._buildWrappedCommand(role.cmd, role.args, exitFile, channel)
      this._exec(['send-keys', '-t', `${sessionName}:0.${i}`, roleCmd, 'Enter'])
      panes.push({ index: i, role: role.name, exitFile, channel, logFile: paneLog })
    }

    // Auto-layout: tile all panes evenly
    this._execSafe(['select-layout', '-t', sessionName, 'tiled'])

    // Track (swarms are always CLI-dispatched for now)
    const record = {
      sessionName,
      taskId,
      type: 'swarm',
      source: 'cli',
      userId: null,
      title: `Swarm: ${roles.map(r => r.name).join(', ')}`,
      outputFile,
      panes: panes.map(p => ({ index: p.index, role: p.role })),
      created: Date.now(),
      status: 'running'
    }
    this.sessions.set(sessionName, record)
    this._appendLedger(record)

    console.log(`[tmux] Created swarm: ${sessionName} [cli] (${roles.length} panes: ${roles.map(r => r.name).join(', ')})`)
    return { sessionName, outputFile, panes }
  }

  /**
   * Wait for all panes in a swarm to complete.
   * @returns {Promise<{exitCodes: number[]}>}
   */
  async waitForSwarm (panes, timeoutMs = 3600000) {
    const results = await Promise.allSettled(
      panes.map(p => this.waitForCompletion(p.channel, p.exitFile, timeoutMs))
    )
    return {
      exitCodes: results.map(r => r.status === 'fulfilled' ? r.value : 1)
    }
  }

  // ── Output capture ────────────────────────────────────────────────────────

  /**
   * Capture recent output from a pane's scrollback buffer.
   * @param {string} sessionName
   * @param {number} paneIndex - 0-based pane index (default: 0)
   * @param {number} lines - Number of lines to capture (default: 50)
   * @returns {string|null}
   */
  captureOutput (sessionName, paneIndex = 0, lines = 50) {
    return this._execSafe([
      'capture-pane', '-p',
      '-t', `${sessionName}:0.${paneIndex}`,
      '-S', `-${lines}`
    ])
  }

  /**
   * Read output from the pipe-pane log file.
   * @param {string} sessionName
   * @param {number} lines - Number of lines from the end (default: 100)
   * @returns {string}
   */
  readOutput (sessionName, lines = 100) {
    const info = this.sessions.get(sessionName)
    const logFile = info?.outputFile || path.join(LOG_DIR, `${sessionName}.log`)
    try {
      if (!fs.existsSync(logFile)) return ''
      const content = fs.readFileSync(logFile, 'utf-8')
      const allLines = content.split('\n')
      return allLines.slice(-lines).join('\n')
    } catch {
      return ''
    }
  }

  /**
   * Get new lines from the log file since last read.
   * Used by task-executor for streaming progress.
   * @param {string} logFile - Path to pipe-pane log
   * @param {number} lastLineCount - Lines already read
   * @returns {{ lines: string[], total: number }}
   */
  readNewLines (logFile, lastLineCount = 0) {
    try {
      if (!fs.existsSync(logFile)) return { lines: [], total: 0 }
      const content = fs.readFileSync(logFile, 'utf-8')
      const allLines = content.split('\n').filter(Boolean)
      const newLines = allLines.slice(lastLineCount)
      return { lines: newLines, total: allLines.length }
    } catch {
      return { lines: [], total: lastLineCount }
    }
  }

  // ── Session lifecycle ─────────────────────────────────────────────────────

  /**
   * Check if a session is still alive.
   */
  isAlive (sessionName) {
    const result = this._execSafe(['has-session', '-t', sessionName])
    return result !== null // has-session returns 0 if exists, 1 if not
  }

  /**
   * Kill a session and clean up log/exit files.
   * @param {string} sessionName
   * @param {object} [completion] - Optional { exitCode, durationMs } for ledger
   */
  cleanup (sessionName, completion) {
    // Record completion in ledger before deleting
    if (completion) {
      this.recordCompletion(sessionName, completion.exitCode, completion.durationMs)
    }

    this._execSafe(['kill-session', '-t', sessionName])

    // Clean log file
    const info = this.sessions.get(sessionName)
    if (info?.outputFile) {
      try { fs.unlinkSync(info.outputFile) } catch {}
    }

    // Clean exit files
    try {
      const exitFiles = fs.readdirSync(EXIT_DIR).filter(f => f.startsWith(sessionName))
      for (const f of exitFiles) {
        try { fs.unlinkSync(path.join(EXIT_DIR, f)) } catch {}
      }
    } catch {}

    this.sessions.delete(sessionName)
    console.log(`[tmux] Cleaned up session: ${sessionName}`)
  }

  /**
   * Kill all iris-* tmux sessions. Called on daemon shutdown and startup.
   */
  cleanupAll () {
    if (!this.available) return

    const sessions = this.listActive()
    for (const s of sessions) {
      this._execSafe(['kill-session', '-t', s.name])
    }
    this.sessions.clear()

    // Clean all log and exit files
    try {
      for (const f of fs.readdirSync(LOG_DIR)) {
        if (f.startsWith('iris-')) {
          try { fs.unlinkSync(path.join(LOG_DIR, f)) } catch {}
        }
      }
    } catch {}
    try {
      for (const f of fs.readdirSync(EXIT_DIR)) {
        if (f.startsWith('iris-')) {
          try { fs.unlinkSync(path.join(EXIT_DIR, f)) } catch {}
        }
      }
    } catch {}

    if (sessions.length > 0) {
      console.log(`[tmux] Cleaned up ${sessions.length} stale sessions`)
    }
  }

  /**
   * Send text input to a specific pane (for agent-to-agent IPC).
   */
  sendInput (sessionName, paneIndex, text) {
    this._exec(['send-keys', '-t', `${sessionName}:0.${paneIndex}`, text, 'Enter'])
  }

  // ── Listing & querying ────────────────────────────────────────────────────

  /**
   * List all active iris-* tmux sessions with pane info.
   * @returns {Array<{name: string, created: string, attached: boolean, panes: Array}>}
   */
  listActive () {
    if (!this.available) return []

    const raw = this._execSafe([
      'list-sessions',
      '-F', '#{session_name}|#{session_created}|#{session_attached}|#{session_windows}'
    ])

    if (!raw) return []

    const sessions = []
    for (const line of raw.split('\n')) {
      const [name, created, attached, windows] = line.split('|')
      if (!name || !name.startsWith('iris-')) continue

      // Get pane info for this session
      const panesRaw = this._execSafe([
        'list-panes', '-t', name,
        '-F', '#{pane_index}|#{pane_pid}|#{pane_current_command}|#{pane_active}'
      ])

      const panes = []
      if (panesRaw) {
        for (const paneLine of panesRaw.split('\n')) {
          const [idx, pid, cmd, active] = paneLine.split('|')
          // Look up role from our tracking
          const tracked = this.sessions.get(name)
          const roleInfo = tracked?.panes?.find(p => p.index === parseInt(idx))

          panes.push({
            index: parseInt(idx) || 0,
            pid: parseInt(pid) || 0,
            command: cmd || '',
            active: active === '1',
            role: roleInfo?.role || null
          })
        }
      }

      const tracked = this.sessions.get(name)
      sessions.push({
        name,
        created: created || '',
        attached: attached === '1',
        windows: parseInt(windows) || 1,
        panes,
        // Merge with our tracked metadata
        taskId: tracked?.taskId || null,
        type: tracked?.type || null,
        source: tracked?.source || null,
        userId: tracked?.userId || null,
        title: tracked?.title || null
      })
    }

    return sessions
  }

  /**
   * Get detailed info for a specific session.
   */
  getSession (sessionName) {
    const sessions = this.listActive()
    return sessions.find(s => s.name === sessionName) || null
  }

  // ── Zombie cleanup ────────────────────────────────────────────────────────

  /**
   * Kill iris-* sessions older than ZOMBIE_AGE_MS with no running processes.
   * Called periodically (every 10 min) by the daemon.
   */
  cleanupZombies () {
    if (!this.available) return 0

    const sessions = this.listActive()
    let cleaned = 0

    for (const s of sessions) {
      const tracked = this.sessions.get(s.name)
      const age = tracked ? Date.now() - tracked.created : Infinity

      if (age > ZOMBIE_AGE_MS) {
        // Check if any pane has a running process (not just bash)
        const hasRunning = s.panes.some(p => p.command && p.command !== 'bash' && p.command !== 'zsh')
        if (!hasRunning) {
          this.cleanup(s.name)
          cleaned++
        }
      }
    }

    if (cleaned > 0) {
      console.log(`[tmux] Zombie cleanup: removed ${cleaned} stale sessions`)
    }
    return cleaned
  }

  // ── Log rotation ──────────────────────────────────────────────────────────

  /**
   * Truncate log files that exceed MAX_LOG_SIZE.
   */
  rotateLogs () {
    try {
      const files = fs.readdirSync(LOG_DIR)
      for (const f of files) {
        const fp = path.join(LOG_DIR, f)
        try {
          const stat = fs.statSync(fp)
          if (stat.size > MAX_LOG_SIZE) {
            // Keep last 10MB
            const content = fs.readFileSync(fp, 'utf-8')
            const truncated = content.slice(-10 * 1024 * 1024)
            fs.writeFileSync(fp, truncated)
            console.log(`[tmux] Rotated log: ${f} (${(stat.size / 1024 / 1024).toFixed(1)}MB → ${(truncated.length / 1024 / 1024).toFixed(1)}MB)`)
          }
        } catch {}
      }
    } catch {}
  }

  // ── Session ledger (persistent JSONL audit trail) ────────────────────────

  /**
   * Append a session record to the persistent ledger.
   * Format: one JSON object per line (JSONL). Keeps last MAX_LEDGER_LINES entries.
   */
  _appendLedger (record) {
    try {
      const entry = {
        sessionName: record.sessionName,
        taskId: record.taskId,
        type: record.type,
        source: record.source || 'unknown',
        userId: record.userId || null,
        title: record.title || null,
        status: record.status || 'running',
        created: record.created,
        completed: record.completed || null,
        exitCode: record.exitCode ?? null,
        durationMs: record.durationMs || null
      }
      fs.appendFileSync(LEDGER_FILE, JSON.stringify(entry) + '\n')
    } catch { /* non-critical */ }
  }

  /**
   * Mark a session as completed in the ledger (append a completion entry).
   */
  recordCompletion (sessionName, exitCode, durationMs) {
    const tracked = this.sessions.get(sessionName)
    if (!tracked) return
    this._appendLedger({
      ...tracked,
      status: exitCode === 0 ? 'completed' : 'failed',
      completed: Date.now(),
      exitCode,
      durationMs
    })
  }

  /**
   * Read the session ledger. Returns most recent entries first.
   * @param {number} limit - Max entries to return (default: 50)
   * @param {object} filters - Optional filters { source, type, status }
   * @returns {Array<object>}
   */
  readLedger (limit = 50, filters = {}) {
    try {
      if (!fs.existsSync(LEDGER_FILE)) return []
      const lines = fs.readFileSync(LEDGER_FILE, 'utf-8').split('\n').filter(Boolean)
      let entries = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

      // Apply filters
      if (filters.source) entries = entries.filter(e => e.source === filters.source)
      if (filters.type) entries = entries.filter(e => e.type === filters.type)
      if (filters.status) entries = entries.filter(e => e.status === filters.status)

      // Most recent first, limited
      return entries.reverse().slice(0, limit)
    } catch {
      return []
    }
  }

  /**
   * Rotate ledger to keep only last MAX_LEDGER_LINES entries.
   */
  _rotateLedger () {
    try {
      if (!fs.existsSync(LEDGER_FILE)) return
      const lines = fs.readFileSync(LEDGER_FILE, 'utf-8').split('\n').filter(Boolean)
      if (lines.length > MAX_LEDGER_LINES) {
        const trimmed = lines.slice(-MAX_LEDGER_LINES)
        fs.writeFileSync(LEDGER_FILE, trimmed.join('\n') + '\n')
      }
    } catch {}
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  /**
   * Escape a string for safe use in tmux send-keys / shell.
   */
  _shellEscape (str) {
    if (!str) return "''"
    // If it's simple (no special chars), return as-is
    if (/^[a-zA-Z0-9_./:@=-]+$/.test(str)) return str
    // Otherwise single-quote it, escaping existing single quotes
    return "'" + str.replace(/'/g, "'\\''") + "'"
  }
}

module.exports = { TmuxManager }
