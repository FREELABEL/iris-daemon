/**
 * iMessage Channel Driver
 *
 * Provides iMessage integration following OpenClaw's channel abstraction pattern.
 * Supports multiple backends:
 * - BlueBubbles: Real-time webhooks + REST API (remote/Docker setups)
 * - Native macOS: chat.db polling + AppleScript sending (zero deps, Mac-only)
 * - imsg CLI: SSH + AppleScript + chat.db polling (future)
 */

const BlueBubblesDriver = require('../drivers/bluebubbles')
const NativeIMessageDriver = require('../drivers/native-imessage')
const EventEmitter = require('events')
const http = require('http')
const https = require('https')

// Wake-word pattern: @heyiris or @iris (case-insensitive)
const MENTION_REGEX = /(?:^|\s)@(?:heyiris|iris)\b/i

class IMessageChannel extends EventEmitter {
  constructor(config) {
    super()
    this.config = config
    this.driver = null
    this.isRunning = false
    this.messageCount = 0
    this.errorCount = 0
    this._mentionCooldowns = new Map() // chatGuid → timestamp
    this._contactCache = new Map()     // senderAddress → { lead, expires }
  }

  /**
   * Start the iMessage channel
   */
  async start() {
    console.log('[imessage] Starting iMessage channel...')

    // Validate config
    if (!this.config.driver) {
      throw new Error('No driver specified (native, bluebubbles, or imsg-cli)')
    }

    // Choose and initialize driver
    const driverType = this.config.driver

    if (driverType === 'bluebubbles') {
      if (!this.config.bluebubbles?.url || !this.config.bluebubbles?.password) {
        throw new Error('BlueBubbles driver requires url and password')
      }
      this.driver = new BlueBubblesDriver(this.config.bluebubbles)
    } else if (driverType === 'native' || driverType === 'native-imessage') {
      if (process.platform !== 'darwin') {
        throw new Error('native-imessage driver requires macOS')
      }
      this.driver = new NativeIMessageDriver(this.config.native || {})
    } else if (driverType === 'imsg-cli') {
      // TODO: Implement imsg CLI driver
      throw new Error('imsg-cli driver not yet implemented')
    } else {
      throw new Error(`Unknown driver: ${driverType}`)
    }

    // Set up message handler
    this.driver.on('message', (event) => this.handleInbound(event))

    // Start driver
    await this.driver.start()
    this.isRunning = true

    console.log(`[imessage] ✓ Channel started with driver: ${driverType}`)

    return {
      driver: driverType,
      status: 'running'
    }
  }

  /**
   * Stop the iMessage channel
   */
  async stop() {
    console.log('[imessage] Stopping iMessage channel...')

    if (this.driver) {
      await this.driver.stop()
      this.driver.removeAllListeners()
      this.driver = null
    }

    this.isRunning = false
    console.log('[imessage] ✓ Channel stopped')
  }

