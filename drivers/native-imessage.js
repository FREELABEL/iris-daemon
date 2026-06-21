/**
 * Native macOS iMessage Driver
 *
 * Zero-dependency driver using macOS built-ins:
 * - Receives messages by polling ~/Library/Messages/chat.db via sqlite3 CLI
 * - Sends messages via osascript (AppleScript → Messages.app)
 *
 * Requirements:
 *   - macOS only
 *   - Full Disk Access granted to Terminal / Node process
 *   - Messages.app installed (always true on macOS)
 */

const EventEmitter = require('events')
const { execFile } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

// macOS Core Data epoch offset: seconds between 1970-01-01 and 2001-01-01
const MACOS_EPOCH_OFFSET_MS = 978307200000

function macDateToUnixMs(macDate) {
  const d = parseInt(macDate)
  if (!d || isNaN(d)) return Date.now()
  // Modern macOS stores nanoseconds; older stores seconds
  if (d > 1e15) {
    return Math.floor(d / 1000000) + MACOS_EPOCH_OFFSET_MS
  }
  return (d * 1000) + MACOS_EPOCH_OFFSET_MS
}

class NativeIMessageDriver extends EventEmitter {
  constructor(config = {}) {
    super()
    this.config = config
    this.chatDbPath = config.chatDbPath ||
      path.join(os.homedir(), 'Library', 'Messages', 'chat.db')
    this.pollInterval = config.pollInterval || 3000
    this.lastMessageRowId = 0
    this.conversations = new Map()
    this._pollTimer = null
    this._running = false
    this._recentlySent = new Set()  // track texts we sent to prevent loop pickup
    this._statePath = path.join(
      os.homedir(), '.iris', 'bridge', 'native-imessage-state.json'
    )
  }

  /**
   * Start the driver - validate access, load state, begin polling
   */
  async start() {
    console.log('[native-imessage] Starting native macOS driver...')

    // Platform check
    if (process.platform !== 'darwin') {
      throw new Error('Native iMessage driver requires macOS')
    }

    // Check chat.db exists
    if (!fs.existsSync(this.chatDbPath)) {
      throw new Error(
        `chat.db not found at ${this.chatDbPath}. ` +
        'Is Messages.app set up on this Mac?'
      )
    }

    // Test DB access
    try {
      const rows = await this._runSqlite3('SELECT MAX(ROWID) AS max_id FROM message')
      const maxId = rows[0]?.max_id || 0
      console.log(`[native-imessage] ✓ chat.db accessible (${maxId} messages)`)

      // Load persisted state, then guard against replaying a backlog. A stale state
      // file (from a run hours/days ago) would make the first poll match EVERY message
      // since then and auto-reply to all of them — the #137256 incident (28 acks blasted
      // to 9 contacts in 5s the instant the channel was enabled). Only resume from
      // persisted state when it's within a small window of the current max; otherwise
      // snap to the latest message so we NEVER replay a backlog on start.
      this._loadState()
      const BACKLOG_REPLAY_WINDOW = 20
      const replayOptIn = process.env.IMESSAGE_REPLAY_BACKLOG === '1'
      if (this.lastMessageRowId === 0) {
        this.lastMessageRowId = maxId
        console.log(`[native-imessage] Starting from message #${maxId} (no history replay)`)
      } else if (!replayOptIn && this.lastMessageRowId < maxId - BACKLOG_REPLAY_WINDOW) {
        const behind = maxId - this.lastMessageRowId
        console.log(`[native-imessage] Persisted #${this.lastMessageRowId} is ${behind} messages behind — snapping to #${maxId} to avoid a startup backlog blast (set IMESSAGE_REPLAY_BACKLOG=1 to replay)`)
        this.lastMessageRowId = maxId
      } else {
        console.log(`[native-imessage] Resuming from message #${this.lastMessageRowId}`)
      }
    } catch (err) {
      if (err.code === 'EFULL_DISK_ACCESS') {
        throw err
      }
      throw new Error(`Failed to access chat.db: ${err.message}`)
    }

    // Load initial chat inventory
    await this._loadChats()

    // Start polling
    this._running = true
    this._schedulePoll()

    console.log(`[native-imessage] ✓ Polling every ${this.pollInterval}ms`)
    console.log(`[native-imessage] ✓ Tracking ${this.conversations.size} conversations`)

    return true
  }

