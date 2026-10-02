'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

/**
 * MeshLLM, run by the node.
 *
 * Opt-in from ~/.iris/bridge/.env. Off, nothing here runs and nothing else changes:
 *
 *   HIVE_MESH_LLM=serve             host a model on the mesh     (or `client`: join, no model)
 *   HIVE_MESH_LLM_GGUF=/abs/x.gguf  the model file to serve — e.g. one Ollama already downloaded
 *   HIVE_MESH_LLM_JOIN_FILE=/abs/f  invite token of the mesh to join (omit to start a new mesh)
 *   HIVE_MESH_LLM_SPLIT=1           force the model to be split across the mesh's nodes
 *   HIVE_MESH_LLM_CTX=4096          context size   (MeshLLM's default, 131k × 4 lanes, fails on 16 GB)
 *   HIVE_MESH_LLM_PARALLEL=1        parallel lanes
 *
 * On: the daemon starts MeshLLM, restarts it if it dies, stops it on shutdown, saves the mesh's
 * invite token to ~/.iris/mesh-llm.invite (0600, never logged) so another node can join, and
 * points this node's `local_llm` at the mesh — so the heartbeat advertises every model on it and
 * the hub routes those tasks here. Hive keeps doing everything it did; this is one more source of
 * models behind the same seam.
 */

const MESH_BASE_URL = 'http://localhost:9337/v1'
const MODES = ['serve', 'client']

/**
 * macOS 14 workaround (upstream Mesh-LLM/mesh-llm#2156): MTLCreateSystemDefaultDevice is nil
 * in a process that has not loaded CoreGraphics, so MeshLLM plans on 0 GB and places nothing.
 * Set on the child's own env — macOS strips DYLD_* when it passes through a protected binary
 * such as nohup or env, so it has to be given to mesh-llm directly.
 */
const COREGRAPHICS = '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics'

