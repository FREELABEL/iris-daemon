'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn, execSync } = require('child_process')
const EventEmitter = require('events')

const IRIS_DIR = path.join(os.homedir(), '.iris')
const HOST_KEY_FILE = path.join(IRIS_DIR, 'ssh-host-key')
const DEFAULT_PORT = 2222
const DEFAULT_TTL_MS = 30 * 60 * 1000 // 30 minutes

/**
 * SSHShare — Embedded SSH server for Hive terminal sharing.
 *
 * Lets anyone with the temp password SSH into this node and use
 * the IRIS CLI in a sandboxed shell. Works on any client that has
 * `ssh` — including macOS 10.x, Linux, Windows with OpenSSH.
 *
 * Usage from daemon:
 *   const share = new SSHShare({ port: 2222, ttlMs: 1800000 })
 *   const info = await share.start()
 *   // info.password, info.port, info.ips, info.command
 *   share.stop()
 */
class SSHShare extends EventEmitter {
  constructor ({ port, ttlMs, allowedCommands } = {}) {
    super()
    this.port = port || DEFAULT_PORT
    this.ttlMs = ttlMs || DEFAULT_TTL_MS
    this.server = null
    this.password = null
    this.sessions = new Map() // sessionId → { client, pty, startedAt }
    this._expiryTimer = null
    this._running = false

    // Commands the guest can run (prefix-matched)
    const baseCommands = [
      'iris', 'iris-login', 'node', 'npm', 'git',
      'echo', 'whoami', 'date', 'clear', 'exit', 'help'
    ]
    const unixCommands = ['ls', 'cat', 'head', 'tail', 'grep', 'find', 'pwd', 'cd', 'which', 'env']
    const winCommands = ['dir', 'type', 'findstr', 'where', 'set', 'cd', 'cls']

    this.allowedCommands = allowedCommands || [
      ...baseCommands,
      ...(process.platform === 'win32' ? winCommands : unixCommands)
    ]
  }

