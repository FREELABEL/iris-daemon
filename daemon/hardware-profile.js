/**
 * HardwareProfile — Detects machine capabilities on first install.
 *
 * Runs once during installation and caches results to ~/.iris/hardware-profile.json.
 * The hub uses this to intelligently route tasks: GPU workstations get heavy LLM
 * inference, Raspberry Pis get lightweight automation, MacBooks get general tasks.
 *
 * Re-run on demand via GET /profile endpoint.
 */

const os = require('os')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const http = require('http')

const CACHE_PATH = path.join(os.homedir(), '.iris', 'hardware-profile.json')

/**
 * Bump when detection LOGIC changes so already-cached profiles re-detect.
 *
 * Without this, a detection bug is permanent: the profile is written once at install
 * and read back forever, so fixing the detector fixes nothing on any existing machine.
 * That is exactly what happened with apple_apps — see detectAppleApps().
 *
 * 2 — apple_apps: look under /System/Applications (macOS 10.15+), not just /Applications.
 */
const PROFILE_SCHEMA_VERSION = 2

/** Re-detect if the cache is older than this, so capability changes propagate. */
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Detect full hardware profile.
 * @param {Object} options
 * @param {boolean} options.forceRefresh - Skip cache and re-detect
 * @returns {Object} hardware profile
 */
async function detectProfile (options = {}) {
  // Return cached only if it is FRESH and produced by the current detection logic.
  // A cache that never expires turns a one-line detector bug into a permanent
  // wrong answer on every machine that ever installed the daemon.
  if (!options.forceRefresh && fs.existsSync(CACHE_PATH)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'))
      const sameSchema = (cached.schema_version || 1) === PROFILE_SCHEMA_VERSION
      const age = Date.now() - new Date(cached.detected_at || 0).getTime()
      if (sameSchema && age < CACHE_MAX_AGE_MS) return cached
    } catch { /* corrupted cache, re-detect */ }
  }

  const profile = {
    schema_version: PROFILE_SCHEMA_VERSION,
    detected_at: new Date().toISOString(),
    os: {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      type: os.type(),
      label: `${os.platform()}-${os.arch()}`
    },
    cpu: detectCPU(),
    memory: {
      total_bytes: os.totalmem(),
      total_gb: Math.round(os.totalmem() / (1024 ** 3) * 10) / 10
    },
    disk: detectDisk(),
    gpu: detectGPU(),
    ollama: await detectOllama(),
    apple_apps: detectAppleApps(),
    node_version: process.version,
    hostname: os.hostname()
  }

  // Cache the result
  const cacheDir = path.dirname(CACHE_PATH)
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true })
  }
  fs.writeFileSync(CACHE_PATH, JSON.stringify(profile, null, 2))

  return profile
}

function detectCPU () {
  const cpus = os.cpus()
  const model = cpus.length > 0 ? cpus[0].model : 'unknown'
  const cores = cpus.length

  // Detect Apple Silicon specifically
  let chipName = null
  if (os.platform() === 'darwin') {
    try {
      chipName = execSync('sysctl -n machdep.cpu.brand_string 2>/dev/null', { encoding: 'utf-8' }).trim()
    } catch { /* not available */ }
  }

  return {
    model: chipName || model,
    cores,
    speed_mhz: cpus.length > 0 ? cpus[0].speed : 0
  }
}

function detectDisk () {
  try {
    if (os.platform() === 'darwin' || os.platform() === 'linux') {
      const output = execSync('df -k / 2>/dev/null', { encoding: 'utf-8' })
      const lines = output.trim().split('\n')
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/)
        const totalKB = parseInt(parts[1], 10)
        const availKB = parseInt(parts[3], 10)
        return {
          total_gb: Math.round(totalKB / (1024 ** 2) * 10) / 10,
          available_gb: Math.round(availKB / (1024 ** 2) * 10) / 10
        }
      }
    } else if (os.platform() === 'win32') {
      const output = execSync('wmic logicaldisk where "DeviceID=\'C:\'" get Size,FreeSpace /format:csv 2>nul', { encoding: 'utf-8' })
      const lines = output.trim().split('\n').filter(l => l.trim())
      if (lines.length >= 2) {
        const parts = lines[lines.length - 1].split(',')
        const freeBytes = parseInt(parts[1], 10)
        const totalBytes = parseInt(parts[2], 10)
        if (totalBytes > 0) {
          return {
            total_gb: Math.round(totalBytes / (1024 ** 3) * 10) / 10,
            available_gb: Math.round(freeBytes / (1024 ** 3) * 10) / 10
          }
        }
      }
    }
  } catch { /* ignore */ }

  return { total_gb: null, available_gb: null }
}

