/**
 * Rabbit R1 Driver — WebSocket gateway for handheld agent clients.
 *
 * The R1 has no general-purpose app runtime worth targeting (Helio P35 / 4 GB /
 * no NPU), so it is a THIN CLIENT: it captures push-to-talk audio and camera
 * frames, ships them here, and speaks the reply. All inference happens upstream.
 *
 * ── What this is, exactly ────────────────────────────────────────────────────
 * An OpenClaw-PROTOCOL gateway backed by IRIS. Rabbit's OpenClaw integration
 * lets an R1 point at a gateway URL you control; we answer that protocol so the
 * stock client connects unmodified. Nothing OpenClaw runs in the path and no
 * Rabbit cloud is called — the turn is served by IRIS agents.
 *
 * The wire format lives ENTIRELY in drivers/r1-dialects.js. This file deals in
 * canonical events and never sees a frame. Set `dialect: 'openclaw'` (default)
 * for real hardware, `'native'` for the simulator.
 */

const EventEmitter = require('events')
const crypto = require('crypto')
const { WebSocketServer } = require('ws')
const devices = require('../lib/r1-devices')
const dialects = require('./r1-dialects')

// An R1 PTT clip is seconds of speech, and a camera frame is one JPEG. Anything
// past a few MB is not a handheld talking to us.
const MAX_FRAME_BYTES = 8 * 1024 * 1024
const HEARTBEAT_MS = 30000

class R1Driver extends EventEmitter {
  constructor (config = {}) {
    super()
    this.config = config
    this.wss = null
    this.server = null
    this.sessions = new Map() // sessionId → { ws, deviceId, label, alive, connectedAt }
    this.messageCount = 0
    this.rejectedCount = 0
    this._heartbeat = null

    // The wire format. Everything below this line is canonical events.
    this.dialect = dialects.get(config.dialect || 'openclaw')
    this.capture = config.capture === true || process.env.R1_CAPTURE === '1'
    if (this.capture) {
      console.log(`[r1] Frame capture ON → ${dialects.CAPTURE_PATH}`)
    }
  }

  /**
   * Start the gateway.
   *
   * Pass `config.server` to attach to the bridge's existing HTTP server (one
   * port, and it inherits whatever Tailscale/localhost bind that server chose).
   * Otherwise a standalone listener is opened on config.port.
   */
  async start () {
    const path = this.config.path || '/r1'

    if (this.config.server) {
      this.wss = new WebSocketServer({ server: this.config.server, path, maxPayload: MAX_FRAME_BYTES })
      console.log(`[r1] Gateway attached to bridge HTTP server at ${path}`)
    } else {
      const port = this.config.port || 3201
      const host = this.config.host || '127.0.0.1'
      this.wss = new WebSocketServer({ port, host, path, maxPayload: MAX_FRAME_BYTES })
      await new Promise((resolve, reject) => {
        this.wss.once('listening', resolve)
        this.wss.once('error', reject)
      })
      console.log(`[r1] Gateway listening on ws://${host}:${port}${path}`)
    }

    this.wss.on('connection', (ws, req) => this._onConnection(ws, req))
    this.wss.on('error', (err) => console.error(`[r1] Server error: ${err.message}`))

    // A handheld on LTE drops off constantly and half-open sockets pile up
    // silently. Ping every 30s and reap anything that missed a round.
    this._heartbeat = setInterval(() => {
      for (const [sessionId, session] of this.sessions) {
        if (!session.alive) {
          console.log(`[r1] Reaping dead session ${sessionId} (${session.deviceId})`)
          try { session.ws.terminate() } catch { /* already gone */ }
          this.sessions.delete(sessionId)
          continue
        }
        session.alive = false
        try { session.ws.ping() } catch { /* next sweep reaps it */ }
      }
    }, HEARTBEAT_MS)
    if (this._heartbeat.unref) this._heartbeat.unref()

    return { status: 'running', path }
  }

  async stop () {
    if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null }

    for (const session of this.sessions.values()) {
      try { session.ws.close(1001, 'gateway shutting down') } catch { /* ignore */ }
    }
    this.sessions.clear()

