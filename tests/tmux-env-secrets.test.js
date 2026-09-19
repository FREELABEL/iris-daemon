const { describe, it, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

// An isolated tmux server for the integration test — never the live daemon's `iris` socket.
process.env.IRIS_TMUX_SOCKET = `iris-test-${process.pid}`
const { TmuxManager } = require('../daemon/tmux-manager')

/**
 * #186280 — the daemon put every environment variable of a task on the tmux command line
 * (`tmux new-session -e HEYIRIS_TOKEN=… -e NODE_API_KEY=…`). Process arguments are readable by
 * every process on the machine, and the FIRST session's arguments stay on the tmux SERVER's
 * command line for as long as the server lives — seen on 2026-09-19 in a plain `pgrep -fl tmux`,
 * hours after the task started.
 *
 * The rule these tests hold: no value from a task's environment appears in any argument the
 * daemon hands to tmux. The environment still reaches the command — through a 0600 file the
 * wrapper sources and deletes before the command runs.
 */

const SECRET = 's3cr3t-token-do-not-leak'
const QUOTED = "key-with-'quote'-and $dollar"

function captured () {
  const m = new TmuxManager()
  m.available = true
  const calls = []
  m._exec = (args) => { calls.push(args); return '' }
  m._execSafe = (args) => { calls.push(args); return '' }
  return { m, calls }
}

const argvHas = (calls, needle) => calls.some(a => a.some(x => String(x).includes(needle)))
const envFileOf = (calls) => {
  const joined = calls.map(a => a.join(' ')).join('\n')
  const m = joined.match(/\. '?([^';\s]+\.env)'?/)
  return m ? m[1] : null
}

describe('tmux: task secrets never reach a command line (#186280)', () => {
  it('createForTask: no env VALUE appears in any tmux argument', () => {
    const { m, calls } = captured()
    m.createForTask({ id: 'sec-1', type: 'test' }, 'echo', ['hi'], { HEYIRIS_TOKEN: SECRET, NODE_API_KEY: QUOTED, PLAIN: 'x' }, os.tmpdir())
    assert.equal(argvHas(calls, SECRET), false, 'the token is in the tmux argv')
    assert.equal(argvHas(calls, 'key-with-'), false, 'the api key is in the tmux argv')
    assert.equal(calls.some(a => a.includes('-e')), false, 'env still passed with -e')
  })

  it('createForTask: the env goes to a 0600 file in a 0700 dir, and the wrapper sources then deletes it', () => {
    const { m, calls } = captured()
    m.createForTask({ id: 'sec-2', type: 'test' }, 'echo', ['hi'], { HEYIRIS_TOKEN: SECRET }, os.tmpdir())
    const file = envFileOf(calls)
    assert.ok(file, 'the wrapped command does not source an env file')
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
    assert.match(fs.readFileSync(file, 'utf8'), new RegExp(`export HEYIRIS_TOKEN='${SECRET}'`))
    const cmd = calls.find(a => a[0] === 'new-session').at(-1)
    assert.ok(cmd.indexOf(`. `) < cmd.indexOf('rm -f'), 'sourced before removed')
    assert.ok(cmd.indexOf('rm -f') < cmd.indexOf('echo hi'), 'removed before the command runs')
    fs.unlinkSync(file)
  })

  it('a value with quotes and $ survives the file exactly (no shell expansion)', () => {
    const { m, calls } = captured()
    m.createForTask({ id: 'sec-3', type: 'test' }, 'echo', ['hi'], { NODE_API_KEY: QUOTED }, os.tmpdir())
    const file = envFileOf(calls)
    const out = execFileSync('/bin/sh', ['-c', `. '${file}'; printf %s "$NODE_API_KEY"`]).toString()
    assert.equal(out, QUOTED)
    fs.unlinkSync(file)
  })

  it('a name that is not a shell identifier is dropped, never written as code', () => {
    const { m, calls } = captured()
    m.createForTask({ id: 'sec-4', type: 'test' }, 'echo', ['hi'], { 'BAD; rm -rf ~': 'x', GOOD: 'y' }, os.tmpdir())
    const text = fs.readFileSync(envFileOf(calls), 'utf8')
    assert.equal(text.includes('rm -rf'), false)
    assert.match(text, /export GOOD='y'/)
    fs.unlinkSync(envFileOf(calls))
  })

  it('createSwarm: no role\'s env value appears in any tmux argument', () => {
    const { m, calls } = captured()
    m.createSwarm('sec-5', [
      { name: 'a', cmd: 'echo', args: ['a'], env: { HEYIRIS_TOKEN: SECRET }, cwd: os.tmpdir() },
      { name: 'b', cmd: 'echo', args: ['b'], env: { NODE_API_KEY: QUOTED }, cwd: os.tmpdir() },
    ])
    assert.equal(argvHas(calls, SECRET), false)
    assert.equal(argvHas(calls, 'key-with-'), false)
    for (const a of calls) { const f = a.join(' ').match(/\. '?([^';\s]+\.env)'?/); if (f) try { fs.unlinkSync(f[1]) } catch {} }
  })
})

// ── against a real tmux server ────────────────────────────────────────────────
let hasTmux = true
try { execFileSync('tmux', ['-V']) } catch { hasTmux = false }

describe('tmux: end to end on an isolated server', { skip: !hasTmux && 'tmux not installed' }, () => {
  const socket = process.env.IRIS_TMUX_SOCKET
  after(() => { try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }) } catch {} })

  it('the command sees the secret; no process argument on the machine contains it; the file is gone', async () => {
    const m = new TmuxManager()
    m.available = true
    const s = m.createForTask({ id: `sec-e2e-${process.pid}`, type: 'test' }, '/bin/sh', ['-c', 'printf %s "$HEYIRIS_TOKEN"; sleep 1'], { HEYIRIS_TOKEN: SECRET }, os.tmpdir())
    const name = s.sessionName || s
    // While the session is running, the tmux SERVER (started by this session) is alive.
    const ps = execFileSync('ps', ['-Ao', 'args']).toString()
    assert.equal(ps.includes(SECRET), false, 'a process argument contains the secret')
    const info = m.sessions.get(name)
    const deadline = Date.now() + 15000
    while (!fs.existsSync(info.exitFile) && Date.now() < deadline) await new Promise(r => setTimeout(r, 200))
    assert.ok(fs.existsSync(info.exitFile), 'the command never finished')
    const stdout = fs.readFileSync(path.join(os.homedir(), '.iris', 'tmux-logs', `${name}.stdout`), 'utf8')
    assert.equal(stdout, SECRET, 'the command did not receive the env')
    const envDir = path.join(os.homedir(), '.iris', 'tmux-env')
    assert.equal(fs.readdirSync(envDir).filter(f => f.startsWith(name)).length, 0, 'env file left on disk')
    m.cleanup(name)
  })
})
