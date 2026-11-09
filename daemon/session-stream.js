'use strict'

/**
 * Live follow: push a session's transcript as it is written (epic #192964, W1).
 *
 * Before this, every surface that followed a session on another machine POLLED it. Each read was a
 * `sessions.history` NodeTask on this machine: measured 2026-11-09, one follower made 20 tasks a
 * minute and still saw words 1.7 s (p50) to 3.3 s (max) late.
 *
 * Now a follower asks the platform to follow a session. The platform tells this daemon on its own
 * private channel (`session.follow`, with a ttl the follower keeps renewing). The daemon watches that
 * ONE transcript and POSTs what was appended to the platform, which broadcasts it to
 * `private-hive-session.{node}.{session}`. Only members of this node's Hive can subscribe there.
 * Nothing is watched, read or sent for a session nobody follows.
 *
 * THE ENVELOPE (ADR-02, the one design-ahead item):
 *   { v:1, kind:'snapshot'|'delta'|'ping', node_id, session_id, seq, from, to, enc:'none', body }
 * `from`/`to` are byte cursors into the transcript. A follower whose last `to` is not this `from`
 * missed something and re-syncs. `body` is OPAQUE to the platform: a string it size-checks and never
 * parses. Today it is the JSON of the messages (`enc:'none'`). #833 phase 2.2 puts ciphertext there
 * and changes `enc`, with no protocol change.
 *
 * SIZE: Pusher refuses messages over 10 KB. Measured on two nodes: a per-append delta is 1.0–1.5 KB
 * at p95 and 3.3 KB at max, while a whole assistant turn is 12.5–17.6 KB at p95. So the daemon sends per
 * flush, not per turn, and splits a flush into bodies of at most MAX_BODY. A single message that is
 * alone too big goes as a `ping` carrying only the cursors; the follower fetches that range.
 */

const path = require('path')
const os = require('os')
const { readTail, readSince } = require('../lib/session-tail')

const MAX_BODY = 8 * 1024
const SNAPSHOT_MESSAGES = 20
const DEFAULT_TTL_MS = 90 * 1000
const MAX_TTL_MS = 5 * 60 * 1000
const FLUSH_MS = 150
/** fs.watch is unreliable on some filesystems (network mounts, some Linux setups); a stat is cheap. */
const STAT_MS = 1000
const MAX_FOLLOWED = 32
const ID = /^[A-Za-z0-9_-]{4,200}$/

/**
 * Split messages into envelopes whose body fits. Pure, so the size rule is testable without a socket.
 * `seq` increments per envelope. Every envelope carries the flush's cursors: `from` is where this
 * flush started and `to` where it ended, and only the LAST envelope of a flush has `final:true`. A
 * follower that applies envelopes in seq order and checks `from` against its own cursor on each
 * `final` stays consistent.
 */
function buildEnvelopes ({ kind, nodeId, sessionId, seq, from, to, messages, maxBody = MAX_BODY }) {
  const base = { v: 1, node_id: nodeId, session_id: sessionId, from, to, enc: 'none' }
  const out = []
  let batch = []
  let size = 2 // "[]"
  let n = seq

  const flush = () => {
    if (!batch.length) return
    out.push({ ...base, kind, seq: n++, body: JSON.stringify(batch) })
    batch = []
    size = 2
  }

  for (const m of messages) {
    // Measured AS IT TRAVELS: the body is a string inside the event's JSON, so every quote and
    // newline in it is escaped once more. Raw size under-counts a quote-heavy message by up to 2x.
    const one = Buffer.byteLength(JSON.stringify(JSON.stringify(m))) - 2
    if (one + 2 > maxBody) {
      // Alone it cannot ride a Pusher message. Say "changed" and let the follower fetch the range.
      flush()
      out.push({ ...base, kind: 'ping', seq: n++, body: '' })
      continue
    }
    if (size + one + 1 > maxBody) flush()
    batch.push(m)
    size += one + 1
  }
  flush()

  // A snapshot of nothing is still news: it tells the follower the cursor to start from.
  if (!out.length && kind === 'snapshot') out.push({ ...base, kind, seq: n++, body: '[]' })
  if (out.length) out[out.length - 1].final = true
  return out
}

/** Where a Claude Code session's transcript lives on this machine, or null. */
function locateClaudeTranscript (fs, sessionId, home = os.homedir()) {
  if (!ID.test(String(sessionId))) return null
  const root = path.join(home, '.claude', 'projects')
  let dirs = []
  try { dirs = fs.readdirSync(root) } catch { return null }
  for (const dir of dirs) {
    const candidate = path.join(root, dir, `${sessionId}.jsonl`)
    try { if (fs.statSync(candidate).isFile()) return candidate } catch { /* not here */ }
  }
  return null
}

class SessionStreamer {
  /**
   * @param {object} o
   * @param {(sessionId:string, envelopes:object[]) => Promise<any>} o.publish  POST to the platform
   * @param {string} o.nodeId
   * @param {object} [o.fs]  injected for tests
   * @param {(sessionId:string, provider:string) => string|null} [o.locate]
   */
  constructor ({ publish, nodeId, fs = require('fs'), locate, now = () => Date.now(), log = console.log }) {
    this.publish = publish
    this.nodeId = nodeId
    this.fs = fs
    this.locate = locate || ((id) => locateClaudeTranscript(fs, id))
    this.now = now
    this.log = log
    /** sessionId → { file, cursor, seq, until, watcher, statTimer, flushTimer, sending } */
    this.followed = new Map()
  }

