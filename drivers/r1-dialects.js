/**
 * R1 Wire Dialects — the ONLY place the on-the-wire format is known.
 *
 * The R1 connects to us because it already speaks OpenClaw's gateway protocol.
 * We implement that protocol so the stock client works unmodified — but nothing
 * OpenClaw runs in the path. Every turn is served by IRIS. "OpenClaw" here names
 * a WIRE FORMAT we answer, not a service we call.
 *
 * Above this file everything is CANONICAL:
 *
 *   inbound  { kind:'hello'|'ptt'|'text'|'vision'|'ping',
 *              deviceId, token, requestId, text, audio, audioFormat, image }
 *   outbound { kind:'welcome'|'ack'|'reply'|'error'|'pong',
 *              requestId, text, transcript, speak, sessionId, deviceId, label, message }
 *
 * Adding a dialect = adding an entry here. The driver, the channel, the routes
 * and the pairing store never learn what a frame looks like.
 *
 * ── STATUS OF THE `openclaw` DIALECT ─────────────────────────────────────────
 *
 * The mapping below is a BEST-EFFORT reconstruction. It has NOT been verified
 * against a physical R1, and a protocol guessed from documentation is a protocol
 * that fails at the handshake with no useful error.
 *
 * So do not "fix" it by reasoning. Capture it:
 *
 *     R1_CAPTURE=1  → every raw inbound frame is appended, verbatim, to
 *                     ~/.iris/bridge/r1-frames.jsonl
 *
 * Point the real device at the gateway with capture on, press the button once,
 * read the file, and complete `openclaw.decode` from what the hardware actually
 * sent. That file is the specification; this block is a placeholder for it.
 *
 * Until then run `dialect: 'native'` with the simulator — it exercises the whole
 * IRIS path (transcribe → agent → reply) and is not blocked on the R1 at all.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const CAPTURE_PATH = process.env.R1_CAPTURE_PATH ||
  path.join(os.homedir(), '.iris', 'bridge', 'r1-frames.jsonl')

/**
 * Append a raw frame for later study. Best-effort: capture must never be able
 * to break a live device session.
 */
function captureFrame (direction, raw) {
  try {
    const dir = path.dirname(CAPTURE_PATH)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const text = typeof raw === 'string' ? raw : raw.toString('utf-8')
    // Audio/image payloads are megabytes of base64 and tell you nothing about
    // the FORMAT. Keep the envelope, drop the cargo.
    const redacted = text.replace(/"(audio|image)"\s*:\s*"[^"]{64,}"/g, '"$1":"<redacted N bytes>"')
    fs.appendFileSync(CAPTURE_PATH, JSON.stringify({
      at: new Date().toISOString(),
      direction,
      bytes: Buffer.byteLength(text),
      frame: redacted.slice(0, 8000)
    }) + '\n')
  } catch { /* never let capture affect the session */ }
}

// ─── native ──────────────────────────────────────────────────────────────────
// Our own shape. Used by the simulator and by any first-party client we write.
// Deliberately 1:1 with the canonical event so it has no failure modes of its
// own — when something breaks under `native`, it is IRIS, not the wire.

const native = {
  name: 'native',

  decode (raw) {
    const frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8'))
    if (!frame || typeof frame.type !== 'string') throw new Error('missing type')
    return {
      kind: frame.type,
      deviceId: frame.device_id,
      token: frame.token,
      requestId: frame.request_id,
      text: frame.text || null,
      audio: frame.audio || null,
      audioFormat: frame.format || 'wav',
      image: frame.image || null
    }
  },

  encode (event) {
    const out = { type: event.kind }
    if (event.requestId) out.request_id = event.requestId
    if (event.text != null) out.text = event.text
    if (event.transcript) out.transcript = event.transcript
    if (event.speak != null) out.speak = event.speak
    if (event.sessionId) out.session_id = event.sessionId
    if (event.deviceId) out.device_id = event.deviceId
    if (event.label) out.label = event.label
    if (event.message) out.message = event.message
    return JSON.stringify(out)
  }
}

// ─── openclaw ────────────────────────────────────────────────────────────────
// UNVERIFIED — see the header. Written to be permissive on decode (accept the
// several field names the same thing plausibly arrives under) and conservative
// on encode (emit one shape). Permissive decode is the right bias: a frame we
// half-understand is worth more than a hard reject while the format is unknown.

const openclaw = {
  name: 'openclaw',

  decode (raw) {
    const frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8'))
    const type = frame.type || frame.event || frame.op
    if (!type) throw new Error('missing type/event/op')

    const requestId = frame.request_id || frame.requestId || frame.id || frame.message_id || null
    const audio = frame.audio || frame.audio_data || frame.data?.audio || null
    const image = frame.image || frame.photo || frame.data?.image || null
    const text = frame.text || frame.message || frame.transcript || frame.data?.text || null

    // Collapse the several names each logical event plausibly travels under.
    if (/^(hello|auth|connect|session\.start|handshake)$/i.test(type)) {
      return {
        kind: 'hello',
        deviceId: frame.device_id || frame.deviceId || frame.client_id || frame.imei || null,
        token: frame.token || frame.auth_token || frame.api_key || frame.secret || null,
        requestId
      }
    }
    if (/^(ping|heartbeat)$/i.test(type)) return { kind: 'ping', requestId }

    // Audio present ⇒ push-to-talk, whatever the envelope calls itself.
    if (audio) {
      return {
        kind: 'ptt',
        requestId,
        audio,
        audioFormat: frame.format || frame.encoding || frame.mime?.split('/')?.[1] || 'wav',
        text
      }
    }
    if (image) return { kind: 'vision', requestId, image, text }
    if (text) return { kind: 'text', requestId, text }

    throw new Error(`unmapped openclaw frame: ${type}`)
  },

  encode (event) {
    switch (event.kind) {
      case 'welcome':
        return JSON.stringify({
          type: 'session.started',
          session_id: event.sessionId,
          device_id: event.deviceId,
          label: event.label
        })
      case 'ack':
        return JSON.stringify({
          type: 'transcription',
          request_id: event.requestId,
          text: event.transcript || ''
        })
      case 'reply':
        return JSON.stringify({
          type: 'response',
          request_id: event.requestId,
          text: event.text,
          speak: event.speak !== false
        })
      case 'error':
        return JSON.stringify({ type: 'error', request_id: event.requestId, message: event.message })
      case 'pong':
        return JSON.stringify({ type: 'pong' })
      default:
        return JSON.stringify({ type: event.kind, ...event })
    }
  }
}

const DIALECTS = { native, openclaw }

function get (name) {
  const dialect = DIALECTS[name || 'openclaw']
  if (!dialect) throw new Error(`unknown dialect: ${name} (have: ${Object.keys(DIALECTS).join(', ')})`)
  return dialect
}

module.exports = { get, DIALECTS, captureFrame, CAPTURE_PATH }