function detectGPU () {
  const result = {
    available: false,
    type: null,
    name: null,
    vram_gb: null,
    metal_support: false
  }

  if (os.platform() === 'darwin') {
    // Check for Metal-capable GPU (Apple Silicon or discrete)
    try {
      const output = execSync('system_profiler SPDisplaysDataType 2>/dev/null', { encoding: 'utf-8' })

      // Check for Metal support
      if (/metal/i.test(output)) {
        result.metal_support = true
        result.available = true
        result.type = 'metal'
      }

      // Extract chipset/GPU name
      const chipMatch = output.match(/Chipset Model:\s*(.+)/i)
      if (chipMatch) {
        result.name = chipMatch[1].trim()
      }

      // Apple Silicon uses unified memory — report total RAM as "VRAM"
      if (/apple/i.test(result.name || '')) {
        result.vram_gb = Math.round(os.totalmem() / (1024 ** 3) * 10) / 10
      }
    } catch { /* system_profiler not available */ }
  } else if (os.platform() === 'linux' || os.platform() === 'win32') {
    // Check for NVIDIA GPU (nvidia-smi works on both Linux and Windows)
    const nullDev = os.platform() === 'win32' ? '2>nul' : '2>/dev/null'
    try {
      const output = execSync(`nvidia-smi --query-gpu=name,memory.total --format=csv,noheader ${nullDev}`, { encoding: 'utf-8' })
      if (output.trim()) {
        const parts = output.trim().split(',')
        result.available = true
        result.type = 'nvidia'
        result.name = parts[0]?.trim()
        const vramMatch = parts[1]?.trim().match(/(\d+)/)
        if (vramMatch) {
          result.vram_gb = Math.round(parseInt(vramMatch[1], 10) / 1024 * 10) / 10
        }
      }
    } catch { /* nvidia-smi not available */ }

    // Fallback: Windows Intel/AMD GPU detection via PowerShell
    if (!result.available && os.platform() === 'win32') {
      try {
        const output = execSync('powershell -Command "Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name" 2>nul', { encoding: 'utf-8', timeout: 5000 })
        if (output.trim()) {
          result.available = true
          result.type = 'integrated'
          result.name = output.trim()
        }
      } catch { /* PowerShell not available */ }
    }
  }

  return result
}

/**
 * Check if Ollama is running and what models are available.
 */
function detectOllama () {
  return new Promise((resolve) => {
    const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434'
    const url = new URL('/api/tags', ollamaHost)

    const req = http.request({
      hostname: url.hostname,
      port: url.port || 11434,
      path: url.pathname,
      method: 'GET',
      timeout: 3000
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          const models = (parsed.models || []).map(m => ({
            name: m.name,
            size_gb: m.size ? Math.round(m.size / (1024 ** 3) * 10) / 10 : null,
            family: m.details?.family || null
          }))
          resolve({
            available: true,
            host: ollamaHost,
            model_count: models.length,
            models
          })
        } catch {
          resolve({ available: true, host: ollamaHost, model_count: 0, models: [] })
        }
      })
    })

    req.on('error', () => {
      resolve({ available: false, host: ollamaHost, model_count: 0, models: [] })
    })

    req.on('timeout', () => {
      req.destroy()
      resolve({ available: false, host: ollamaHost, model_count: 0, models: [] })
    })

    req.end()
  })
}

/**
 * Detect macOS-specific app availability for outreach capabilities.
 * Returns platform info + presence of Mail.app, Messages.app, and chat.db.
 * Only meaningful on darwin; returns safe defaults on other platforms.
 */
