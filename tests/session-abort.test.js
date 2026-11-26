'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')
const { abortSession, PROVIDERS } = require('../lib/session-abort')

/**
 * Shared workspaces (#194307) — a room member presses Stop and the run on someone else's machine
 * stops. There was no interrupt anywhere: the bridge could message, answer and read a session,
 * never halt one. Each harness has its own native interrupt, and Stop uses THAT, never a kill:
 *
 *   claude-code  Esc into the tmux pane the session runs in (what a person at the keyboard does)
 *   opencode     the engine's own POST /session/:id/abort
 *   acp          the `iris acp run --keep` holder's POST /cancel (ACP session/cancel) — Codex, Gemini
 *
 * A session that is not running here is a 404 with the reason, never a success.
 */

const SID = 'c3ffc065-7de9-4615-827e-6cb2d0b6d0ec'

function claudeDeps ({ live = true, inTmux = true } = {}) {
  const calls = []
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'abort-'))
  if (live) {
    fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', 'sessions', '4242.json'), JSON.stringify({ sessionId: SID, pid: 4242, cwd: '/w' }))
  }
  return {
    calls,
    deps: {
      fs,
      home,
      kill: (pid) => { if (pid !== 4242) throw new Error('ESRCH') },
      ps: () => '4242 100\n100 1\n',
      tmux: (args) => {
        calls.push(args)
        if (args[0] === 'list-panes') return inTmux ? '%7\t100\t/tmp/tmux-1000/default\n' : ''
        return ''
      },
      fetch: async () => { throw new Error('no network in this test') }
    }
  }
}

test('claude-code: Esc goes into the pane running the session — and nothing else is typed', async () => {
  const { deps, calls } = claudeDeps()
  const out = await abortSession(deps, 'claude-code', SID)
  assert.equal(out.status, 200)
  assert.equal(out.body.stopped, 'pane')
  const keys = calls.filter((a) => a.includes('send-keys'))
  assert.deepEqual(keys, [['-S', '/tmp/tmux-1000/default', 'send-keys', '-t', '%7', 'Escape']])
})

test('claude-code: the underscore spelling the platform sometimes sends is the same harness', async () => {
  const { deps } = claudeDeps()
  assert.equal((await abortSession(deps, 'claude_code', SID)).status, 200)
})

test('claude-code: not running here → 404 with the reason, nothing typed', async () => {
  const { deps, calls } = claudeDeps({ live: false })
  const out = await abortSession(deps, 'claude-code', SID)
  assert.equal(out.status, 404)
  assert.match(out.body.error, /not running on this machine/)
  assert.equal(calls.filter((a) => a.includes('send-keys')).length, 0)
})

test('claude-code: running outside tmux → 409, it says so, and it does NOT kill the process', async () => {
  const { deps } = claudeDeps({ inTmux: false })
  let killed = false
  deps.kill = (pid, sig) => { if (sig && sig !== 0) killed = true; if (pid !== 4242) throw new Error('ESRCH') }
  const out = await abortSession(deps, 'claude-code', SID)
  assert.equal(out.status, 409)
  assert.match(out.body.error, /not inside tmux/)
  assert.equal(killed, false)
})

test('opencode: the engine\'s own abort route on the server that holds the session', async () => {
  const seen = []
  const deps = {
    findServer: async (sid) => ({ base: 'http://127.0.0.1:4096', refused: [] }),
    engineHeaders: () => ({ authorization: 'Basic x' }),
    fetch: async (url, opts) => { seen.push([url, opts.method, opts.headers.authorization]); return { ok: true, status: 200, text: async () => 'true' } }
  }
  const out = await abortSession(deps, 'opencode', 'ses_abc123')
  assert.equal(out.status, 200)
  assert.deepEqual(seen, [['http://127.0.0.1:4096/session/ses_abc123/abort', 'POST', 'Basic x']])
})

test('opencode: no live server holds it → 404, and the engine refusing → 502 with its status', async () => {
  assert.equal((await abortSession({ findServer: async () => ({ base: null, refused: [] }) }, 'opencode', 'ses_x')).status, 404)
  const deps = {
    findServer: async () => ({ base: 'http://127.0.0.1:4096', refused: [] }),
    engineHeaders: () => ({}),
    fetch: async () => ({ ok: false, status: 401, text: async () => 'nope' })
  }
  const out = await abortSession(deps, 'opencode', 'ses_x')
  assert.equal(out.status, 502)
  assert.match(out.body.error, /401/)
})