  /**
   * Handle inbound message from driver
   */
  async handleInbound(event) {
    try {
      // Normalize to channel event format
      const normalized = {
        channel: 'imessage',
        conversation_id: event.chatGuid,
        sender_id: event.sender,
        sender_name: event.senderName,
        message_id: event.messageId,
        text: event.text,
        attachments: event.attachments || [],
        timestamp: event.timestamp,
        is_group: event.isGroup || false,
        group_name: event.groupName || null,
        is_from_me: event.isFromMe || false
      }

      console.log(
        `[imessage] New message from ${normalized.sender_id} in ${normalized.is_group ? 'group' : 'DM'}: "${normalized.text.slice(0, 50)}..."`
      )

      // Detect @heyiris / @iris mention
      const hasMention = this.detectMention(normalized.text)

      // Apply policies (groups require mention)
      if (!this.shouldProcess(normalized, hasMention)) {
        return
      }

      // Resolve contact — enrich with lead data if available (needed for both
      // logging and reply policy below)
      const contact = await this.resolveContact(normalized.sender_id)

      // Log every detected mention to the local file IMMEDIATELY, before any
      // reply-policy gate (cooldown, unknown-group-sender). Logging fidelity must
      // never depend on whether we choose to auto-reply — otherwise mentions from
      // unknown group senders, or rapid bursts caught up after downtime, are lost.
      if (hasMention && !normalized.is_from_me) {
        this._logMentionLocally({
          ...normalized,
          lead_id: contact?.id || null,
          lead_name: contact?.name || null
        })
      }

      // Mention cooldown: 60s per chatGuid to prevent rapid-fire auto-replies.
      // (Logging already happened above — this only throttles replies.)
      if (hasMention) {
        const lastMention = this._mentionCooldowns.get(normalized.conversation_id) || 0
        if (Date.now() - lastMention < 60000) {
          console.log(`[imessage] Mention cooldown active for ${normalized.conversation_id.slice(0, 30)} — logged, skipping reply`)
          return
        }
        this._mentionCooldowns.set(normalized.conversation_id, Date.now())
      }

      // In groups, require a known contact before auto-replying (don't reply to
      // strangers). The mention itself was already logged above, so it isn't lost.
      if (hasMention && normalized.is_group && !contact) {
        console.log(`[imessage] Unknown sender ${normalized.sender_id} in group — logged, skipping reply`)
        return
      }

      // Strip wake-word from text before forwarding
      let cleanText = normalized.text
      if (hasMention) {
        cleanText = normalized.text.replace(MENTION_REGEX, '').trim()
      }

      // Fetch conversation context for richer AI responses
      let conversationHistory = []
      if (hasMention && this.driver?.queryMessages) {
        conversationHistory = await this.getConversationContext(
          normalized.conversation_id,
          10,
          normalized.is_group ? 30 : null
        )
      }

      // Build enriched payload
      const enrichedEvent = {
        ...normalized,
        text: cleanText,
        is_mention: hasMention,
        conversation_history: conversationHistory,
        lead_id: contact?.id || null,
        lead_name: contact?.name || null
      }

      // Forward to IRIS API
      await this.forwardToAPI(enrichedEvent)

      this.messageCount++
    } catch (err) {
      console.error(`[imessage] Handle inbound error: ${err.message}`)
      this.errorCount++
    }
  }

  /**
   * Detect @heyiris or @iris mention in text
   */
  detectMention(text) {
    if (!text) return false
    return MENTION_REGEX.test(text)
  }

  /**
   * Get conversation context from chat.db (last N messages)
   */
  async getConversationContext(chatGuid, limit = 10, sinceMins = null) {
    try {
      const messages = await this.driver.queryMessages(chatGuid, limit, sinceMins)
      return messages.map(m => ({
        sender: m.is_from_me ? 'IRIS' : (m.sender_address || 'unknown'),
        text: m.text || '',
        timestamp: m.mac_date
      }))
    } catch (err) {
      console.warn(`[imessage] Failed to get conversation context: ${err.message}`)
      return []
    }
  }

  /**
   * Resolve sender to a known lead/contact via API lookup.
   * Caches results for 5 minutes.
   */
  async resolveContact(senderAddress) {
    if (!senderAddress || senderAddress === 'unknown') return null

    // Check cache
    const cached = this._contactCache.get(senderAddress)
    if (cached && cached.expires > Date.now()) {
      return cached.lead
    }

    try {
      // Normalize phone: strip +, spaces, dashes for search
      const digits = senderAddress.replace(/\D/g, '')
      const last10 = digits.length >= 10 ? digits.slice(-10) : digits

      // Leads API lives on fl-api (raichu)
      const flApiUrl = this.config.flApiUrl || process.env.IRIS_FL_API_URL || 'https://raichu.heyiris.io'
      const data = await this._getJSON(`${flApiUrl}/api/v1/leads?search=${encodeURIComponent(senderAddress)}&per_page=10`)

      // Strict phone match: only accept leads whose phone actually contains our digits
      const leads = data?.data || []
      const matched = leads.find(l => {
        if (!l.phone) return false
        const leadDigits = l.phone.replace(/\D/g, '')
        return leadDigits.includes(last10) || last10.includes(leadDigits.slice(-10))
      })

      const result = matched
        ? { id: matched.id, name: matched.full_name || matched.name || matched.company || matched.email }
        : null

      // Cache for 5 minutes
      this._contactCache.set(senderAddress, { lead: result, expires: Date.now() + 300000 })

      if (result) {
        console.log(`[imessage] Resolved ${senderAddress} → Lead #${result.id} (${result.name})`)
      } else {
        console.log(`[imessage] No lead with matching phone for ${senderAddress} (${leads.length} candidates checked)`)
      }
      return result
    } catch (err) {
      console.warn(`[imessage] Contact resolution failed: ${err.message}`)
      return null
    }
  }