  /**
   * `session.follow` from the platform. Starts a follow, or renews one. `snapshot:true` comes with a
   * follower's FIRST request: it has nothing to apply deltas to, so it gets the current page even
   * when the session is already being streamed for someone else.
   */
  follow ({ session_id: sessionId, provider = 'claude_code', ttl_s: ttlS, snapshot = false } = {}) {
    if (!ID.test(String(sessionId || ''))) return { ok: false, reason: 'bad session id' }
    const ttl = Math.min(MAX_TTL_MS, Math.max(5000, Number(ttlS) * 1000 || DEFAULT_TTL_MS))
    const existing = this.followed.get(sessionId)
    if (existing) {
      existing.until = this.now() + ttl
      // A renewal from a NEW follower needs a snapshot too: it has nothing to apply deltas to.
      if (snapshot) {
        // Send what is pending FIRST, so followers already streaming see no gap at the snapshot.
        clearTimeout(existing.flushTimer); existing.flushTimer = null
        this._flush(sessionId)
        this._snapshot(sessionId, existing)
      }
      return { ok: true, renewed: true }
    }

    // Only file-backed Claude Code transcripts stream today. Others keep the poll (the follower
    // says "live unavailable for <provider>"), which is no worse than before.
    const slug = String(provider).replace('-', '_')
    if (slug !== 'claude_code' && slug !== 'claude') return { ok: false, reason: `live follow not supported for ${provider}` }
    if (this.followed.size >= MAX_FOLLOWED) return { ok: false, reason: 'too many followed sessions' }

    const file = this.locate(sessionId, provider)
    if (!file) return { ok: false, reason: 'session not on this machine' }

    const f = { file, cursor: null, seq: 0, until: this.now() + ttl, watcher: null, statTimer: null, flushTimer: null, sending: false, lastSize: -1 }
    this.followed.set(sessionId, f)
    this._snapshot(sessionId, f)
    try {
      f.watcher = this.fs.watch(file, { persistent: false }, () => this._schedule(sessionId))
      f.watcher.on && f.watcher.on('error', () => {})
    } catch { /* stat fallback below covers it */ }
    f.statTimer = setInterval(() => this._tick(sessionId), STAT_MS)
    if (f.statTimer.unref) f.statTimer.unref()
    this.log(`[live] following ${sessionId} (${path.basename(path.dirname(file))})`)
    return { ok: true, started: true }
  }

  _snapshot (sessionId, f) {
    let size
    try { size = this.fs.statSync(f.file).size } catch { return this.stop(sessionId, 'transcript gone') }
    const page = readTail(this.fs, f.file, size, SNAPSHOT_MESSAGES)
    f.cursor = page.offset
    f.lastSize = size
    const envs = buildEnvelopes({ kind: 'snapshot', nodeId: this.nodeId, sessionId, seq: f.seq, from: page.offset, to: page.offset, messages: page.messages })
    f.seq += envs.length
    this._send(sessionId, envs)
  }

  _tick (sessionId) {
    const f = this.followed.get(sessionId)
    if (!f) return
    if (this.now() > f.until) return this.stop(sessionId, 'no follower renewed')
    let size
    try { size = this.fs.statSync(f.file).size } catch { return this.stop(sessionId, 'transcript gone') }
    if (size !== f.lastSize) this._schedule(sessionId)
  }

  /** Coalesce a burst of writes into one flush, at most every FLUSH_MS. */
  _schedule (sessionId) {
    const f = this.followed.get(sessionId)
    if (!f || f.flushTimer) return
    f.flushTimer = setTimeout(() => { f.flushTimer = null; this._flush(sessionId) }, FLUSH_MS)
  }

  _flush (sessionId) {
    const f = this.followed.get(sessionId)
    if (!f || f.cursor === null) return
    let size
    try { size = this.fs.statSync(f.file).size } catch { return this.stop(sessionId, 'transcript gone') }
    f.lastSize = size
    if (size === f.cursor) return
    const out = readSince(this.fs, f.file, size, f.cursor, { max: 200 })
    if (out.reset || out.truncated) {
      // Rewritten, or a flood: a fresh snapshot is both simpler and smaller than the backlog.
      return this._snapshot(sessionId, f)
    }
    const from = f.cursor
    f.cursor = out.offset
    if (!out.messages.length) return // only a partial line, or records the follower never sees
    const envs = buildEnvelopes({ kind: 'delta', nodeId: this.nodeId, sessionId, seq: f.seq, from, to: out.offset, messages: out.messages })
    f.seq += envs.length
    this._send(sessionId, envs)
  }

  _send (sessionId, envelopes) {
    if (!envelopes.length) return
    Promise.resolve()
      .then(() => this.publish(sessionId, envelopes))
      .catch((err) => this.log(`[live] publish ${sessionId} failed: ${err && err.message}`))
  }

  stop (sessionId, why = 'stopped') {
    const f = this.followed.get(sessionId)
    if (!f) return
    try { f.watcher && f.watcher.close() } catch {}
    clearInterval(f.statTimer)
    clearTimeout(f.flushTimer)
    this.followed.delete(sessionId)
    this.log(`[live] stopped ${sessionId}: ${why}`)
  }

  stopAll () { for (const id of [...this.followed.keys()]) this.stop(id, 'daemon stopping') }
}

module.exports = { SessionStreamer, buildEnvelopes, locateClaudeTranscript, MAX_BODY, SNAPSHOT_MESSAGES }