function detectAppleApps () {
  if (os.platform() !== 'darwin') {
    return {
      platform: os.platform(),
      imessage: false,
      apple_mail: false,
      chat_db: null
    }
  }

  const chatDbPath = path.join(os.homedir(), 'Library', 'Messages', 'chat.db')

  // macOS 10.15 (Catalina, 2019) moved the bundled apps out of /Applications into
  // the read-only system volume at /System/Applications. Checking only /Applications
  // therefore reported apple_mail:false and messages_app:false on EVERY modern Mac —
  // and because the profile was cached forever, that false answer stuck permanently.
  // Measured on macOS 15.1.1: /Applications/Mail.app missing, /System/Applications/Mail.app present.
  const appExists = (name) =>
    fs.existsSync(`/System/Applications/${name}`) || fs.existsSync(`/Applications/${name}`)

  // ADVERTISE A CAPABILITY ONLY ON EVIDENCE OF ACCESS, NEVER ON EVIDENCE OF EXISTENCE (#182007).
  //
  // This used to be `fs.existsSync(chatDbPath)`. existsSync is a stat, and TCC blocks the
  // open() — not the stat. So on a Mac without Full Disk Access the file is present and
  // unreadable, and this reported the node as iMessage-capable. Measured 2026-08-23 on
  // MacBookPro: presence TRUE, sqlite3 read "authorization denied", 69 consecutive Calendar
  // failures, and `hive nodes show` still listing the node healthy with nine capabilities.
  //
  // A blind node that advertises sight is worse than one that advertises nothing, because a
  // TCC-blocked read returns EMPTY rather than failing — so the node accepts the work and
  // answers zero rows, which reads as a legitimate result. That is the same defect the
  // capability gate is meant to stop (#182452), one layer down: it cannot be fixed there
  // while the input to it is a lie.
  //
  // The distinction the probe must preserve is three-way, because the remedies differ:
  // absent (nothing to read), blocked (grant FDA, then RESTART — TCC is read at process
  // start), readable.
  const imessageAccess = probeReadAccess(chatDbPath)

  return {
    platform: 'darwin',
    imessage: imessageAccess.readable,
    // WHY, not just whether. "false" alone sent people to look for a missing file on a
    // machine where the file was right there and the daemon simply had no permission.
    imessage_reason: imessageAccess.reason,
    apple_mail: appExists('Mail.app'),
    messages_app: appExists('Messages.app'),
    // Only hand out a path that was actually opened. A path that turns out to be unreadable
    // is an invitation to a caller to fail further downstream, with less context than here.
    chat_db: imessageAccess.readable ? chatDbPath : null
  }
}

/**
 * Can this process actually READ this file, right now?
 *
 * Opens it. Nothing cheaper answers the question: `existsSync` and `fs.access(F_OK)` both
 * stat, and a TCC denial lands on the open. `fs.access(R_OK)` checks unix permission bits,
 * which on a TCC-blocked file still say yes.
 *
 * @returns {{readable: boolean, reason: string|null}}
 *   reason is null when readable, otherwise 'absent' | 'permission-denied' | an errno code.
 */
function probeReadAccess (filePath) {
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    // Pull a byte. Measured: a zero-length file returns 0 here rather than throwing, so an
    // empty-but-readable file correctly reports readable — there is no EOF case to catch.
    fs.readSync(fd, Buffer.alloc(1), 0, 1, 0)
    return { readable: true, reason: null }
  } catch (e) {
    if (e && e.code === 'ENOENT') return { readable: false, reason: 'absent' }
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) {
      return { readable: false, reason: 'permission-denied' }
    }
    return { readable: false, reason: (e && e.code) || 'unknown' }
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* already gone */ } }
  }
}

/**
 * Get cached profile or detect fresh.
 */
function getCachedProfile () {
  if (fs.existsSync(CACHE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'))
    } catch { /* corrupted */ }
  }
  return null
}

module.exports = { detectProfile, getCachedProfile, detectAppleApps, CACHE_PATH }