  /**
   * Stop the driver - halt polling, save state
   */
  async stop() {
    console.log('[native-imessage] Stopping driver...')
    this._running = false

    if (this._pollTimer) {
      clearTimeout(this._pollTimer)
      this._pollTimer = null
    }

    this._saveState()
    this.conversations.clear()
    console.log('[native-imessage] ✓ Stopped')
  }

  /**
   * Load chat list from chat.db
   */
  async _loadChats() {
    try {
      const rows = await this._runSqlite3(
        `SELECT c.guid, c.display_name, c.chat_identifier, c.room_name,
          (SELECT COUNT(*) FROM chat_handle_join chj WHERE chj.chat_id = c.ROWID) AS participant_count
         FROM chat c
         ORDER BY c.ROWID DESC LIMIT 50`
      )

      rows.forEach(row => {
        const isGroup = row.participant_count > 1 || (row.room_name && row.room_name.length > 0)
        this.conversations.set(row.guid, {
          guid: row.guid,
          displayName: row.display_name || row.chat_identifier || row.guid,
          isGroup
        })
      })
    } catch (err) {
      console.warn(`[native-imessage] Failed to load chats: ${err.message}`)
    }
  }

  /**
   * Schedule the next poll cycle (recursive setTimeout, not setInterval)
   */
  async _schedulePoll() {
    if (!this._running) return

    try {
      await this._poll()
    } catch (err) {
      if (err.message && err.message.includes('database is locked')) {
        console.warn('[native-imessage] DB locked, will retry next poll')
      } else {
        console.error(`[native-imessage] Poll error: ${err.message}`)
      }
    }

    if (this._running) {
      this._pollTimer = setTimeout(() => this._schedulePoll(), this.pollInterval)
    }
  }

  /**
   * Poll chat.db for new messages
   */
  async _poll() {
    const sql = `
      SELECT
        m.ROWID                  AS rowid,
        m.guid                   AS message_guid,
        m.text                   AS text,
        m.date                   AS mac_date,
        m.is_from_me             AS is_from_me,
        m.cache_has_attachments  AS has_attachments,
        h.id                     AS sender_address,
        c.guid                   AS chat_guid,
        c.display_name           AS group_name,
        c.room_name              AS room_name,
        c.chat_identifier        AS chat_identifier,
        hex(m.attributedBody)    AS body_hex,
        (SELECT COUNT(*) FROM chat_handle_join chj WHERE chj.chat_id = c.ROWID) AS participant_count
      FROM message m
      INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      INNER JOIN chat c ON c.ROWID = cmj.chat_id
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.ROWID > ${this.lastMessageRowId}
        AND m.item_type = 0
        AND m.is_empty = 0
        AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)
      ORDER BY m.ROWID ASC
      LIMIT 100`

    const rows = await this._runSqlite3(sql)
    if (rows.length === 0) return

    console.log(`[native-imessage] Found ${rows.length} new message(s)`)

    for (const row of rows) {
      // Fetch attachments if flagged
      let attachments = []
      if (row.has_attachments) {
        attachments = await this._getAttachments(row.rowid)
      }

      const event = this.normalizeMessage(row, attachments)

      // Update high-water mark
      this.lastMessageRowId = row.rowid

      // Skip messages we recently sent (prevents feedback loops)
      const dedupKey = `${event.chatGuid}:${event.text.slice(0, 100)}`
      if (this._recentlySent.has(dedupKey)) {
        console.log(`[native-imessage] Skipping own sent message`)
        continue
      }

      // Emit to channel handler
      this.emit('message', event)
    }

    // Persist state after processing batch
    this._saveState()
  }

  /**
   * Get attachments for a message
   */
  async _getAttachments(messageRowId) {
    try {
      return await this._runSqlite3(
        `SELECT a.guid, a.filename, a.transfer_name, a.mime_type, a.total_bytes
         FROM attachment a
         INNER JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
         WHERE maj.message_id = ${messageRowId}`
      )
    } catch (err) {
      console.warn(`[native-imessage] Failed to get attachments: ${err.message}`)
      return []
    }
  }