    if (this.wss) {
      await new Promise((resolve) => this.wss.close(resolve))
      this.wss = null
    }
    console.log('[r1] Gateway stopped')
  }

  // ─── Connection lifecycle ──────────────────────────────────────────────────

  _onConnection (ws, req) {
    const sessionId = crypto.randomUUID()
    const peer = req.socket.remoteAddress
    let device = null

    ws.on('pong', () => {
      const session = this.sessions.get(sessionId)
      if (session) session.alive = true
    })

    // A socket that never says hello is not a device — it is a port scanner.
    // Give it 10 seconds and drop it.
    const helloTimer = setTimeout(() => {
      if (!device) {
        this.rejectedCount++
        console.warn(`[r1] No hello within 10s from ${peer} — closing`)
        try { ws.close(4408, 'hello timeout') } catch { /* ignore */ }
      }
    }, 10000)
    if (helloTimer.unref) helloTimer.unref()

    ws.on('message', async (raw) => {
      if (this.capture) dialects.captureFrame('in', raw)

      let frame
      try {
        frame = this._decodeFrame(raw)
      } catch (err) {
        // Under an unverified dialect this is the EXPECTED first failure, and
        // the frame that caused it is the thing worth having. Log it loudly and
        // keep it, rather than answering 'bad frame' into a void.
        console.warn(`[r1] Undecodable frame from ${peer} (${this.dialect.name}): ${err.message}`)
        if (!this.capture) dialects.captureFrame('in:undecodable', raw)
        this._send(ws, { kind: 'error', message: `bad frame: ${err.message}` })
        return
      }

      // Everything before a successful hello is refused.
      if (!device) {
        if (frame.kind !== 'hello') {
          this.rejectedCount++
          try { ws.close(4401, 'hello required') } catch { /* ignore */ }
          return
        }

        const verified = devices.verify(frame.deviceId, frame.token)
        if (!verified) {
          this.rejectedCount++
          console.warn(`[r1] Rejected ${frame.deviceId || '<no id>'} from ${peer} — bad token`)
          this._send(ws, { kind: 'error', message: 'pairing rejected' })
          try { ws.close(4401, 'unauthorized') } catch { /* ignore */ }
          return
        }

        clearTimeout(helloTimer)
        device = verified
        devices.touch(device.device_id)
        this.sessions.set(sessionId, {
          ws,
          deviceId: device.device_id,
          label: device.label,
          alive: true,
          connectedAt: new Date().toISOString()
        })

        console.log(`[r1] ✓ ${device.label} (${device.device_id}) connected — session ${sessionId.slice(0, 8)} [${this.dialect.name}]`)
        this._send(ws, {
          kind: 'welcome',
          sessionId,
          deviceId: device.device_id,
          label: device.label
        })
        this.emit('connected', { sessionId, device })
        return
      }

      // Authenticated traffic.
      if (frame.kind === 'ping') return this._send(ws, { kind: 'pong' })

      if (frame.kind === 'ptt' || frame.kind === 'text' || frame.kind === 'vision') {
        this.messageCount++
        this.emit('message', {
          sessionId,
          deviceId: device.device_id,
          label: device.label,
          agentId: device.agent_id,
          requestId: frame.requestId || crypto.randomUUID(),
          kind: frame.kind,
          text: frame.text || null,
          audio: frame.audio || null,
          audioFormat: frame.audioFormat || 'wav',
          image: frame.image || null,
          receivedAt: new Date().toISOString()
        })
        return
      }

      this._send(ws, { kind: 'error', message: `unknown frame kind: ${frame.kind}` })
    })

    ws.on('close', (code) => {
      clearTimeout(helloTimer)
      if (this.sessions.delete(sessionId) && device) {
        console.log(`[r1] ${device.label} disconnected (${code})`)
        this.emit('disconnected', { sessionId, device })
      }
    })

    ws.on('error', (err) => console.warn(`[r1] Socket error (${peer}): ${err.message}`))
  }

  // ─── Outbound ──────────────────────────────────────────────────────────────

  /**
   * Send a reply to a device. Targets the live session; if the device has
   * several (reconnect races on LTE are normal), all of them get it — the R1
   * dedupes on request_id.
   */
  async sendMessage (deviceId, text, opts = {}) {
    const targets = [...this.sessions.values()].filter(s => s.deviceId === deviceId)
    if (targets.length === 0) {
      throw new Error(`device ${deviceId} is not connected`)
    }

    const frame = {
      kind: opts.kind || 'reply',
      requestId: opts.requestId || null,
      text,
      speak: opts.speak !== false
    }
    if (opts.transcript) frame.transcript = opts.transcript

    for (const session of targets) this._send(session.ws, frame)
    return { delivered_to: targets.length }
  }

  /** Instant acknowledgement so the R1 can stop showing a spinner. */
  async sendAck (deviceId, requestId, transcript = null) {
    const targets = [...this.sessions.values()].filter(s => s.deviceId === deviceId)
    for (const session of targets) {
      this._send(session.ws, { kind: 'ack', requestId, ...(transcript ? { transcript } : {}) })
    }
  }

  _send (ws, event) {
    try {
      if (ws.readyState !== ws.OPEN) return
      const wire = this._encodeFrame(event)
      if (this.capture) dialects.captureFrame('out', wire)
      ws.send(wire)
    } catch (err) {
      console.warn(`[r1] Send failed: ${err.message}`)
    }
  }

  // ─── Framing — delegated to the dialect, never inlined ─────────────────────

  _decodeFrame (raw) { return this.dialect.decode(raw) }
  _encodeFrame (event) { return this.dialect.encode(event) }

  // ─── Introspection ─────────────────────────────────────────────────────────

  getConversationCount () {
    return new Set([...this.sessions.values()].map(s => s.deviceId)).size
  }

  getSessions () {
    return [...this.sessions.entries()].map(([sessionId, s]) => ({
      session_id: sessionId,
      device_id: s.deviceId,
      label: s.label,
      connected_at: s.connectedAt
    }))
  }

  async healthCheck () {
    return this.wss !== null
  }
}

module.exports = R1Driver
