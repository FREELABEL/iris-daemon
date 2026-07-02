/**
 * CloudClient — The node's only connection to the outside world.
 *
 * Think of this as the control plane proxy from Browser Use's architecture.
 * The node authenticates with a single API key and talks to iris-api (the hub)
 * for everything: task fetch, progress reporting, result submission.
 *
 * In the sovereign model, the hub holds all cloud credentials (OpenAI keys,
 * Stripe tokens, S3 access). The node requests operations through the hub.
 * The node never sees the real credentials. If the node is compromised,
 * there's nothing to steal.
 *
 * Resilience features:
 *   - DNS failover: if primary URL fails with connection errors, switch to fallback
 *   - Auto-probe: periodically check if primary URL has recovered
 *   - Error classification: only failover on DNS/connection errors, not HTTP errors
 *
 * "Your agent should have nothing worth stealing and nothing worth preserving."
 *   — Browser Use architecture principle, adopted by Hive.
 */

const crypto = require('crypto')
const https = require('https')
const http = require('http')
const { URL } = require('url')

// Error codes that indicate DNS or connection-level failures (not HTTP errors)
const CONNECTION_ERROR_CODES = ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']

class CloudClient {
  constructor (apiUrl, apiKey, fallbackUrl = null) {
    this.primaryUrl = apiUrl.replace(/\/$/, '')
    this.fallbackUrl = fallbackUrl ? fallbackUrl.replace(/\/$/, '') : null
    this.apiUrl = this.primaryUrl // active URL
    this.apiKey = apiKey
    // Skip TLS verification for local dev (self-signed certs)
    this.isLocalDev = /local\.|localhost|127\.0\.0\.1/.test(this.primaryUrl)

    // Failover state
    this.consecutivePrimaryFailures = 0
    this.failoverThreshold = 3 // switch to fallback after this many primary failures
    this.usingFallback = false
    this.requestsSinceFallback = 0
    this.primaryProbeInterval = 10 // try primary every N successful requests on fallback

    // Task-signature enforcement (#157524). The hub HMAC-signs each task
    // payload; the node validates it with its api_key as the shared secret.
    // Enforcement is GATED so we don't brick hubs that haven't started signing
    // yet, while still moving toward the security floor:
    //   HIVE_REQUIRE_SIGNATURE=1|true|yes  → reject tasks with a MISSING sig
    //   HIVE_REQUIRE_SIGNATURE=0|false|no  → warn-only on missing sig
    //   unset (default)                    → enforce IFF a dedicated signing
    //                                        secret (HIVE_SIGNING_SECRET) is set
    // NOTE: a *bad* (present-but-invalid) signature is ALWAYS rejected in
    // fetchTask regardless of this flag — this switch only governs how a
    // *missing* signature is treated, preserving backward-compat by default.
    const reqEnv = (process.env.HIVE_REQUIRE_SIGNATURE || '').toLowerCase()
    if (reqEnv === '1' || reqEnv === 'true' || reqEnv === 'yes') {
      this.requireSignature = true
    } else if (reqEnv === '0' || reqEnv === 'false' || reqEnv === 'no') {
      this.requireSignature = false
    } else {
      // Default: opt into enforcement only when a signing secret is configured.
      this.requireSignature = !!process.env.HIVE_SIGNING_SECRET
    }
  }

  /**
   * Classify whether an error is a DNS or connection-level failure.
   */
  static isConnectionError (err) {
    if (CONNECTION_ERROR_CODES.includes(err.code)) return true
    if (/timeout/i.test(err.message) && !err.statusCode) return true
    return false
  }

  /**
   * Send heartbeat — authenticates and registers the node as online.
   * @param {Object} extra - Additional data to include (capacity, hardware_profile, paused)
   */
  async sendHeartbeat (extra = {}) {
    return this.post('/api/v6/node-agent/heartbeat', extra)
  }

  /**
   * Mark node as offline (called during shutdown).
   */
  async markOffline () {
    return this.post('/api/v6/node-agent/heartbeat', { going_offline: true })
  }

  /**
   * Fetch full task details by ID.
   * Verifies HMAC-SHA256 signature to ensure the task payload is authentic.
   */
  async fetchTask (taskId) {
    const response = await this.get(`/api/v6/node-agent/tasks/${taskId}`)
    const task = response.task

    // Verify task signature (hub signs with our api_key as HMAC secret)
    if (task._signature) {
      const signPayload = task.id + ':' + task.type + ':' + (task.prompt || '') + ':' + JSON.stringify(task.config ?? null)
      const expected = crypto.createHmac('sha256', this.apiKey).update(signPayload).digest('hex')
      const sigBuf = Buffer.from(task._signature, 'hex')
      const expBuf = Buffer.from(expected, 'hex')
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        throw new Error(`Task ${taskId} signature verification failed — payload may be tampered`)
      }
    } else {
      // Missing signature. A present-but-invalid signature is already rejected
      // above; here we only decide how to treat the *absence* of one (#157524).
      if (this.requireSignature) {
        throw new Error(`Task ${taskId} rejected: task signature required but missing — refusing to execute unsigned payload (a forged dispatch could run arbitrary commands). Hub must sign task payloads, or unset HIVE_REQUIRE_SIGNATURE / HIVE_SIGNING_SECRET to allow unsigned tasks.`)
      }
      console.warn(`[cloud-client] WARNING: Task ${taskId} has no signature — executing anyway (enforcement off; hub may be outdated). Set HIVE_REQUIRE_SIGNATURE=1 to reject unsigned tasks.`)
    }

