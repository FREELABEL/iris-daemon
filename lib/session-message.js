'use strict'

/**
 * Deliver a message INTO a Claude Code session that is running right now (epic #192964, W4 R2).
 *
 * THE DEFECT THIS REPLACES. `/message` ran `claude -p <msg> --resume <id>`: a SECOND process on
 * the same session. The terminal the person is looking at never hears about it, the reply lands in
 * a fork, and two processes append to one transcript. `/answer` stopped doing this for answers in
 * #188549 S4; messages kept doing it.
 *
 * NOW: when the session is running in a tmux pane on this machine, the message is pasted into that
 * pane and submitted, exactly as if the person had typed it. Same process, same session id, same
 * screen. Found from facts on disk, not guesses:
 *
 *   ~/.claude/sessions/<pid>.json   Claude Code writes one per running process: { pid, sessionId }.
 *                                   A live pid with our session id = the session is running.
 *   tmux list-panes -a              each pane's root pid. The session's process, or one of its
 *                                   ancestors, being a pane's root pid = that pane is the session.
 *
 * Outcomes, each one named:
 *   not running here            { resume: true }  — the caller may `claude -p --resume`: there is no
 *                                                   live process to fork away from.
 *   running, not in tmux        409, why          — no screen this machine can type into. NOT forked:
 *                                                   a reply nobody sees reported as delivered is #184783.
 *   running, a prompt on screen 409, why          — a menu or question is up; pasting text would pick
 *                                                   an option. Answer it with /answer.
 *   typed                       200 seen:true     — and the message is in the transcript
 *                               202 seen:false    — typed; the session is mid-turn and has queued it
 *
 * Typed with a bracketed paste (tmux paste-buffer -p), then Enter as its own key, so a message
 * with newlines arrives as one message instead of being submitted line by line.
 */

const path = require('path')
const { findTranscript, SAFE_ID } = require('./session-answer')

const MAX_CHARS = 20000

/** Text on screen that means a menu or question owns the keyboard right now. */
const PROMPT_ON_SCREEN = /Enter to select|Esc to cancel|Do you want to (proceed|make this edit|create|allow)|Yes, and don't ask again/

function readJson (fs, p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

/** The live process running this session, from Claude Code's own per-process files, or null. */
function liveSession (deps, sessionId) {
  const dir = path.join(deps.home, '.claude', 'sessions')
  let files
  try { files = deps.fs.readdirSync(dir) } catch { return null }
  for (const f of files) {
    if (!/^\d+\.json$/.test(f)) continue
    const s = readJson(deps.fs, path.join(dir, f))
    if (!s || s.sessionId !== sessionId || !Number.isInteger(s.pid)) continue
    try { deps.kill(s.pid, 0) } catch { continue } // a file left behind by a process that is gone
    return { pid: s.pid, cwd: s.cwd || null }
  }
  return null
}

/** pid → ppid, from `ps -A -o pid= -o ppid=` (the same flags on Linux and macOS). */
function parentMap (psOut) {
  const m = new Map()
  for (const line of String(psOut || '').split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (Number.isInteger(pid) && Number.isInteger(ppid)) m.set(pid, ppid)
  }
  return m
}

/** The tmux pane whose root process is `pid` or one of its ancestors, or null. */
function paneFor (deps, pid) {
  let listing
  try {
    listing = deps.tmux(['list-panes', '-a', '-F', '#{pane_id}\t#{pane_pid}\t#{socket_path}'])
  } catch { return null } // no tmux installed, or no server running: not in tmux
  const panes = new Map()
  for (const line of String(listing).split('\n')) {
    const [pane, panePid, socket] = line.split('\t')
    if (pane && Number(panePid)) panes.set(Number(panePid), { pane, socket })
  }
  if (!panes.size) return null
  let parents
  try { parents = parentMap(deps.ps()) } catch { parents = new Map() }
  for (let p = pid, hops = 0; p > 1 && hops < 64; p = parents.get(p), hops++) {
    if (panes.has(p)) return panes.get(p)
    if (!parents.has(p)) break
  }
  return null
}

/** Did a user record carrying `text` land in the transcript after byte `from`? */
function seenInTranscript (fs, file, from, text) {
  let chunk
  try {
    const size = fs.statSync(file).size
    if (size <= from) return false
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(Math.min(size - from, 4 << 20))
      fs.readSync(fd, buf, 0, buf.length, from)
      chunk = buf.toString('utf8')
    } finally { fs.closeSync(fd) }
  } catch { return false }
  // tmux pastes a newline as CR; compare with line endings normalised.
  const norm = (s) => s.replace(/\r\n?/g, '\n')
  const needle = norm(text).slice(0, 80)
  for (const line of chunk.split('\n')) {
    if (!line.includes('"user"')) continue
    let r
    try { r = JSON.parse(line) } catch { continue }
    if (r.type !== 'user' || !r.message) continue
    const c = r.message.content
    const s = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p && p.type === 'text' ? p.text : '')).join('\n') : ''
    if (norm(s).includes(needle)) return true
  }
  return false
}