  /**
   * Normalize a chat.db row to our standard message format
   */
  /**
   * Parse NSAttributedString hex blob to extract plain text.
   * Modern macOS stores message content in attributedBody instead of text.
   */
  _parseAttributedBody(hexStr) {
    if (!hexStr) return ''
    try {
      const buf = Buffer.from(hexStr, 'hex')
      const text = buf.toString('utf-8', 0, buf.length)
      const markerIdx = text.indexOf('NSString')
      if (markerIdx === -1) return ''
      const afterMarker = buf.indexOf(0x2b, markerIdx + 8)
      if (afterMarker === -1) return ''

      // Length is a typedstream varint, NOT a single byte:
      //   < 0x80        -> that byte is the length
      //   0x81 + uint16 -> length is the next 2 bytes (LE)
      //   0x82 + uint32 -> length is the next 4 bytes (LE)
      // Reading only one byte truncated any message >= 128 bytes.
      let strLen
      let start
      const lenByte = buf[afterMarker + 1]
      if (lenByte === 0x81) {
        strLen = buf.readUInt16LE(afterMarker + 2)
        start = afterMarker + 4
      } else if (lenByte === 0x82) {
        strLen = buf.readUInt32LE(afterMarker + 2)
        start = afterMarker + 6
      } else {
        strLen = lenByte
        start = afterMarker + 2
      }
      if (!strLen) return ''
      const end = start + strLen
      if (end > buf.length) return ''

      // Decode as UTF-8 and strip only true control chars (keep \t and \n).
      // Do NOT strip 0x80-0xFF — those are UTF-8 continuation bytes (emoji/accents).
      return buf.subarray(start, end).toString('utf-8')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
        .trim()
    } catch {
      return ''
    }
  }

  normalizeMessage(row, attachments = []) {
    const isGroup = row.participant_count > 1 ||
      (row.room_name && row.room_name.length > 0)
    const chatGuid = row.chat_guid

    // Track conversation
    if (chatGuid && !this.conversations.has(chatGuid)) {
      this.conversations.set(chatGuid, {
        guid: chatGuid,
        displayName: row.group_name || row.chat_identifier || row.sender_address,
        isGroup
      })
    }

    // Prefer text column, fall back to parsing attributedBody
    let msgText = row.text || ''
    if (!msgText && row.body_hex) {
      msgText = this._parseAttributedBody(row.body_hex)
    }

    return {
      chatGuid,
      messageId: row.message_guid,
      sender: row.sender_address || 'unknown',
      senderName: row.sender_address || 'unknown',
      text: msgText,
      attachments: attachments.map(a => ({
        guid: a.guid,
        name: a.transfer_name || path.basename(a.filename || ''),
        mimeType: a.mime_type || 'application/octet-stream',
        size: a.total_bytes || 0,
        localPath: a.filename
      })),
      timestamp: macDateToUnixMs(row.mac_date),
      isGroup,
      groupName: isGroup ? (row.group_name || row.room_name || 'Group Chat') : null,
      isFromMe: !!row.is_from_me,
      hasAttachments: attachments.length > 0
    }
  }

  /**
   * Send a text message via AppleScript
   */
  async sendMessage(chatGuid, text, options = {}) {
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

    console.log(`[native-imessage] Sending to ${chatGuid.slice(0, 30)}...`)

    const script =
      `tell application "Messages"\n` +
      `  send "${escaped}" to chat id "${chatGuid}"\n` +
      `end tell`

    await this._runOsascript(script)

    // Track sent text to avoid picking it up in the next poll
    const key = `${chatGuid}:${text.slice(0, 100)}`
    this._recentlySent.add(key)
    setTimeout(() => this._recentlySent.delete(key), 30000)

    console.log(`[native-imessage] ✓ Sent message (${text.length} chars)`)
    return { ok: true }
  }

