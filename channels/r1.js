/**
 * Rabbit R1 Channel Driver
 *
 * Follows the same channel abstraction as channels/imessage.js — a transport
 * driver emits normalized `message` events, the channel resolves them to an
 * agent turn and speaks the answer back.
 *
 * Flow for one push-to-talk press:
 *
 *   R1 PTT ──► R1Driver (WS) ──► handleInbound
 *                                    │
 *                                    ├─► transcribe()   POST /api/v1/transcribe
 *                                    │                  (multipart, glossary-biased)
 *                                    ├─► sendAck()      R1 shows what it heard
 *                                    ├─► forwardToAPI() POST /api/v6/chat/execute
 *                                    │                    or  /api/v6/channels/r1
 *                                    └─► sendReply()    R1 speaks it
 *
 * ── Two agent modes, and why the default is what it is ───────────────────────
 *
 *   'chat'    (default) → POST /api/v6/chat/execute { query, agent_id, user_id }
 *   'channel'           → POST /api/v6/channels/r1  (UnifiedChannelController)
 *
 * The channel route exists already — `POST /v6/channels/{channelType}` is a
 * catch-all for YAML-defined channels and `r1` matches its pattern. But it only
 * resolves to an agent once a channel record is configured server-side, and
 * until that exists it answers 200 with nothing useful. So the default is the
 * mode that works with no server-side change, and 'channel' is opt-in for when
 * the record is wired. Do not flip the default without checking the record.
 */

const EventEmitter = require('events')
const http = require('http')
const https = require('https')
const R1Driver = require('../drivers/r1-openclaw')

class R1Channel extends EventEmitter {
  constructor (config = {}) {
    super()
    this.config = config
    this.driver = null
    this.isRunning = false
    this.messageCount = 0
    this.errorCount = 0
    this.transcribeCount = 0
    this._cachedToken = null
    this._lastError = null
  }

  async start () {
    console.log('[r1] Starting R1 channel...')

    if (!this.config.agentId && (this.config.mode || 'chat') === 'chat') {
      throw new Error('chat mode requires agentId (set R1_AGENT_ID or pass agent_id)')
    }

    this.driver = new R1Driver({
      server: this.config.server || null,
      port: this.config.port || 3201,
      host: this.config.host || '127.0.0.1',
      path: this.config.path || '/r1',
      // 'openclaw' = the wire format real hardware speaks (default).
      // 'native'   = our own shape, for the simulator.
      dialect: this.config.dialect || 'openclaw',
      capture: this.config.capture === true
    })

    this.driver.on('message', (event) => {
      this.handleInbound(event).catch(err => {
        this.errorCount++
        this._lastError = err.message
        console.error(`[r1] Inbound handler error: ${err.message}`)
      })
    })
    this.driver.on('connected', ({ device }) => this.emit('device:connected', device))
    this.driver.on('disconnected', ({ device }) => this.emit('device:disconnected', device))

    await this.driver.start()
    this.isRunning = true

    const mode = this.config.mode || 'chat'
    const dialect = this.config.dialect || 'openclaw'
    console.log(`[r1] ✓ Channel started (mode: ${mode}, dialect: ${dialect}, agent: ${this.config.agentId || 'via channel record'})`)

    return { status: 'running', mode, dialect, path: this.config.path || '/r1' }
  }

  async stop () {
    console.log('[r1] Stopping R1 channel...')
    if (this.driver) {
      await this.driver.stop()
      this.driver.removeAllListeners()
      this.driver = null
    }
    this.isRunning = false
    console.log('[r1] ✓ Channel stopped')
  }

  /**
   * Handle one inbound turn from a device.
   */
  async handleInbound (event) {
    this.messageCount++
    const started = Date.now()

    let text = event.text
    let transcript = null

    // Voice in — resolve audio to text before anything else can use it.
    if (event.kind === 'ptt') {
      if (!event.audio) {
        await this.sendReply(event.deviceId, "I didn't get any audio.", { requestId: event.requestId })
        return
      }
      try {
        transcript = await this.transcribe(event.audio, event.audioFormat)
        text = transcript
      } catch (err) {
        this.errorCount++
        this._lastError = err.message
        console.error(`[r1] Transcription failed: ${err.message}`)
        await this.sendReply(event.deviceId, "I couldn't hear that clearly — try again.", { requestId: event.requestId })
        return
      }
    }

    if (!text || !text.trim()) {
      await this.sendReply(event.deviceId, 'I got silence. Hold the button while you talk.', { requestId: event.requestId })
      return
    }

    console.log(`[r1] ${event.label}: "${text.slice(0, 120)}"`)

    // Acknowledge immediately with what we heard. On a handheld, the gap between
    // releasing the button and hearing an answer is the whole experience — and
    // an agent turn with tools can run 30s+. Showing the transcript first also
    // makes a misheard word obvious before the agent acts on it.
    await this.driver.sendAck(event.deviceId, event.requestId, transcript).catch(() => {})

    try {
      const reply = await this.forwardToAPI({ ...event, text })
      await this.sendReply(event.deviceId, reply, { requestId: event.requestId })
      console.log(`[r1] ✓ Replied in ${Date.now() - started}ms`)
    } catch (err) {
      this.errorCount++
      this._lastError = err.message
      console.error(`[r1] Agent call failed: ${err.message}`)
      await this.sendReply(event.deviceId, `Something broke on my end: ${err.message}`, { requestId: event.requestId })
    }
  }