    return task
  }

  /**
   * Get pending tasks assigned to this node.
   */
  async getPendingTasks () {
    return this.get('/api/v6/node-agent/tasks/pending')
  }

  /**
   * Create and dispatch a new task (used for chaining — e.g. YT feed → SOM batch).
   */
  async submitTask (taskData) {
    return this.post('/api/v6/nodes/tasks', taskData)
  }

  /**
   * Accept a dispatched task.
   */
  async acceptTask (taskId) {
    return this.post(`/api/v6/node-agent/tasks/${taskId}/accept`, {})
  }

  /**
   * Report task progress.
   */
  async reportProgress (taskId, progress, message) {
    return this.post(`/api/v6/node-agent/tasks/${taskId}/progress`, {
      progress,
      message
    })
  }

  /**
   * Submit final task result.
   */
  async submitResult (taskId, result) {
    return this.post(`/api/v6/node-agent/tasks/${taskId}/result`, result)
  }

  /**
   * Fetch project credentials for a task that needs browser automation.
   * Returns decrypted Playwright storageState (cookies, localStorage).
   */
  async fetchTaskCredentials (taskId) {
    return this.get(`/api/v6/node-agent/tasks/${taskId}/credentials`)
  }

  // ─── HTTP helpers ─────────────────────────────────────────────

  async get (path) {
    return this._requestWithFailover('GET', path)
  }

  async post (path, body) {
    return this._requestWithFailover('POST', path, body)
  }

  /**
   * Wrapper around _request that handles DNS failover.
   * On connection errors, switches to fallback URL after N consecutive failures.
   * Periodically probes primary URL to switch back when it recovers.
   */
  async _requestWithFailover (method, path, body = null) {
    try {
      const result = await this._request(method, path, body)

      // Success on current URL
      if (this.usingFallback) {
        this.requestsSinceFallback++

        // Periodically probe primary to see if it's back
        if (this.requestsSinceFallback % this.primaryProbeInterval === 0) {
          this._probePrimary()
        }
      } else {
        this.consecutivePrimaryFailures = 0
      }

      return result
    } catch (err) {
      // Only failover on connection errors (DNS, refused, timeout without HTTP status)
      if (CloudClient.isConnectionError(err) && this.fallbackUrl && !this.usingFallback) {
        this.consecutivePrimaryFailures++

        if (this.consecutivePrimaryFailures >= this.failoverThreshold) {
          console.log(`[cloud] Primary URL failed ${this.consecutivePrimaryFailures}x — switching to fallback: ${this.fallbackUrl}`)
          this.apiUrl = this.fallbackUrl
          this.usingFallback = true
          this.requestsSinceFallback = 0

          // Retry immediately on fallback
          try {
            return await this._request(method, path, body)
          } catch (fallbackErr) {
            // Fallback also failed — throw original error
            throw err
          }
        }
      }

      throw err
    }
  }

  /**
   * Non-blocking probe of the primary URL.
   * If it succeeds, switch back from fallback to primary.
   */
  _probePrimary () {
    const savedUrl = this.apiUrl
    this.apiUrl = this.primaryUrl

    this._request('POST', '/api/v6/node-agent/heartbeat', {})
      .then(() => {
        console.log(`[cloud] Primary URL recovered — switching back to: ${this.primaryUrl}`)
        this.usingFallback = false
        this.consecutivePrimaryFailures = 0
        // apiUrl is already set to primary
      })
      .catch(() => {
        // Primary still down — stay on fallback
        this.apiUrl = savedUrl
      })
  }

  _request (method, path, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.apiUrl)
      const isHttps = url.protocol === 'https:'
      const lib = isHttps ? https : http

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'IRIS-Node-Daemon/1.0'
        },
        rejectUnauthorized: !this.isLocalDev
      }

      const req = lib.request(options, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data))
            } catch {
              resolve(data)
            }
          } else {
            const err = new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`)
            err.statusCode = res.statusCode
            reject(err)
          }
        })
      })

      req.on('error', reject)
      req.setTimeout(30000, () => {
        req.destroy()
        reject(new Error('Request timeout'))
      })

      if (body) {
        req.write(JSON.stringify(body))
      }
      req.end()
    })
  }
}

module.exports = { CloudClient }
