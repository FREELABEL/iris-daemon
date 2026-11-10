'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { resolveClaudeBin } = require('../lib/claude-bin')
const { deliverMessage, paneFor, parentMap } = require('../lib/session-message')

/**
 * Epic #192964 W4 R2 — a reply from a phone to a Claude Code session on iris-hive-001.
 *
 * RED, measured on iris-hive-001 2026-11-09 17:55 and 17:58 (journalctl -u iris-daemon), markers
 * "W4 prototype marker mw9kauer" / "mw9ke1nb" to session c3ffc065-… running in tmux pane %1:
 *   [claude-code] Message failed: spawn /opt/homebrew/bin/claude ENOENT   → curl (22) 500
 * Two defects: (a) a macOS Homebrew path on a Linux node; (b) even with the right path, `/message`
 * would have run `claude -p --resume`, a fork, instead of typing into the pane that was right there.
 */

const SID = 'c3ffc065-7de9-4615-827e-6cb2d0b6d0ec'

// ─── (a) finding `claude` ─────────────────────────────────────────────────────────────────────

test('(a) iris-hive-001: claude is /usr/local/bin/claude on the daemon PATH — found there, not at /opt/homebrew', () => {
  const have = new Set(['/usr/local/bin/claude'])
  const r = resolveClaudeBin({ env: { PATH: '/home/siralexmayo/.iris/bin:/usr/local/bin:/usr/bin:/bin' }, platform: 'linux', home: '/home/siralexmayo', isExec: (p) => have.has(p) })
  assert.equal(r.bin, '/usr/local/bin/claude')
})

test('(a) a short service PATH still finds the native installer in ~/.local/bin', () => {
  const have = new Set(['/home/u/.local/bin/claude'])
  const r = resolveClaudeBin({ env: { PATH: '/usr/bin:/bin' }, platform: 'linux', home: '/home/u', isExec: (p) => have.has(p) })
  assert.equal(r.bin, '/home/u/.local/bin/claude')
})

test('(a) Apple-silicon Homebrew is still found on a Mac whose launchd PATH lacks it', () => {
  const have = new Set(['/opt/homebrew/bin/claude'])
  const r = resolveClaudeBin({ env: { PATH: '/usr/bin:/bin' }, platform: 'darwin', home: '/Users/u', isExec: (p) => have.has(p) })
  assert.equal(r.bin, '/opt/homebrew/bin/claude')
})

test('(a) an explicit CLAUDE_BIN wins when it exists, and is skipped — and named — when it does not', () => {
  const have = new Set(['/opt/x/claude', '/usr/local/bin/claude'])
  const isExec = (p) => have.has(p)
  assert.equal(resolveClaudeBin({ env: { CLAUDE_BIN: '/opt/x/claude', PATH: '/usr/local/bin' }, platform: 'linux', home: '/h', isExec }).bin, '/opt/x/claude')
  const stale = resolveClaudeBin({ env: { CLAUDE_BIN: '/opt/homebrew/bin/claude', PATH: '/usr/local/bin' }, platform: 'linux', home: '/h', isExec })
  assert.equal(stale.bin, '/usr/local/bin/claude')
  assert.match(stale.tried[0], /CLAUDE_BIN, not there/)
})

test('(a) Windows: claude.exe / claude.cmd on PATH', () => {
  const have = new Set([path.join('C:\\npm', 'claude.cmd')])
  const r = resolveClaudeBin({ env: { PATH: 'C:\\npm' }, platform: 'win32', home: 'C:\\Users\\u', isExec: (p) => have.has(p) })
  assert.equal(r.bin, path.join('C:\\npm', 'claude.cmd'))
})

test('(a) nowhere → null with every place looked, never a guessed path', () => {
  const r = resolveClaudeBin({ env: { PATH: '/usr/bin' }, platform: 'linux', home: '/h', isExec: () => false })
  assert.equal(r.bin, null)
  assert.ok(r.tried.includes('/usr/bin/claude'))
})

test('(a) the bridge no longer names a fixed Homebrew path for claude', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
  assert.doesNotMatch(src, /CLAUDE_BIN\s*\|\|\s*'\/opt\/homebrew\/bin\/claude'/)
})

// ─── (b) typing into the running session ──────────────────────────────────────────────────────