  /**
   * Resolve a phone number or email to a chat GUID via chat.db lookup.
   * Returns the chat GUID string, or null if not found.
   */
  async resolveHandleToGuid(handle) {
    const digits = handle.replace(/\D/g, '')
    const lower = handle.toLowerCase()

    // Match by stripped digits (phone) or lowercase email
    const conditions = []
    if (digits.length >= 7) {
      conditions.push(
        `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(h.id, '+', ''), '-', ''), ' ', ''), '(', ''), ')', '') LIKE '%${digits}%'`
      )
    }
    conditions.push(`LOWER(h.id) LIKE '%${lower.replace(/'/g, "''").replace(/%/g, '')}%'`)

    const sql = `
      SELECT c.guid AS chat_guid, c.chat_identifier, h.id AS handle_id,
        MAX(m.date) AS last_date
      FROM chat c
      INNER JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
      INNER JOIN handle h ON h.ROWID = chj.handle_id
      LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
      LEFT JOIN message m ON m.ROWID = cmj.message_id
      WHERE (${conditions.join(' OR ')})
        AND c.guid LIKE 'iMessage;%'
      GROUP BY c.guid
      ORDER BY last_date DESC
      LIMIT 1`

    const rows = await this._runSqlite3(sql)
    if (rows.length > 0) {
      console.log(`[native-imessage] Resolved "${handle}" → ${rows[0].chat_guid}`)
      return rows[0].chat_guid
    }

    // Fallback: try SMS chats too
    const smsSql = sql.replace("AND c.guid LIKE 'iMessage;%'", "AND c.guid LIKE 'SMS;%'")
    const smsRows = await this._runSqlite3(smsSql)
    if (smsRows.length > 0) {
      console.log(`[native-imessage] Resolved "${handle}" → ${smsRows[0].chat_guid} (SMS)`)
      return smsRows[0].chat_guid
    }

    console.log(`[native-imessage] Could not resolve "${handle}" in chat.db`)
    return null
  }

  /**
   * Send a message by phone number or email — resolves to chat GUID first,
   * falls back to AppleScript buddy-based send if no existing chat found.
   */
  async sendToHandle(handle, text, options = {}) {
    // Try resolving via chat.db first (existing conversation)
    const chatGuid = await this.resolveHandleToGuid(handle)
    if (chatGuid) {
      return this.sendMessage(chatGuid, text, options)
    }

    // Fallback: use AppleScript participant-based send (works for new conversations too)
    console.log(`[native-imessage] No existing chat found — sending via buddy lookup for "${handle}"`)
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const script =
      `tell application "Messages"\n` +
      `  set targetService to 1st account whose service type = iMessage\n` +
      `  set targetBuddy to participant "${handle}" of targetService\n` +
      `  send "${escaped}" to targetBuddy\n` +
      `end tell`

    await this._runOsascript(script)

    const key = `${handle}:${text.slice(0, 100)}`
    this._recentlySent.add(key)
    setTimeout(() => this._recentlySent.delete(key), 30000)

    console.log(`[native-imessage] ✓ Sent via buddy lookup (${text.length} chars)`)
    return { ok: true, method: 'buddy_lookup' }
  }

  /**
   * Send a file attachment via AppleScript
   */
  async sendAttachment(chatGuid, attachmentPath, text = '', options = {}) {
    const resolvedPath = path.resolve(attachmentPath)
    const escapedPath = resolvedPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

    console.log(`[native-imessage] Sending attachment: ${path.basename(resolvedPath)}`)

    const script =
      `tell application "Messages"\n` +
      `  set theFile to (POSIX file "${escapedPath}") as alias\n` +
      `  send theFile to chat id "${chatGuid}"\n` +
      `end tell`

    await this._runOsascript(script)

    console.log(`[native-imessage] ✓ Sent attachment`)

    // Send accompanying text as separate message if provided
    if (text) {
      await new Promise(resolve => setTimeout(resolve, 300))
      await this.sendMessage(chatGuid, text, options)
    }

    return { ok: true }
  }