  async start () {
    if (this._running) throw new Error('SSH share already running')

    const ssh2 = require('ssh2')

    // Generate or load host key
    const hostKey = this._getOrCreateHostKey()

    // Generate temp password (human-readable XXXX-XXXX)
    this.password = this._generatePassword()

    // Detect IPs
    const ips = this._detectIps()

    const self = this
    this.server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
      const sessionId = crypto.randomUUID()
      let authenticated = false

      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.password === self.password) {
          authenticated = true
          ctx.accept()
          console.log(`[ssh-share] Client authenticated (session ${sessionId.substring(0, 8)})`)
          self.emit('client-connected', { sessionId })
        } else if (ctx.method === 'none') {
          // Reject 'none' and tell client we accept password
          ctx.reject(['password'])
        } else {
          ctx.reject(['password'])
        }
      })

      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept()
          self.sessions.set(sessionId, { client, startedAt: Date.now() })

          let ptyInfo = { cols: 80, rows: 24, term: 'xterm-256color' }

          session.on('pty', (accept, reject, info) => {
            ptyInfo = { cols: info.cols || 80, rows: info.rows || 24, term: info.term || 'xterm-256color' }
            accept()
          })

          session.on('window-change', (accept, reject, info) => {
            // Resize the PTY if running
            const sess = self.sessions.get(sessionId)
            if (sess && sess.pty) {
              try { sess.pty.resize(info.cols, info.rows) } catch { /* fine */ }
            }
            if (accept) accept()
          })

          session.on('shell', (accept) => {
            const channel = accept()
            self._handlePtyShell(channel, sessionId, ptyInfo)
          })

          session.on('exec', (accept, reject, info) => {
            const channel = accept()
            self._handleExec(channel, info.command, sessionId)
          })
        })
      })

      client.on('end', () => {
        self.sessions.delete(sessionId)
        console.log(`[ssh-share] Client disconnected (session ${sessionId.substring(0, 8)})`)
        self.emit('client-disconnected', { sessionId })
      })

      client.on('error', (err) => {
        if (err.code !== 'ECONNRESET') {
          console.warn(`[ssh-share] Client error: ${err.message}`)
        }
        self.sessions.delete(sessionId)
      })
    })

    return new Promise((resolve, reject) => {
      this.server.listen(this.port, '0.0.0.0', () => {
        this._running = true

        // Auto-expire
        this._expiryTimer = setTimeout(() => {
          console.log('[ssh-share] Session expired — shutting down share')
          this.stop()
        }, this.ttlMs)

        const info = {
          port: this.port,
          password: this.password,
          ips,
          ttlMs: this.ttlMs,
          expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
          commands: this._buildConnectionCommands(ips)
        }

        console.log(`[ssh-share] SSH server listening on port ${this.port}`)
        this.emit('started', info)
        resolve(info)
      })

      this.server.on('error', (err) => {
        if (!this._running) {
          reject(err)
        } else {
          console.error(`[ssh-share] Server error: ${err.message}`)
        }
      })
    })
  }

  stop () {
    if (!this._running) return
    this._running = false

    if (this._expiryTimer) {
      clearTimeout(this._expiryTimer)
      this._expiryTimer = null
    }

    // Kill ngrok tunnel if we started one
    if (this._ngrokProcess) {
      try { this._ngrokProcess.kill() } catch { /* fine */ }
      this._ngrokProcess = null
    }

    // Disconnect all clients
    for (const [id, sess] of this.sessions) {
      try { sess.client.end() } catch { /* fine */ }
    }
    this.sessions.clear()

    if (this.server) {
      this.server.close()
      this.server = null
    }

    this.password = null
    console.log('[ssh-share] SSH share stopped')
    this.emit('stopped')
  }

  /**
   * Start a public ngrok tunnel so anyone on the internet can connect.
   * Returns the public host:port once the tunnel is ready.
   */
  async startPublicTunnel () {
    if (!this._running) throw new Error('SSH share must be started first')

    const { spawn: spawnChild } = require('child_process')
    const http = require('http')

    // Check ngrok exists
    try {
      execSync('which ngrok 2>/dev/null || where ngrok 2>nul', { stdio: 'pipe' })
    } catch {
      throw new Error('ngrok not installed. Install with: brew install ngrok')
    }

    // Start ngrok in background
    const ngrok = spawnChild('ngrok', ['tcp', String(this.port), '--log=stdout'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false
    })
    this._ngrokProcess = ngrok

    ngrok.on('error', (err) => {
      console.error(`[ssh-share] ngrok error: ${err.message}`)
    })

    ngrok.on('exit', (code) => {
      if (this._running) {
        console.warn(`[ssh-share] ngrok exited with code ${code}`)
      }
      this._ngrokProcess = null
    })

    // Wait for ngrok API to be ready, then get the public URL
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000
      const poll = () => {
        if (Date.now() > deadline) {
          reject(new Error('ngrok tunnel timed out'))
          return
        }

        const req = http.get('http://localhost:4040/api/tunnels', (res) => {
          let data = ''
          res.on('data', (c) => { data += c })
          res.on('end', () => {
            try {
              const tunnels = JSON.parse(data).tunnels
              if (tunnels && tunnels.length > 0) {
                const url = tunnels[0].public_url.replace('tcp://', '')
                const [host, port] = url.split(':')
                const tunnel = { host, port: parseInt(port, 10), url }
                this._tunnel = tunnel
                this.emit('tunnel-ready', tunnel)
                resolve(tunnel)
              } else {
                setTimeout(poll, 500)
              }
            } catch {
              setTimeout(poll, 500)
            }
          })
        })
        req.on('error', () => setTimeout(poll, 500))
        req.end()
      }
      setTimeout(poll, 2000) // give ngrok a sec to start
    })
  }

  getStatus () {
    return {
      running: this._running,
      port: this.port,
      password: this._running ? this.password : null,
      active_sessions: this.sessions.size,
      ips: this._running ? this._detectIps() : []
    }
  }

  // ─── PTY Shell (full interactive terminal) ─────────────────────

  _handlePtyShell (channel, sessionId, ptyInfo) {
    let pty
    try {
      pty = require('node-pty')
    } catch {
      // Fallback to simple shell if node-pty not available
      console.warn('[ssh-share] node-pty not installed — falling back to simple shell')
      return this._handleShell(channel, sessionId)
    }

    const irisPath = path.join(os.homedir(), '.iris', 'bin')
    const shellCmd = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/bash')

    const term = pty.spawn(shellCmd, [], {
      name: ptyInfo.term || 'xterm-256color',
      cols: ptyInfo.cols || 80,
      rows: ptyInfo.rows || 24,
      cwd: os.homedir(),
      env: {
        ...process.env,
        PATH: `${irisPath}:${process.env.PATH}`,
        TERM: ptyInfo.term || 'xterm-256color',
        HOME: os.homedir(),
        IRIS_SHARED_SESSION: '1'
      }
    })

    // Store PTY on session for window-change resize
    const sess = this.sessions.get(sessionId)
    if (sess) sess.pty = term

    // Pipe PTY output → SSH channel
    term.onData((data) => {
      try { channel.write(data) } catch { /* client disconnected */ }
    })

    // Pipe SSH channel input → PTY
    channel.on('data', (data) => {
      try { term.write(data) } catch { /* pty closed */ }
    })

    term.onExit(({ exitCode }) => {
      try { channel.exit(exitCode) } catch { /* fine */ }
      try { channel.close() } catch { /* fine */ }
      this.sessions.delete(sessionId)
    })

    channel.on('close', () => {
      try { term.kill() } catch { /* fine */ }
      this.sessions.delete(sessionId)
    })
  }

  // ─── Simple Shell Fallback ────────────────────────────────────

  _handleShell (channel, sessionId) {
    const irisPath = path.join(os.homedir(), '.iris', 'bin')
    const motd = [
      '',
      '\x1b[36m┌──────────────────────────────────────────┐\x1b[0m',
      '\x1b[36m│\x1b[0m  \x1b[1mIRIS Hive — Shared Terminal\x1b[0m              \x1b[36m│\x1b[0m',
      '\x1b[36m├──────────────────────────────────────────┤\x1b[0m',
      `\x1b[36m│\x1b[0m  Node: ${os.hostname().padEnd(33)}\x1b[36m│\x1b[0m`,
      '\x1b[36m│\x1b[0m  Type "iris" to get started              \x1b[36m│\x1b[0m',
      '\x1b[36m│\x1b[0m  Type "help" for available commands       \x1b[36m│\x1b[0m',
      '\x1b[36m│\x1b[0m  Type "exit" to disconnect                \x1b[36m│\x1b[0m',
      '\x1b[36m└──────────────────────────────────────────┘\x1b[0m',
      ''
    ].join('\r\n')

    channel.write(motd)
    channel.write('\x1b[32miris-hive\x1b[0m $ ')

    let inputBuffer = ''

    channel.on('data', (data) => {
      const str = data.toString()

      for (const ch of str) {
        if (ch === '\r' || ch === '\n') {
          channel.write('\r\n')
          const cmd = inputBuffer.trim()
          inputBuffer = ''

          if (!cmd) {
            channel.write('\x1b[32miris-hive\x1b[0m $ ')
            continue
          }

          if (cmd === 'exit' || cmd === 'quit') {
            channel.write('Goodbye!\r\n')
            channel.close()
            return
          }

          if (cmd === 'help') {
            channel.write(this._helpText())
            channel.write('\x1b[32miris-hive\x1b[0m $ ')
            continue
          }

          this._execCommand(channel, cmd, irisPath)
        } else if (ch === '\x7f' || ch === '\b') {
          // Backspace
          if (inputBuffer.length > 0) {
            inputBuffer = inputBuffer.slice(0, -1)
            channel.write('\b \b')
          }
        } else if (ch === '\x03') {
          // Ctrl+C
          inputBuffer = ''
          channel.write('^C\r\n\x1b[32miris-hive\x1b[0m $ ')
        } else if (ch >= ' ') {
          inputBuffer += ch
          channel.write(ch)
        }
      }
    })

    channel.on('close', () => {
      this.sessions.delete(sessionId)
    })
  }

  _handleExec (channel, command, sessionId) {
    const irisPath = path.join(os.homedir(), '.iris', 'bin')
    const bin = command.split(/\s+/)[0]

    if (!this._isAllowed(bin)) {
      channel.stderr.write(`Command not allowed: ${bin}\r\n`)
      channel.exit(1)
      channel.close()
      return
    }

    const env = {
      ...process.env,
      PATH: `${irisPath}:${process.env.PATH}`,
      TERM: 'xterm-256color',
      HOME: os.homedir()
    }

    const shell = process.platform === 'win32' ? 'cmd.exe' : 'sh'
    const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command]
    const child = spawn(shell, shellArgs, {
      env,
      cwd: os.homedir(),
      timeout: 60000
    })

    child.stdout.on('data', (d) => channel.write(d))
    child.stderr.on('data', (d) => channel.stderr.write(d))
    child.on('close', (code) => {
      channel.exit(code || 0)
      channel.close()
    })
    child.on('error', (err) => {
      channel.stderr.write(`Error: ${err.message}\r\n`)
      channel.exit(1)
      channel.close()
    })
  }

  _execCommand (channel, command, irisPath) {
    const bin = command.split(/\s+/)[0]

    if (!this._isAllowed(bin)) {
      channel.write(`\x1b[31mCommand not allowed:\x1b[0m ${bin}\r\n`)
      channel.write('Type "help" for available commands.\r\n')
      channel.write('\x1b[32miris-hive\x1b[0m $ ')
      return
    }

    const env = {
      ...process.env,
      PATH: `${irisPath}:${process.env.PATH}`,
      TERM: 'xterm-256color',
      HOME: os.homedir()
    }

    const shell = process.platform === 'win32' ? 'cmd.exe' : 'sh'
    const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command]
    const child = spawn(shell, shellArgs, {
      env,
      cwd: os.homedir(),
      timeout: 120000
    })

    child.stdout.on('data', (d) => {
      // Convert \n to \r\n for proper terminal display
      const text = d.toString().replace(/\n/g, '\r\n')
      channel.write(text)
    })

    child.stderr.on('data', (d) => {
      const text = d.toString().replace(/\n/g, '\r\n')
      channel.write(`\x1b[31m${text}\x1b[0m`)
    })

    child.on('close', () => {
      channel.write('\x1b[32miris-hive\x1b[0m $ ')
    })

    child.on('error', (err) => {
      channel.write(`\x1b[31mError: ${err.message}\x1b[0m\r\n`)
      channel.write('\x1b[32miris-hive\x1b[0m $ ')
    })
  }

  _isAllowed (bin) {
    const basename = path.basename(bin)
    return this.allowedCommands.some(allowed => basename === allowed || basename.startsWith(allowed + '-'))
  }

  _helpText () {
    return [
      '',
      '\x1b[1mAvailable commands:\x1b[0m',
      '',
      '  \x1b[36miris\x1b[0m                  IRIS CLI (chat, agents, knowledge, leads)',
      '  \x1b[36miris chat\x1b[0m              Chat with an AI agent',
      '  \x1b[36miris agents\x1b[0m            List available agents',
      '  \x1b[36miris bloqs\x1b[0m             Browse knowledge bases',
      '  \x1b[36miris leads\x1b[0m             Manage leads and outreach',
      '  \x1b[36miris hive status\x1b[0m       Check Hive node status',
      '',
      '  \x1b[90mls, cat, grep, find, pwd, echo, git, node, npm\x1b[0m',
      '',
      '  \x1b[33mexit\x1b[0m                  Disconnect',
      ''
    ].join('\r\n')
  }

  // ─── IP Detection ──────────────────────────────────────────────

  _detectIps () {
    const ips = { local: [], tailscale: null, public: null }

    // Local network IPs
    const ifaces = os.networkInterfaces()
    for (const [name, addrs] of Object.entries(ifaces)) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          if (name.startsWith('utun') || name === 'tailscale0' || (addr.address.startsWith('100.') && !addr.address.startsWith('100.64.'))) {
            ips.tailscale = addr.address
          } else {
            ips.local.push(addr.address)
          }
        }
      }
    }

    // Try Tailscale CLI for definitive IP
    if (!ips.tailscale) {
      try {
        const tsIp = execSync('tailscale ip -4 2>/dev/null', { encoding: 'utf-8', timeout: 3000 }).trim()
        if (tsIp && /^\d+\.\d+\.\d+\.\d+$/.test(tsIp)) {
          ips.tailscale = tsIp
        }
      } catch { /* tailscale not installed or not connected */ }
    }

    return ips
  }

  _buildConnectionCommands (ips) {
    const commands = {}

    if (ips.tailscale) {
      commands.tailscale = `ssh iris-hive@${ips.tailscale} -p ${this.port}`
    }
    if (ips.local.length > 0) {
      commands.lan = `ssh iris-hive@${ips.local[0]} -p ${this.port}`
    }
    // Generic (user fills in IP)
    commands.generic = `ssh iris-hive@<this-machines-ip> -p ${this.port}`

    return commands
  }

  // ─── Key Management ────────────────────────────────────────────

  _getOrCreateHostKey () {
    // Try to load existing key
    if (fs.existsSync(HOST_KEY_FILE)) {
      try {
        return fs.readFileSync(HOST_KEY_FILE, 'utf-8')
      } catch { /* regenerate */ }
    }

    // Generate new RSA key using ssh-keygen (available on all macOS)
    console.log('[ssh-share] Generating SSH host key...')
    try {
      execSync(`ssh-keygen -t rsa -b 2048 -f "${HOST_KEY_FILE}" -N "" -q`, {
        encoding: 'utf-8',
        timeout: 10000
      })
      // ssh-keygen creates HOST_KEY_FILE (private) and HOST_KEY_FILE.pub
      return fs.readFileSync(HOST_KEY_FILE, 'utf-8')
    } catch (err) {
      // Fallback: generate with crypto (ed25519-style via ssh2)
      console.warn('[ssh-share] ssh-keygen failed, using crypto fallback')
      const { generateKeyPairSync } = require('crypto')
      const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        publicKeyEncoding: { type: 'pkcs1', format: 'pem' }
      })
      const dir = path.dirname(HOST_KEY_FILE)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(HOST_KEY_FILE, privateKey, { mode: 0o600 })
      return privateKey
    }
  }

  _generatePassword () {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let code = ''
    const bytes = crypto.randomBytes(8)
    for (let i = 0; i < 8; i++) {
      code += chars[bytes[i] % chars.length]
      if (i === 3) code += '-'
    }
    return code
  }
}

module.exports = SSHShare