function intEnv (v, fallback) {
  const n = parseInt(v, 10)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/** The node's MeshLLM settings, or null when it is off. Throws on a setting that cannot work. */
function resolveMeshConfig (env = process.env) {
  const mode = String(env.HIVE_MESH_LLM || '').trim().toLowerCase()
  if (!mode || mode === 'off' || mode === '0' || mode === 'false') return null
  if (!MODES.includes(mode)) throw new Error(`HIVE_MESH_LLM must be serve or client, not "${mode}"`)
  const gguf = String(env.HIVE_MESH_LLM_GGUF || '').trim() || null
  const joinFile = String(env.HIVE_MESH_LLM_JOIN_FILE || '').trim() || null
  if (mode === 'serve' && !gguf) throw new Error('HIVE_MESH_LLM=serve needs HIVE_MESH_LLM_GGUF — the model file to serve')
  if (mode === 'client' && !joinFile) throw new Error('HIVE_MESH_LLM=client needs HIVE_MESH_LLM_JOIN_FILE — the mesh to join')
  return {
    mode,
    gguf,
    joinFile,
    split: /^(1|true|yes)$/i.test(String(env.HIVE_MESH_LLM_SPLIT || '')),
    ctx: intEnv(env.HIVE_MESH_LLM_CTX, 4096),
    parallel: intEnv(env.HIVE_MESH_LLM_PARALLEL, 1)
  }
}

/** mesh-llm argv. The invite token is passed as a FILE, never on the command line (ps shows argv). */
function buildMeshArgs (cfg) {
  const args = ['--log-format', 'json', cfg.mode]
  if (cfg.mode === 'serve') {
    args.push('--gguf', cfg.gguf, '--ctx-size', String(cfg.ctx), '--parallel', String(cfg.parallel))
    if (cfg.split) args.push('--split')
  }
  if (cfg.joinFile) args.push('--join-file', cfg.joinFile)
  return args
}

/** The child's environment: ours, plus the macOS 14 GPU fix. */
function meshEnv (env = process.env, platform = process.platform) {
  const out = { ...env }
  if (platform === 'darwin' && !out.DYLD_INSERT_LIBRARIES) out.DYLD_INSERT_LIBRARIES = COREGRAPHICS
  return out
}

/** The invite token from one line of mesh-llm's JSON log, or null. */
function parseInviteToken (line) {
  const m = /invite token ready for mesh [0-9a-f]+: ([A-Za-z0-9_\-=]+)/.exec(String(line))
  return m ? m[1] : null
}

/** The real mesh-llm binary — never this repo's shim or another wrapper that would recurse. */
function findMeshBinary (env = process.env) {
  const dirs = String(env.PATH || '').split(path.delimiter).concat(['/opt/homebrew/bin', '/usr/local/bin'])
  const shimDir = path.join(os.homedir(), '.iris', 'bin')
  for (const d of dirs) {
    if (!d || path.resolve(d) === shimDir) continue
    const c = path.join(d, process.platform === 'win32' ? 'mesh-llm.exe' : 'mesh-llm')
    try { fs.accessSync(c, fs.constants.X_OK); return c } catch { /* next */ }
  }
  return null
}

class MeshLlmSupervisor {
  constructor ({
    env = process.env,
    spawnFn = spawn,
    binary = null,
    inviteFile = path.join(os.homedir(), '.iris', 'mesh-llm.invite'),
    logFile = path.join(os.homedir(), '.iris', 'logs', 'mesh-llm.log'),
    log = console,
    maxBackoffMs = 300000
  } = {}) {
    this.env = env
    this.spawnFn = spawnFn
    this.binary = binary
    this.inviteFile = inviteFile
    this.logFile = logFile
    this.log = log
    this.maxBackoffMs = maxBackoffMs
    this.config = null
    this.child = null
    this.stopped = false
    this.restarts = 0
    this._restartTimer = null
  }

  /**
   * Start MeshLLM if this node is configured for it. Returns false when it is off.
   * Points LOCAL_LLM_BASE_URL at the mesh unless the operator set one explicitly.
   */
  start () {
    this.config = resolveMeshConfig(this.env)
    if (!this.config) return false
    this.binary = this.binary || findMeshBinary(this.env)
    if (!this.binary) throw new Error('HIVE_MESH_LLM is set but mesh-llm is not installed (brew install Mesh-LLM/tap/mesh-llm)')
    if (!this.env.LOCAL_LLM_BASE_URL) this.env.LOCAL_LLM_BASE_URL = MESH_BASE_URL
    // A mesh-llm left behind by a daemon that was killed hard still holds :9337.
    try { spawnSync(this.binary, ['stop'], { stdio: 'ignore', timeout: 15000 }) } catch { /* none running */ }
    this._spawn()
    return true
  }

  _spawn () {
    if (this.stopped) return
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true })
    const out = fs.openSync(this.logFile, this.restarts === 0 ? 'w' : 'a')
    const child = this.spawnFn(this.binary, buildMeshArgs(this.config), {
      env: meshEnv(this.env),
      stdio: ['ignore', 'pipe', out]
    })
    this.child = child
    const startedAt = Date.now()
    this.log.log(`[mesh-llm] ${this.config.mode} started (pid ${child.pid}) → ${MESH_BASE_URL}`)

    let buf = ''
    child.stdout.on('data', (d) => {
      const text = d.toString()
      fs.appendFileSync(this.logFile, text)
      buf += text
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        const token = parseInviteToken(line)
        if (token) this._saveInvite(token)
      }
    })

    child.on('exit', (code, signal) => {
      try { fs.closeSync(out) } catch { /* closed */ }
      this.child = null
      if (this.stopped) return
      // Ran for a while: a fresh failure, start the backoff over.
      if (Date.now() - startedAt > 120000) this.restarts = 0
      this.restarts++
      const wait = Math.min(5000 * 2 ** (this.restarts - 1), this.maxBackoffMs)
      this.log.error(`[mesh-llm] exited (${signal || code}) — restarting in ${Math.round(wait / 1000)}s. Log: ${this.logFile}`)
      this._restartTimer = setTimeout(() => this._spawn(), wait)
      if (this._restartTimer.unref) this._restartTimer.unref()
    })
  }

  _saveInvite (token) {
    try {
      fs.writeFileSync(this.inviteFile, token + '\n', { mode: 0o600 })
      fs.chmodSync(this.inviteFile, 0o600)
      this.log.log(`[mesh-llm] invite saved to ${this.inviteFile} — copy it to a node and set HIVE_MESH_LLM_JOIN_FILE there`)
    } catch (e) {
      this.log.error(`[mesh-llm] could not save the invite: ${e.message}`)
    }
  }

  stop () {
    this.stopped = true
    if (this._restartTimer) clearTimeout(this._restartTimer)
    if (this.child) {
      try { this.child.kill('SIGTERM') } catch { /* gone */ }
    }
  }
}

module.exports = {
  MESH_BASE_URL,
  resolveMeshConfig,
  buildMeshArgs,
  meshEnv,
  parseInviteToken,
  findMeshBinary,
  MeshLlmSupervisor
}