function home ({ sessions = [{ pid: 3968651, sessionId: SID }], transcript = '' } = {}) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-'))
  fs.mkdirSync(path.join(h, '.claude', 'sessions'), { recursive: true })
  for (const s of sessions) fs.writeFileSync(path.join(h, '.claude', 'sessions', `${s.pid}.json`), JSON.stringify({ kind: 'interactive', ...s }))
  const proj = path.join(h, '.claude', 'projects', '-home-w4-r2')
  fs.mkdirSync(proj, { recursive: true })
  fs.writeFileSync(path.join(proj, `${SID}.jsonl`), transcript)
  return { h, file: path.join(proj, `${SID}.jsonl`) }
}

const userLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'

// iris-hive-001 as measured: `w4r2 %1 3968651 claude /tmp/tmux-1000/default` — the pane's root IS claude.
const PANES = '%0\t1619330\t/tmp/tmux-1000/default\n%1\t3968651\t/tmp/tmux-1000/default\n'
const SCREEN = '╭────╮\n│ > \n╰────╯\n  ? for shortcuts\n'

function deps (h, file, { alive = [3968651], panes = PANES, ps = '', screen = SCREEN, echo = true, noTmux = false } = {}) {
  const calls = []
  let pasted = ''
  return {
    calls,
    fs,
    home: h,
    now: () => 1,
    sleep: async () => {},
    kill: (pid) => { if (!alive.includes(pid)) throw new Error('ESRCH') },
    ps: () => ps,
    tmux: (args) => {
      calls.push(args)
      if (noTmux) throw new Error('spawn tmux ENOENT')
      if (args[0] === 'list-panes') return panes
      if (args.includes('capture-pane')) return screen
      if (args.includes('set-buffer')) pasted = args[args.length - 1]
      // The session submitting what was typed: it appears in its transcript as a user record.
      if (args.includes('send-keys') && args.includes('Enter') && echo) fs.appendFileSync(file, userLine(pasted))
      return ''
    }
  }
}

test('(b) running in tmux → pasted into ITS pane and submitted, lands in the same session — no claude -p', async () => {
  const { h, file } = home()
  const d = deps(h, file)
  const out = await deliverMessage(d, SID, { message: 'W4 prototype marker mw9kauer', from: 'iris-hive-002' })
  assert.equal(out.status, 200)
  assert.deepEqual([out.body.delivered, out.body.pane, out.body.seen], ['pane', '%1', true])
  const sock = ['-S', '/tmp/tmux-1000/default']
  assert.deepEqual(d.calls.find((c) => c.includes('set-buffer')).slice(-2), ['--', '[via iris · iris-hive-002] W4 prototype marker mw9kauer'])
  assert.deepEqual(d.calls.find((c) => c.includes('paste-buffer')).slice(0, 4), [...sock, 'paste-buffer', '-p'])
  assert.deepEqual(d.calls[d.calls.length - 1], [...sock, 'send-keys', '-t', '%1', 'Enter'])
  assert.match(fs.readFileSync(file, 'utf8'), /mw9kauer/)
})

test('(b) claude under a shell in the pane: found by walking up its parents', async () => {
  const { h, file } = home({ sessions: [{ pid: 5002, sessionId: SID }] })
  const d = deps(h, file, { alive: [5002], panes: '%7\t5000\t/tmp/tmux-1000/default\n', ps: '  5000     1\n  5001  5000\n  5002  5001\n' })
  const out = await deliverMessage(d, SID, { message: 'hello' })
  assert.equal(out.body.pane, '%7')
})

test('(b) not running here → resume (a fork is only a fork when something is running)', async () => {
  const { h, file } = home({ sessions: [{ pid: 999, sessionId: SID }] })
  assert.deepEqual(await deliverMessage(deps(h, file, { alive: [] }), SID, { message: 'x' }), { resume: true })
  const other = home({ sessions: [] })
  assert.deepEqual(await deliverMessage(deps(other.h, other.file), SID, { message: 'x' }), { resume: true })
})

test('(b) running but NOT in tmux → 409 with the reason, never a silent fork', async () => {
  const { h, file } = home()
  for (const opts of [{ noTmux: true }, { panes: '%3\t42\t/tmp/s\n' }]) {
    const d = deps(h, file, opts)
    const out = await deliverMessage(d, SID, { message: 'x' })
    assert.equal(out.status, 409)
    assert.match(out.body.error, /not inside tmux.*NOT forked/s)
    assert.equal(d.calls.filter((c) => c.includes('send-keys')).length, 0)
  }
})