  /**
   * Check if message should be processed based on policies
   */
  shouldProcess(event, hasMention = false) {
    // Skip empty messages
    if (!event.text?.trim() && event.attachments.length === 0) {
      return false
    }

    // CRITICAL: Only respond to messages that mention @heyiris or @iris.
    // Without a mention, NEVER auto-reply — we don't want to send
    // unsolicited messages to people's iMessage conversations.
    if (!hasMention) {
      return false
    }

    // For is_from_me messages with mention: allow through (self-test)
    // Loop safety: IRIS replies never contain @heyiris, plus _recentlySent dedup
    if (event.is_from_me) {
      console.log(`[imessage] Wake-word in own message (self-test mode)`)
    } else {
      console.log(`[imessage] Wake-word detected from ${event.sender_id} in ${event.is_group ? 'group' : 'DM'}`)
    }
    return true
  }

  /**
   * Forward normalized event to IRIS API
   */
  async forwardToAPI(event) {
    const irisApiUrl = this.config.irisApiUrl || process.env.IRIS_API_URL || 'https://freelabel.net'
    const endpoint = `${irisApiUrl}/api/v6/channels/imessage`
    const mode = this.config.mentionMode || process.env.IMESSAGE_MENTION_MODE || 'log'
    // mode: 'log' = instant ack + CRM note (default, fast)
    //        'ai'  = full AI response via async dispatch
    //        'both' = instant ack + async AI reply when ready

    try {
      if (mode === 'ai') {
        // Full AI mode — async: fire and forget, iris-api sends reply via callback
        console.log(`[imessage] Forwarding to ${endpoint} (async AI)...`)
        const payload = {
          ...event,
          async: true,
          callback_url: `http://localhost:3200/api/imessage/direct-send`
        }
        this._postJSON(endpoint, payload).then(data => {
          if (data.ok && data.response) {
            this.sendReply(event.conversation_id, data.response).catch(() => {})
          }
        }).catch(err => {
          console.error(`[imessage] Async forward error: ${err.message}`)
        })
        // Send immediate ack
        await this.sendReply(event.conversation_id, 'Got it — thinking...')
      } else {
        // Log mode (default): instant ack, log to CRM, no AI
        console.log(`[imessage] Logging mention from ${event.sender_id}`)
        const acks = [
          '🫡 Logged. I got you.',
          '✅ Noted — on the board.',
          '📝 Captured. Will surface in your next pulse.',
          '🧠 Heard. Adding to the stack.',
          '💾 Saved. I won\'t forget.',
          '🎯 Got it. Locked in.',
          '⚡ Received loud and clear.',
          '🔒 Logged and tracked.',
          '👁️ Seen. On my radar now.',
          '🛰️ Message received. Over and out.',
        ]
        const ack = acks[Math.floor(Math.random() * acks.length)]
        try {
          await this.sendReply(event.conversation_id, ack)
        } catch (sendErr) {
          console.error(`[imessage] Ack send failed, retrying in 2s: ${sendErr.message}`)
          await new Promise(r => setTimeout(r, 2000))
          await this.sendReply(event.conversation_id, ack)
        }
      }

      // Always log mention to CRM if we have a lead.
      // (Local-file logging already happened upstream in handleInbound, before the
      // reply-policy gates, so it is intentionally not repeated here.)
      if (event.lead_id) {
        this._logMentionToLead(event).catch(err =>
          console.warn(`[imessage] Failed to log mention note: ${err.message}`)
        )
      }
    } catch (err) {
      console.error(`[imessage] Forward error: ${err.message}`)
      this.errorCount++
    }
  }