/**
 * @param deps { fs, home, kill(pid, sig), tmux(args[]) -> string, ps() -> string, sleep(ms), now() }
 * @param msg  { message, from }
 * @returns {Promise<{ status, body } | { resume: true }>}
 */
async function deliverMessage (deps, sessionId, msg = {}) {
  if (!SAFE_ID.test(String(sessionId || ''))) return { status: 400, body: { error: 'invalid session id' } }
  const message = typeof msg.message === 'string' ? msg.message : ''
  if (!message.trim()) return { status: 400, body: { error: 'message is empty' } }
  if (message.length > MAX_CHARS) return { status: 413, body: { error: `message is over ${MAX_CHARS} characters` } }

  const live = liveSession(deps, sessionId)
  if (!live) return { resume: true }

  const where = paneFor(deps, live.pid)
  if (!where) {
    return {
      status: 409,
      body: {
        delivered: false,
        error: `session ${sessionId} is running on this machine (pid ${live.pid}) but not inside tmux, so there is no screen to type into. It was NOT forked into a second process. Send it where it is open, or run it inside tmux next time.`
      }
    }
  }

  const sock = where.socket ? ['-S', where.socket] : []
  let screen = ''
  try { screen = deps.tmux([...sock, 'capture-pane', '-p', '-t', where.pane]) } catch (e) {
    return { status: 409, body: { delivered: false, error: `tmux pane ${where.pane} is gone (${e.message})` } }
  }
  if (PROMPT_ON_SCREEN.test(screen)) {
    return { status: 409, body: { delivered: false, error: 'the session is showing a question or a permission prompt — typing a message now would pick an option. Answer it first (send-input with answers).' } }
  }

  // PROVENANCE (#182785): the same visible prefix opencode deliveries carry.
  const text = msg.from ? `[via iris · ${String(msg.from).slice(0, 64)}] ${message}` : message

  const transcript = findTranscript(deps.fs, deps.home, sessionId)
  let before = 0
  try { before = transcript ? deps.fs.statSync(transcript).size : 0 } catch { /* new file */ }

  const buf = `iris-msg-${process.pid}-${deps.now()}`
  deps.tmux([...sock, 'set-buffer', '-b', buf, '--', text])
  deps.tmux([...sock, 'paste-buffer', '-p', '-d', '-b', buf, '-t', where.pane])
  await deps.sleep(150) // let the paste finish before Enter, or Enter can land inside it
  deps.tmux([...sock, 'send-keys', '-t', where.pane, 'Enter'])

  let seen = false
  for (let i = 0; i < 20 && !seen; i++) {
    await deps.sleep(200)
    const file = transcript || findTranscript(deps.fs, deps.home, sessionId)
    seen = !!file && seenInTranscript(deps.fs, file, file === transcript ? before : 0, text)
  }
  const body = { delivered: 'pane', session_id: sessionId, pane: where.pane, pid: live.pid, seen }
  if (!seen) body.note = 'typed into the session; it is busy and will take the message when its current turn ends'
  return { status: seen ? 200 : 202, body }
}

module.exports = { deliverMessage, liveSession, paneFor, parentMap, seenInTranscript, PROMPT_ON_SCREEN }
