'use strict'

/**
 * Codex CLI sessions on this machine (#188539).
 *
 * Hive saw claude_code, opencode and ollama sessions only, so an agent run with OpenAI's Codex CLI
 * was invisible to `iris hive sessions` — One's launch video drives exactly that (codex on a VPS).
 *
 * The format is taken from Codex's own source (openai/codex, Apache-2.0, read 2026-10-08 — not
 * from a guess): `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread-id>.jsonl`, CODEX_HOME
 * defaulting to ~/.codex. Line 1 is `{"timestamp","type":"session_meta","payload":{id, timestamp,
 * cwd, originator, cli_version, model_provider?, git?:{commit_hash, branch, repository_url}}}`
 * (SessionMetaLine flattens SessionMeta and nests `git`). The person's prompts are
 * `{"type":"event_msg","payload":{"type":"user_message","message":…}}`; the model is on
 * `{"type":"turn_context","payload":{"model":…}}` lines.
 *
 * Read-only, head + tail of each file — never the whole transcript.
 */

const path = require('path')

const HEAD_BYTES = 1 << 16
const TAIL_BYTES = 1 << 17

function readSlice (fs, file, start, length) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.allocUnsafe(length)
    const n = fs.readSync(fd, buf, 0, length, start)
    return buf.slice(0, n).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
  }
}

function lines (chunk) {
  const out = []
  for (const l of String(chunk || '').split('\n')) {
    const t = l.trim()
    if (!t || t[0] !== '{') continue
    try { out.push(JSON.parse(t)) } catch { /* a cut line at a slice edge */ }
  }
  return out
}

/** One session from its head and tail chunks. Pure; null when there is no session_meta. */
function codexSessionFromChunks (head, tail, fallbackId) {
  const h = lines(head)
  const metaLine = h.find((e) => e && e.type === 'session_meta' && e.payload)
  if (!metaLine) return null
  const m = metaLine.payload
  const firstPrompt = h.find((e) => e && e.type === 'event_msg' && e.payload && e.payload.type === 'user_message' && typeof e.payload.message === 'string')
  const t = lines(tail)
  let model = null
  let last = null
  for (const e of [...h, ...t]) {
    if (e && e.type === 'turn_context' && e.payload && typeof e.payload.model === 'string') model = e.payload.model
    if (e && typeof e.timestamp === 'string' && !Number.isNaN(Date.parse(e.timestamp))) {
      if (!last || Date.parse(e.timestamp) > Date.parse(last)) last = e.timestamp
    }
  }
  const prompt = firstPrompt ? firstPrompt.payload.message.replace(/\s+/g, ' ').trim() : ''
  return {
    session_id: typeof m.id === 'string' ? m.id : fallbackId,
    name: prompt ? (prompt.length > 80 ? prompt.slice(0, 77) + '...' : prompt) : 'Codex session',
    project_path: typeof m.cwd === 'string' ? m.cwd : null,
    git_branch: m.git && typeof m.git.branch === 'string' ? m.git.branch : null,
    model: model || (typeof m.model_provider === 'string' ? m.model_provider : null),
    created_at: typeof m.timestamp === 'string' ? m.timestamp : null,
    // When it last WROTE an event — the same "last spoke" rule as claude_code (lib/session-times.js).
    updated_at: last,
    message_count: null,
    provider: 'codex'
  }
}

/** Newest rollout files first, walking YYYY/MM/DD descending and stopping at `limit`. */
function newestRollouts (fs, root, limit) {
  const files = []
  const desc = (dir) => { try { return fs.readdirSync(dir).sort().reverse() } catch { return [] } }
  for (const y of desc(root)) {
    if (!/^\d{4}$/.test(y)) continue
    for (const mo of desc(path.join(root, y))) {
      if (!/^\d{2}$/.test(mo)) continue
      for (const d of desc(path.join(root, y, mo))) {
        if (!/^\d{2}$/.test(d)) continue
        const dir = path.join(root, y, mo, d)
        const day = desc(dir).filter((f) => /^rollout-.*\.jsonl$/.test(f))
          .map((f) => { const p = path.join(dir, f); let mt = 0; try { mt = fs.statSync(p).mtimeMs } catch {} return { p, mt } })
          .sort((a, b) => b.mt - a.mt)
        for (const f of day) {
          files.push(f.p)
          if (files.length >= limit) return files
        }
      }
    }
  }
  return files
}

function listCodexSessions (fs, env, limit = 25) {
  const home = env.CODEX_HOME || path.join(env.HOME || '', '.codex')
  const root = path.join(home, 'sessions')
  const out = []
  for (const file of newestRollouts(fs, root, limit)) {
    let size = 0
    try { size = fs.statSync(file).size } catch { continue }
    const head = readSlice(fs, file, 0, Math.min(size, HEAD_BYTES))
    const tail = size > HEAD_BYTES ? readSlice(fs, file, Math.max(0, size - TAIL_BYTES), Math.min(size, TAIL_BYTES)) : ''
    const id = (path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/) || [])[1] || path.basename(file, '.jsonl')
    const s = codexSessionFromChunks(head, tail, id)
    if (s) out.push(s)
  }
  const at = (s) => { const t = Date.parse(s.updated_at || ''); return Number.isNaN(t) ? -Infinity : t }
  return out.sort((a, b) => at(b) - at(a)).slice(0, limit)
}

module.exports = { codexSessionFromChunks, newestRollouts, listCodexSessions }