  /**
   * Audio → text via the canonical platform endpoint.
   *
   * Sent as multipart because that is what the endpoint validates (`file`), and
   * with bloq_id because that is what applies the PHI policy — a request without
   * it is logged server-side as unprotected. If this bloq is marked PHI the
   * endpoint returns 422 rather than shipping the audio to a cloud provider,
   * which is the correct outcome, not a bug to work around.
   */
  async transcribe (audioBase64, format = 'wav') {
    const buffer = Buffer.from(audioBase64, 'base64')

    // The endpoint caps uploads at 25MB. Say so here rather than letting it
    // come back as an opaque 422.
    if (buffer.length > 25 * 1024 * 1024) {
      throw new Error(`clip too large (${(buffer.length / 1048576).toFixed(1)}MB, limit 25MB)`)
    }

    const base = this.config.irisApiUrl || process.env.IRIS_API_URL || 'https://freelabel.net'
    const fields = { provider: this.config.transcribeProvider || 'auto' }
    if (this.config.bloqId) fields.bloq_id = String(this.config.bloqId)
    if (this.config.language) fields.language = this.config.language
    if (this.config.glossary) fields.prompt = this.config.glossary
    if (this.config.userId) fields.user_id = String(this.config.userId)

    const result = await this._postMultipart(
      `${base}/api/v1/transcribe`,
      fields,
      { name: 'file', filename: `ptt.${format}`, contentType: this._mimeFor(format), buffer }
    )

    const data = result?.data || result
    const text = data?.text || data?.transcript || data?.transcription

    if (!text) {
      throw new Error(`no transcript in response: ${JSON.stringify(result).slice(0, 200)}`)
    }

    this.transcribeCount++
    return String(text).trim()
  }

  /**
   * Run the agent turn. Returns the reply text.
   */
  async forwardToAPI (event) {
    const base = this.config.irisApiUrl || process.env.IRIS_API_URL || 'https://freelabel.net'
    const mode = this.config.mode || 'chat'

    if (mode === 'channel') {
      const payload = {
        channel: 'r1',
        conversation_id: event.deviceId,
        sender_id: event.deviceId,
        sender_name: event.label,
        message_id: event.requestId,
        text: event.text,
        ...(event.image ? { image: event.image } : {})
      }
      const res = await this._postJSON(`${base}/api/v6/channels/r1`, payload)
      const reply = res?.response || res?.reply || res?.message
      if (!reply) {
        // A channel with no record configured answers 200 and nothing else.
        // Name that, instead of speaking an empty string at the user.
        throw new Error('channel returned no reply — is the r1 channel record configured server-side?')
      }
      return reply
    }

    const agentId = event.agentId || this.config.agentId
    const res = await this._postJSON(`${base}/api/v6/chat/execute`, {
      query: event.text,
      agent_id: agentId,
      ...(this.config.userId ? { user_id: this.config.userId } : {}),
      ...(this.config.bloqId ? { bloq_id: this.config.bloqId } : {}),
      // One conversation per device, so the R1 keeps context across presses.
      thread_id: `r1:${event.deviceId}`
    })

    // /chat/execute is ASYNC. It queues RunChatExecuteJob and returns 202 with a
    // workflow_id — the ANSWER arrives later, over Pusher or by polling.
    //
    // This branch is checked FIRST and by workflow_id, not by "is there a message
    // field", because the dispatch ack carries `message: "Chat execution dispatched.
    // Subscribe to workflow channel for updates."` — which reads as a perfectly
    // valid reply to a naive extractor and gets SPOKEN OUT LOUD to the user. The
    // device says something fluent and wrong, and nothing anywhere reports an error.
    if (res?.workflow_id) {
      return await this._awaitResult(base, res.workflow_id)
    }

    const reply = res?.response || res?.data?.response || res?.message || res?.data?.message
    if (!reply) throw new Error(`no reply in response: ${JSON.stringify(res).slice(0, 200)}`)
    return String(reply)
  }