  /**
   * Log mention to local file for `iris pulse` diary integration
   */
  _logMentionLocally(event) {
    try {
      const fs = require('fs')
      const os = require('os')
      const path = require('path')
      const logDir = path.join(os.homedir(), '.iris', 'mentions')
      fs.mkdirSync(logDir, { recursive: true })

      // Bucket + timestamp by the message's actual SEND time (event.timestamp is
      // unix-ms from the driver), not the processing time. Otherwise messages
      // caught up after downtime get mis-dated (e.g. a 6/3 message filed under 6/4)
      // and `iris imessage mentions --days N` filters on the wrong date.
      const sentAt = event.timestamp ? new Date(event.timestamp) : new Date()
      const when = isNaN(sentAt.getTime()) ? new Date() : sentAt
      const date = when.toISOString().slice(0, 10)
      const logFile = path.join(logDir, `${date}.jsonl`)

      // Capture attachment file paths (screenshots etc.) so downstream tooling
      // (`iris imessage mentions respond`) can actually SEE what the client sent.
      // localPath comes through as ~/Library/Messages/Attachments/... — expand ~
      // here so consumers get a directly-readable absolute path.
      const attachments = (event.attachments || [])
        .filter(a => a && a.localPath)
        .map(a => ({
          name: a.name || null,
          mimeType: a.mimeType || null,
          path: a.localPath.startsWith('~')
            ? path.join(os.homedir(), a.localPath.slice(1))
            : a.localPath
        }))

      const entry = JSON.stringify({
        ts: when.toISOString(),
        sender: event.sender_id,
        lead_id: event.lead_id || null,
        lead_name: event.lead_name || null,
        chat: event.conversation_id,
        is_group: event.is_group,
        text: event.text.slice(0, 500),
        ...(attachments.length ? { attachments } : {})
      })
      fs.appendFileSync(logFile, entry + '\n')
      console.log(`[imessage] Mention logged to ${logFile}`)
    } catch (err) {
      console.warn(`[imessage] Local log failed: ${err.message}`)
    }
  }

  /**
   * Log an @heyiris mention as a note on the lead for CRM tracking.
   * Shows up in `iris leads notes <id>` and pulse history.
   */
  async _logMentionToLead(event, aiResponse) {
    const apiUrl = this.config.flApiUrl || process.env.IRIS_FL_API_URL || 'https://raichu.heyiris.io'
    const channel = event.is_group ? `group (${event.group_name || 'unnamed'})` : 'DM'
    const lines = [
      `**@heyiris mention** via iMessage ${channel}`,
      `**From**: ${event.lead_name || event.sender_id}`,
      `**Message**: ${event.text.slice(0, 300)}`,
    ]
    if (aiResponse) lines.push(`**IRIS Response**: ${aiResponse.slice(0, 500)}`)

    await this._postJSON(`${apiUrl}/api/v1/leads/${event.lead_id}/notes`, {
      note: lines.join('\n'),
      type: 'imessage_mention',
    })

    console.log(`[imessage] Logged mention note on Lead #${event.lead_id}`)
  }