test('(b) a question or permission prompt on screen → refuses: typed text would pick an option', async () => {
  const { h, file } = home()
  for (const screen of ['Which color?\n❯ 1. Red\nEnter to select · ↑/↓ to navigate · Esc to cancel', 'Do you want to proceed?\n❯ 1. Yes\n  2. Yes, and don\'t ask again']) {
    const d = deps(h, file, { screen })
    const out = await deliverMessage(d, SID, { message: 'x' })
    assert.equal(out.status, 409)
    assert.equal(d.calls.filter((c) => c.includes('paste-buffer') || c.includes('send-keys')).length, 0)
  }
})

test('(b) typed while the session is mid-turn → 202, says it is queued rather than claiming it was read', async () => {
  const { h, file } = home()
  const out = await deliverMessage(deps(h, file, { echo: false }), SID, { message: 'x' })
  assert.equal(out.status, 202)
  assert.equal(out.body.seen, false)
  assert.match(out.body.note, /busy/)
})

test('(b) refuses bad input before touching tmux', async () => {
  const { h, file } = home()
  const d = deps(h, file)
  assert.equal((await deliverMessage(d, '../etc', { message: 'x' })).status, 400)
  assert.equal((await deliverMessage(d, SID, { message: '   ' })).status, 400)
  assert.equal((await deliverMessage(d, SID, { message: 'x'.repeat(20001) })).status, 413)
  assert.equal(d.calls.length, 0)
})

test('parentMap reads ps output from Linux and macOS alike', () => {
  assert.deepEqual([...parentMap('  1 0\n 42   1\n\n bad\n')], [[1, 0], [42, 1]])
})

test('paneFor stops at a process with no parent on record', () => {
  const d = { tmux: () => '%1\t10\t/s\n', ps: () => '30 20\n' }
  assert.equal(paneFor(d, 30), null)
})

// ─── A real tmux, when this machine has one ───────────────────────────────────────────────────

const hasTmux = (() => { try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true } catch { return false } })()

test('(b) real tmux: a multi-line message arrives as ONE submitted message in the pane\'s process', { skip: !hasTmux && 'tmux is not installed here — the injected-tmux tests above still run' }, async () => {
  const { h, file } = home({ sessions: [] })
  const sock = path.join(h, 'tmux.sock')
  // A stand-in for the interactive session: reads the terminal and writes each submitted line as
  // the user record Claude Code would. Bracketed paste keeps newlines inside one submission.
  const reader = path.join(h, 'reader.js')
  fs.writeFileSync(reader, `
    const fs = require('fs'); process.stdin.setRawMode(true); process.stdout.write('\\x1b[?2004h> ')
    let buf = '', inPaste = false
    process.stdin.on('data', (d) => {
      for (const tok of d.toString().split(/(\\x1b\\[20[01]~)/)) {
        if (tok === '\\x1b[200~') { inPaste = true; continue }
        if (tok === '\\x1b[201~') { inPaste = false; continue }
        for (const ch of tok) {
          if (ch === '\\r' && !inPaste) { fs.appendFileSync(${JSON.stringify(file)}, JSON.stringify({ type: 'user', message: { role: 'user', content: buf } }) + '\\n'); buf = '' }
          else buf += (ch === '\\r' ? '\\n' : ch) // a pasted newline is part of the message
        }
      }
    })`)
  execFileSync('tmux', ['-S', sock, 'new-session', '-d', '-x', '120', '-y', '20', process.execPath, reader])
  try {
    const panePid = Number(execFileSync('tmux', ['-S', sock, 'list-panes', '-a', '-F', '#{pane_pid}'], { encoding: 'utf8' }).trim())
    fs.writeFileSync(path.join(h, '.claude', 'sessions', `${panePid}.json`), JSON.stringify({ pid: panePid, sessionId: SID }))
    await new Promise((r) => setTimeout(r, 300))
    const real = {
      fs,
      home: h,
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      kill: (pid, sig) => process.kill(pid, sig),
      ps: () => execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { encoding: 'utf8' }),
      tmux: (args) => execFileSync('tmux', args[0] === '-S' ? args : ['-S', sock, ...args], { encoding: 'utf8', timeout: 5000 })
    }
    const out = await deliverMessage(real, SID, { message: 'line one\nline two marker-r2' })
    assert.equal(out.status, 200, JSON.stringify(out.body))
    const records = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(records.length, 1)
    assert.match(records[0].message.content, /line one[\r\n]+line two marker-r2/)
  } finally {
    try { execFileSync('tmux', ['-S', sock, 'kill-server']) } catch { /* gone */ }
  }
})