  /**
   * Poll for an async chat result until it completes.
   *
   * GET /api/v6/chat/{workflowId}/result answers 404 {status:'pending'} until the
   * worker finishes, so a 404 here is "not yet", not "missing" — treating it as an
   * error would abandon every turn that takes longer than one poll.
   */
  async _awaitResult (base, workflowId) {
    const timeoutMs = this.config.agentTimeoutMs || 120000
    const intervalMs = this.config.pollIntervalMs || 1200
    const deadline = Date.now() + timeoutMs
    let last = null

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, intervalMs))

      const res = await this._request(`${base}/api/v6/chat/${workflowId}/result`, {
        method: 'GET',
        timeout: 15000,
        tolerate404: true
      }).catch(err => ({ _error: err.message }))

      if (res?._error) { last = res._error; continue }

      const status = String(res?.status || '').toLowerCase()
      if (status === 'pending' || status === 'queued' || status === 'running') { last = status; continue }

      const content = res?.content || res?.response || res?.result?.content
      if (content && String(content).trim()) return String(content).trim()

      if (status === 'failed' || status === 'error') {
        throw new Error(`agent run failed${res?.message ? `: ${res.message}` : ''}`)
      }

      // Completed with nothing to say is still a failure to answer — do not
      // return an empty string for the device to speak as silence.
      if (status === 'completed' || status === 'success') {
        throw new Error('agent finished but returned no content')
      }

      last = status || JSON.stringify(res).slice(0, 120)
    }

    throw new Error(`agent timed out after ${Math.round(timeoutMs / 1000)}s (last status: ${last})`)
  }

  /**
   * Speak text back to a device.
   *
   * Long agent answers are truncated rather than streamed. A 2.88" screen and a
   * TTS voice both punish a wall of text, and the full answer is already in the
   * session on the server if the user wants it elsewhere.
   */
  async sendReply (deviceId, text, opts = {}) {
    if (!this.driver) throw new Error('channel not running')

    const limit = this.config.maxReplyChars || 900
    let out = String(text).trim()
    if (out.length > limit) out = out.slice(0, limit - 1).trimEnd() + '…'

    try {
      return await this.driver.sendMessage(deviceId, out, {
        requestId: opts.requestId,
        speak: opts.speak !== false
      })
    } catch (err) {
      // The device dropped off LTE mid-turn. Normal; not an error worth counting.
      console.warn(`[r1] Reply undelivered to ${deviceId}: ${err.message}`)
      return { delivered_to: 0 }
    }
  }

  // ─── HTTP helpers (Node built-ins, no fetch dependency — matches imessage.js) ─

  _getApiToken () {
    if (this._cachedToken) return this._cachedToken
    const token = this.config.apiToken || process.env.IRIS_API_KEY
    if (token) { this._cachedToken = token; return token }
    try {
      const fs = require('fs')
      const os = require('os')
      const path = require('path')
      const envFile = fs.readFileSync(path.join(os.homedir(), '.iris', 'sdk', '.env'), 'utf8')
      const match = envFile.match(/IRIS_API_KEY=(.+)/)
      if (match) { this._cachedToken = match[1].trim(); return this._cachedToken }
    } catch { /* no SDK .env */ }
    return null
  }

  _mimeFor (format) {
    return {
      wav: 'audio/wav',
      m4a: 'audio/mp4',
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      webm: 'audio/webm',
      flac: 'audio/flac'
    }[String(format).toLowerCase()] || 'application/octet-stream'
  }

  _request (url, { method, headers, body, timeout = 120000, tolerate404 = false }) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url)
      const transport = parsed.protocol === 'https:' ? https : http
      const token = this._getApiToken()

      const req = transport.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers
        },
        timeout
      }, (res) => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          // A 404 from the result endpoint means "not finished yet", not "gone".
          if (res.statusCode >= 400 && !(tolerate404 && res.statusCode === 404)) {
            return reject(new Error(`${parsed.pathname} returned ${res.statusCode}: ${data.slice(0, 300)}`))
          }
          try { resolve(JSON.parse(data)) } catch { resolve({ raw: data }) }
        })
      })

      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')) })
      if (body) req.write(body)
      req.end()
    })
  }

  _postJSON (url, body) {
    const payload = JSON.stringify(body)
    return this._request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      body: payload
    })
  }

  /**
   * Minimal multipart/form-data encoder. The bridge has `form-data` available,
   * but it streams — and the audio is already fully in memory as one buffer, so
   * building the body directly avoids a stream round-trip for no benefit.
   */
  _postMultipart (url, fields, file) {
    const boundary = `----IRISr1${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
    const parts = []

    for (const [key, value] of Object.entries(fields)) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
      ))
    }

    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
      `Content-Type: ${file.contentType}\r\n\r\n`
    ))
    parts.push(file.buffer)
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))

    const body = Buffer.concat(parts)
    return this._request(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      },
      body
    })
  }

  // ─── Introspection ─────────────────────────────────────────────────────────

  getStatus () {
    return {
      channel: 'r1',
      enabled: this.config.enabled !== false,
      running: this.isRunning,
      mode: this.config.mode || 'chat',
      dialect: this.config.dialect || 'openclaw',
      agent_id: this.config.agentId || null,
      bloq_id: this.config.bloqId || null,
      path: this.config.path || '/r1',
      devices_connected: this.driver?.getConversationCount() || 0,
      sessions: this.driver?.getSessions() || [],
      messages_processed: this.messageCount,
      transcriptions: this.transcribeCount,
      rejected_connections: this.driver?.rejectedCount || 0,
      errors: this.errorCount,
      last_error: this._lastError
    }
  }

  async healthCheck () {
    if (!this.driver) return false
    try { return await this.driver.healthCheck() } catch { return false }
  }
}

module.exports = R1Channel