  /**
   * Send a reply message
   */
  async sendReply(conversationId, text) {
    if (!this.driver) {
      throw new Error('Driver not initialized')
    }

    try {
      // Split long messages (iMessage limit is ~20,000 chars but let's be safe)
      const maxLength = 4096
      if (text.length > maxLength) {
        const chunks = this.splitMessage(text, maxLength)
        console.log(`[imessage] Splitting into ${chunks.length} chunks`)

        for (let i = 0; i < chunks.length; i++) {
          await this.driver.sendMessage(conversationId, chunks[i])
          if (i < chunks.length - 1) {
            // Small delay between chunks
            await new Promise(resolve => setTimeout(resolve, 500))
          }
        }
      } else {
        await this.driver.sendMessage(conversationId, text)
      }

      console.log(`[imessage] ✓ Reply sent to ${conversationId.slice(0, 30)}...`)
    } catch (err) {
      console.error(`[imessage] Send reply error: ${err.message}`)
      throw err
    }
  }

  /**
   * Split long message into chunks at natural breakpoints
   */
  splitMessage(text, maxLength) {
    const chunks = []
    let remaining = text

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining)
        break
      }

      // Try to split at paragraph, sentence, or word boundary
      let splitIndex = maxLength

      // Look for paragraph break
      const paragraphIndex = remaining.lastIndexOf('\n\n', maxLength)
      if (paragraphIndex > maxLength * 0.5) {
        splitIndex = paragraphIndex + 2
      } else {
        // Look for sentence break
        const sentenceIndex = Math.max(
          remaining.lastIndexOf('. ', maxLength),
          remaining.lastIndexOf('! ', maxLength),
          remaining.lastIndexOf('? ', maxLength)
        )
        if (sentenceIndex > maxLength * 0.5) {
          splitIndex = sentenceIndex + 2
        } else {
          // Look for word break
          const wordIndex = remaining.lastIndexOf(' ', maxLength)
          if (wordIndex > maxLength * 0.5) {
            splitIndex = wordIndex + 1
          }
        }
      }

      chunks.push(remaining.slice(0, splitIndex))
      remaining = remaining.slice(splitIndex)
    }

    return chunks
  }

  /**
   * Get API auth token from config, env, or SDK .env file
   */
  _getApiToken() {
    if (this._cachedToken) return this._cachedToken
    const token = this.config.apiToken || process.env.IRIS_API_KEY
    if (token) { this._cachedToken = token; return token }
    // Try reading from SDK .env
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

  _getJSON(url) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url)
      const transport = parsed.protocol === 'https:' ? https : http
      const token = this._getApiToken()

      const req = transport.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        },
        timeout: 10000
      }, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          try { resolve(JSON.parse(data)) }
          catch { resolve(null) }
        })
      })

      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')) })
      req.end()
    })
  }

  /**
   * POST JSON using Node built-in http/https (no fetch dependency)
   */
  _postJSON(url, body) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url)
      const transport = parsed.protocol === 'https:' ? https : http
      const payload = JSON.stringify(body)
      const token = this._getApiToken()

      const req = transport.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        },
        timeout: 120000
      }, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          if (res.statusCode >= 400) {
            return reject(new Error(`API returned ${res.statusCode}: ${data.slice(0, 200)}`))
          }
          try { resolve(JSON.parse(data)) }
          catch { resolve({ raw: data }) }
        })
      })

      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')) })
      req.write(payload)
      req.end()
    })
  }

  /**
   * Get channel status
   */
  getStatus() {
    return {
      channel: 'imessage',
      enabled: this.config.enabled,
      running: this.isRunning,
      driver: this.config.driver,
      conversations: this.driver?.getConversationCount() || 0,
      messages_processed: this.messageCount,
      errors: this.errorCount,
      policies: {
        dm_policy: this.config.dmPolicy || 'open',
        group_policy: this.config.groupPolicy || 'closed',
        allowlist_size: this.config.allowlist?.length || 0
      }
    }
  }

  /**
   * Health check
   */
  async healthCheck() {
    if (!this.driver) {
      return false
    }

    try {
      if (this.driver.healthCheck) {
        return await this.driver.healthCheck()
      }
      return this.isRunning
    } catch (err) {
      return false
    }
  }
}

module.exports = IMessageChannel