  /**
   * Query recent messages in a chat for conversation context.
   * Returns rows with: text, sender_address, is_from_me, mac_date
   *
   * @param {string} chatGuid - The chat GUID to query
   * @param {number} limit - Max messages to return (default 10)
   * @param {number|null} sinceMins - Only return messages from last N minutes (null = no limit)
   */
  async queryMessages(chatGuid, limit = 10, sinceMins = null) {
    const escapedGuid = chatGuid.replace(/'/g, "''")
    let timeFilter = ''
    if (sinceMins) {
      // Convert minutes to macOS Core Data timestamp (nanoseconds since 2001-01-01)
      const cutoffUnixMs = Date.now() - (sinceMins * 60 * 1000)
      const cutoffMacNs = (cutoffUnixMs - 978307200000) * 1000000
      timeFilter = `AND m.date > ${cutoffMacNs}`
    }

    const sql = `
      SELECT
        m.text            AS text,
        m.is_from_me      AS is_from_me,
        m.date            AS mac_date,
        h.id              AS sender_address,
        hex(m.attributedBody) AS body_hex
      FROM message m
      INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      INNER JOIN chat c ON c.ROWID = cmj.chat_id
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE c.guid = '${escapedGuid}'
        AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)
        AND m.is_empty = 0
        ${timeFilter}
      ORDER BY m.ROWID DESC
      LIMIT ${limit}`

    const rows = await this._runSqlite3(sql)
    // Return in chronological order (oldest first)
    return rows.reverse()
  }

  /**
   * Health check - verify we can read chat.db
   */
  async healthCheck() {
    try {
      await this._runSqlite3('SELECT 1 FROM message LIMIT 1')
      return true
    } catch {
      return false
    }
  }

  /**
   * Get conversation count
   */
  getConversationCount() {
    return this.conversations.size
  }

  // ── Internal helpers ──────────────────────────────────────────────

  /**
   * Execute a query via the system sqlite3 CLI
   */
  _runSqlite3(sql) {
    return new Promise((resolve, reject) => {
      const args = [
        '-readonly',
        '-json',
        '-bail',
        this.chatDbPath,
        sql
      ]

      execFile('/usr/bin/sqlite3', args, { timeout: 10000 }, (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message || '').trim()
          if (msg.includes('unable to open') || msg.includes('authorization denied')) {
            const fda = new Error(
              'Cannot read chat.db. Grant Full Disk Access to Terminal (or your app) ' +
              'in System Settings > Privacy & Security > Full Disk Access, then restart.'
            )
            fda.code = 'EFULL_DISK_ACCESS'
            return reject(fda)
          }
          return reject(new Error(`sqlite3: ${msg.slice(0, 300)}`))
        }

        try {
          const result = stdout.trim() ? JSON.parse(stdout) : []
          resolve(result)
        } catch (parseErr) {
          reject(new Error(`sqlite3 JSON parse: ${parseErr.message}`))
        }
      })
    })
  }

  /**
   * Execute AppleScript via osascript
   */
  _runOsascript(script) {
    return new Promise((resolve, reject) => {
      execFile('/usr/bin/osascript', ['-e', script], { timeout: 15000 }, (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message || '').trim()
          if (msg.includes('-1728') || msg.includes('got an error')) {
            return reject(new Error(
              'Messages.app could not find that chat. ' +
              'Verify the chat GUID exists and Messages.app is signed in.'
            ))
          }
          return reject(new Error(`osascript: ${msg.slice(0, 300)}`))
        }
        resolve(stdout.trim())
      })
    })
  }

  /**
   * Load persisted state from disk
   */
  _loadState() {
    try {
      const raw = fs.readFileSync(this._statePath, 'utf8')
      const data = JSON.parse(raw)
      if (data.lastMessageRowId && Number.isInteger(data.lastMessageRowId)) {
        this.lastMessageRowId = data.lastMessageRowId
      }
    } catch {
      // No state file or corrupt - will use DB max
    }
  }

  /**
   * Save state to disk
   */
  _saveState() {
    try {
      const dir = path.dirname(this._statePath)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(this._statePath, JSON.stringify({
        lastMessageRowId: this.lastMessageRowId,
        updatedAt: new Date().toISOString()
      }), 'utf8')
    } catch (err) {
      console.warn(`[native-imessage] Failed to save state: ${err.message}`)
    }
  }
}

module.exports = NativeIMessageDriver