test('acp (Codex, Gemini via iris acp run --keep): the holder\'s /cancel', async () => {
  const seen = []
  const deps = {
    findHolder: (sid) => (sid === 'acp_1' ? { port: 5111, token: 't', session_id: 'acp_1' } : null),
    callHolder: async (_f, rec, method, route) => { seen.push([rec.port, method, route]); return { status: 200, body: { cancelled: true } } },
    fetch: async () => {}
  }
  assert.equal((await abortSession(deps, 'acp', 'acp_1')).status, 200)
  assert.deepEqual(seen, [[5111, 'POST', '/cancel']])
  assert.equal((await abortSession(deps, 'acp', 'acp_nope')).status, 404)
})

test('an unknown harness is refused by name — never a silent success', async () => {
  const out = await abortSession({}, 'cursor', 'x1')
  assert.equal(out.status, 400)
  assert.match(out.body.error, /cursor/)
  assert.deepEqual(PROVIDERS.sort(), ['acp', 'claude-code', 'opencode'])
})

test('a session id with characters no session id has is refused before anything runs', async () => {
  const { deps, calls } = claudeDeps()
  for (const bad of ['', 'a b', 'x;rm -rf /', '../etc', 'a'.repeat(200)]) {
    assert.equal((await abortSession(deps, 'claude-code', bad)).status, 400, bad)
  }
  assert.equal(calls.length, 0)
})

// ── The real thing: tmux delivers an Escape keystroke to the pane ─────────────────────────────
const haveTmux = spawnSync('tmux', ['-V']).status === 0
test('REAL tmux: the Escape reaches the pane (a `cat -v` pane prints it as ^[)', { skip: !haveTmux && 'tmux not installed' }, async () => {
  const sock = path.join(os.tmpdir(), `abort-${process.pid}.sock`)
  execFileSync('tmux', ['-S', sock, 'new-session', '-d', '-x', '80', '-y', '5', 'cat -v'])
  try {
    const panePid = Number(execFileSync('tmux', ['-S', sock, 'list-panes', '-F', '#{pane_pid}'], { encoding: 'utf8' }).trim())
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'abort-real-'))
    fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', 'sessions', `${panePid}.json`), JSON.stringify({ sessionId: SID, pid: panePid }))
    const deps = {
      fs,
      home,
      kill: (pid, sig) => process.kill(pid, sig),
      ps: () => execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { encoding: 'utf8' }),
      tmux: (args) => execFileSync('tmux', args[0] === 'list-panes' ? ['-S', sock, ...args] : args, { encoding: 'utf8' })
    }
    const out = await abortSession(deps, 'claude-code', SID)
    assert.equal(out.status, 200, JSON.stringify(out.body))
    execFileSync('tmux', ['-S', sock, 'send-keys', '-t', out.body.pane, 'Enter'])
    await new Promise((resolve) => setTimeout(resolve, 300))
    const screen = execFileSync('tmux', ['-S', sock, 'capture-pane', '-p'], { encoding: 'utf8' })
    assert.match(screen, /\^\[/)
  } finally {
    spawnSync('tmux', ['-S', sock, 'kill-server'])
  }
})

// ── Wiring: the task the platform sends, and the bridge route it calls ────────────────────────
const EXEC = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'task-executor.js'), 'utf8')
const BRIDGE = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')

test('session_abort is refused first while "Allow access to this computer" is OFF', () => {
  const at = EXEC.indexOf("case 'session_abort': {")
  const refusal = EXEC.indexOf('remoteAccessAllowed()', at)
  const firstUse = EXEC.indexOf('abortConfig.session_id', at)
  assert.ok(at > 0 && refusal > at && refusal < firstUse, 'the refusal must come before the task is looked at')
})

test('session_abort validates the id and the provider before they reach a shell line', () => {
  const body = EXEC.slice(EXEC.indexOf("case 'session_abort': {"), EXEC.indexOf("case 'social_feed_sync': {"))
  const curlAt = body.indexOf('curl -sS')
  assert.ok(body.indexOf('[A-Za-z0-9_-]{1,128}') < curlAt && body.indexOf('[a-z0-9-]{1,32}') < curlAt)
  assert.match(body, /--fail-with-body/)
  assert.match(body, /\/api\/sessions\/\$\{abortProvider\}\/\$\{abortSid\}\/abort/)
})

test('the bridge exposes POST /api/sessions/:provider/:id/abort, wired to lib/session-abort', () => {
  const at = BRIDGE.indexOf("app.post('/api/sessions/:provider/:id/abort'")
  assert.ok(at > 0)
  assert.match(BRIDGE.slice(at, at + 1200), /require\('\.\/lib\/session-abort'\)/)
})
