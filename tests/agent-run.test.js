'use strict'

/**
 * agent_run — the daemon side of V6 `run_on_node` (#189970, epic #189973).
 *
 * The runtime process is mocked: these tests pin the CONTRACT (what is refused, what argv and
 * permissions each harness gets, what comes back as stdout, the timeout) and the capability
 * advertisement, not the behaviour of claude/opencode themselves.
 */

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')

const agentRun = require('../daemon/agent-run')
const { TaskExecutor } = require('../daemon/task-executor')

function task (over = {}, ron = {}, agent = {}) {
  return {
    id: 'task-ar-1',
    type: 'agent_run',
    prompt: 'list my TODOs',
    timeout_seconds: 60,
    config: {
      run_on_node: {
        version: 1,
        runtime: 'claude_code',
        agent: { id: 42, name: 'Scout', system_prompt: 'You are Scout.', model: null, tools: ['web_search'], ...agent },
        prompt: 'list my TODOs',
        requested_by_user_id: 193,
        conversation_id: 'conv:42:193',
        ...ron
      }
    },
    ...over
  }
}

/** A fake child process. `behave(child, cmd, args, opts)` drives it. */
function fakeSpawn (behave) {
  const calls = []
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    child.exitCode = null
    child.signalCode = null
    child.killed = []
    let stdin = ''
    child.stdin.on('data', (d) => { stdin += d })
    child.kill = (sig) => {
      child.killed.push(sig)
      child.signalCode = sig
      setImmediate(() => child.emit('close', null, sig))
    }
    const call = { cmd, args, opts, child, get stdin () { return stdin } }
    calls.push(call)
    child.stdin.on('finish', () => setImmediate(() => behave(child, call)))
    return child
  }
  spawn.calls = calls
  return spawn
}

function exitWith (code, out = '', err = '') {
  return (child) => {
    if (out) child.stdout.write(out)
    if (err) child.stderr.write(err)
    child.stdout.end(); child.stderr.end()
    child.exitCode = code
    setImmediate(() => child.emit('close', code))
  }
}

const ALL = ['claude_code', 'opencode', 'local_llm']
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-run-test-'))

describe('agent_run payload validation (protocol v1)', () => {
  it('accepts a complete v1 payload', () => {
    const v = agentRun.validateAgentRun(task(), ALL)
    assert.equal(v.error, undefined)
    assert.equal(v.spec.runtime, 'claude_code')
    assert.equal(v.spec.timeoutSeconds, 60)
  })

  it('refuses a task with no config.run_on_node — even if config.runtime is set', () => {
    const t = { id: 'x', type: 'agent_run', prompt: 'rm -rf ~', config: { runtime: 'claude_code' } }
    assert.match(agentRun.validateAgentRun(t, ALL).error, /config\.run_on_node is missing/)
  })

  it('refuses an unknown protocol version', () => {
    assert.match(agentRun.validateAgentRun(task({}, { version: 2 }), ALL).error, /protocol version 2 is not supported/)
    assert.match(agentRun.validateAgentRun(task({}, { version: '1' }), ALL).error, /not supported/)
  })

  it('refuses an unknown runtime and a runtime this machine lacks', () => {
    assert.match(agentRun.validateAgentRun(task({}, { runtime: 'gemini_cli' }), ALL).error, /unknown runtime/)
    assert.match(agentRun.validateAgentRun(task({}, { runtime: 'opencode' }), ['claude_code']).error, /"opencode" is not available on this machine \(available: claude_code\)/)
    assert.match(agentRun.validateAgentRun(task(), []).error, /available: none/)
  })

  it('refuses missing fields and names every one', () => {
    const t = task({}, { prompt: '', conversation_id: undefined, requested_by_user_id: null }, { system_prompt: '  ' })
    delete t.config.run_on_node.agent.tools
    const e = agentRun.validateAgentRun(t, ALL).error
    for (const f of ['agent.system_prompt', 'agent.tools', 'prompt', 'requested_by_user_id', 'conversation_id']) assert.ok(e.includes(f), `${f} in: ${e}`)
    assert.match(agentRun.validateAgentRun(task({}, { agent: null }), ALL).error, /agent is missing/)
  })

  it('caps timeout_seconds at 300', () => {
    assert.equal(agentRun.validateAgentRun(task({ timeout_seconds: 9999 }), ALL).spec.timeoutSeconds, 300)
  })

  it('a refused task never spawns anything and comes back failed with the reason', async () => {
    const spawn = fakeSpawn(exitWith(0, 'should not run'))
    const r = await agentRun.runAgentRun(task({}, { version: 99 }), { available: ALL, spawn, workDir: tmp() })
    assert.equal(spawn.calls.length, 0)
    assert.equal(r.status, 'failed')
    assert.equal(r.stdout, '')
    assert.match(r.error, /version 99/)
  })
})

describe('tool allowlist → harness permissions', () => {
  it('maps only tools with a local equivalent; null and unknown map to nothing', () => {
    assert.deepEqual(agentRun.allowlistCapabilities(null), [])
    assert.deepEqual(agentRun.allowlistCapabilities(['manageLeads', 'send_email']), [])
    assert.deepEqual(agentRun.allowlistCapabilities(['web_search', 'run_iris_command', 'Read_File']), ['iris_cli', 'read_files', 'web_search'])
  })

  it('claude_code: --tools holds exactly the mapped built-ins; Bash is pre-approved for iris only', () => {
    assert.deepEqual(agentRun.claudeToolFlags(null), { tools: [], allowed: [] })
    assert.deepEqual(agentRun.claudeToolFlags(['web_search', 'run_iris_command']), { tools: ['Bash', 'WebSearch'], allowed: ['Bash(iris:*)', 'WebSearch'] })
  })

  it('opencode: everything denied unless the allowlist grants it', () => {
    const none = agentRun.opencodePermission(null)
    for (const v of Object.values(none)) assert.equal(v, 'deny')
    const p = agentRun.opencodePermission(['web_fetch', 'run_iris_command'])
    assert.equal(p.webfetch, 'allow')
    assert.deepEqual(p.bash, { 'iris *': 'allow', '*': 'deny' })
    assert.equal(p.edit, 'deny')
    assert.equal(p.read, 'deny')
    assert.equal(p.external_directory, 'deny')
  })
})

describe('runAgentRun — per runtime', () => {
  it('claude_code: system prompt file, no tools, dontAsk, prompt on stdin, stdout = answer', async () => {
    const dir = tmp()
    const spawn = fakeSpawn(exitWith(0, '\nHere are your TODOs.\n'))
    const r = await agentRun.runAgentRun(task({}, {}, { tools: null, model: 'gpt-4.1-nano' }), { available: ALL, spawn, workDir: dir, claudeBin: '/bin/claude' })
    const c = spawn.calls[0]
    assert.equal(c.cmd, '/bin/claude')
    assert.deepEqual(c.args, ['--print', '--output-format', 'text', '--system-prompt-file', path.join(dir, 'agent-system-prompt.md'),
      '--tools', '', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--no-session-persistence'])
    assert.ok(!c.args.includes('--model'), 'a non-Claude model id is not passed to claude')
    assert.ok(!c.args.join(' ').includes('list my TODOs'), 'the prompt is not in argv')
    assert.equal(c.stdin, 'list my TODOs')
    assert.equal(c.opts.cwd, dir)
    const sys = fs.readFileSync(path.join(dir, 'agent-system-prompt.md'), 'utf8')
    assert.ok(sys.startsWith('You are Scout.'))
    assert.match(sys, /"Scout" \(id 42\)/)
    assert.equal(r.status, 'completed')
    assert.equal(r.stdout, 'Here are your TODOs.')
    assert.equal(r.exit_code, 0)
    assert.equal(r.metadata.runtime, 'claude_code')
  })

  it('claude_code: a Claude model and a mapped allowlist reach the argv', async () => {
    const spawn = fakeSpawn(exitWith(0, 'ok'))
    await agentRun.runAgentRun(task({}, {}, { tools: ['web_search', 'manageLeads'], model: 'claude-sonnet-4-5' }), { available: ALL, spawn, workDir: tmp() })
    const a = spawn.calls[0].args
    assert.equal(a[a.indexOf('--tools') + 1], 'WebSearch')
    assert.equal(a[a.indexOf('--allowedTools') + 1], 'WebSearch')
    assert.equal(a[a.indexOf('--model') + 1], 'claude-sonnet-4-5')
  })

  it('opencode: identity heads the message, permissions in env, last text part is the answer', async () => {
    const events = [
      { type: 'step_start', part: {} },
      { type: 'text', part: { text: 'thinking out loud' } },
      { type: 'tool_use', part: { tool: 'read' } },
      { type: 'text', part: { text: 'Final answer.' } }
    ].map((e) => JSON.stringify(e)).join('\n') + '\n'
    const spawn = fakeSpawn(exitWith(0, events))
    const r = await agentRun.runAgentRun(task({}, { runtime: 'opencode' }, { model: 'anthropic/claude-sonnet-4-5' }), { available: ALL, spawn, workDir: tmp(), opencodeBin: '/usr/bin/opencode' })
    const c = spawn.calls[0]
    assert.deepEqual(c.args.slice(0, 5), ['run', '--format', 'json', '--model', 'anthropic/claude-sonnet-4-5'])
    assert.ok(!c.args.includes('--standalone'))
    const msg = c.args.at(-1)
    assert.match(msg, /^<agent_instructions>\nYou are Scout\./)
    assert.ok(msg.endsWith('list my TODOs'))
    const perm = JSON.parse(c.opts.env.OPENCODE_PERMISSION)
    assert.equal(perm.websearch, 'allow')
    assert.equal(perm.bash, 'deny')
    assert.equal(r.stdout, 'Final answer.')
  })

  it('opencode via the iris CLI runs --standalone so the permissions apply', async () => {
    const spawn = fakeSpawn(exitWith(0, JSON.stringify({ type: 'text', part: { text: 'hi' } })))
    await agentRun.runAgentRun(task({}, { runtime: 'opencode' }), { available: ALL, spawn, workDir: tmp(), opencodeBin: '/home/x/.iris/bin/iris' })
    assert.deepEqual(spawn.calls[0].args.slice(0, 4), ['run', '--format', 'json', '--standalone'])
  })

  it('opencode: an error event with no answer fails with the error', async () => {
    const spawn = fakeSpawn(exitWith(0, JSON.stringify({ type: 'error', error: { name: 'X', data: { message: 'no provider' } } })))
    const r = await agentRun.runAgentRun(task({}, { runtime: 'opencode' }), { available: ALL, spawn, workDir: tmp() })
    assert.equal(r.status, 'failed')
    assert.match(r.error, /no provider/)
  })

  it('local_llm: system + user messages on stdin to curl; known model used, unknown dropped', async () => {
    const reply = JSON.stringify({ choices: [{ message: { content: 'local answer' } }] })
    const env = { LOCAL_LLM_BASE_URL: 'http://127.0.0.1:9', LOCAL_LLM_MODEL: 'qwen3:8b' }
    let spawn = fakeSpawn(exitWith(0, reply))
    let r = await agentRun.runAgentRun(task({}, { runtime: 'local_llm' }, { model: 'llama3:8b' }), { available: ALL, spawn, workDir: tmp(), env, localModels: ['llama3:8b'] })
    assert.equal(spawn.calls[0].cmd, 'curl')
    assert.ok(spawn.calls[0].args.includes('http://127.0.0.1:9/chat/completions'))
    const body = JSON.parse(spawn.calls[0].stdin)
    assert.equal(body.model, 'llama3:8b')
    assert.equal(body.messages[0].role, 'system')
    assert.match(body.messages[0].content, /^You are Scout\./)
    assert.deepEqual(body.messages[1], { role: 'user', content: 'list my TODOs' })
    assert.equal(r.stdout, 'local answer')

    spawn = fakeSpawn(exitWith(0, reply))
    r = await agentRun.runAgentRun(task({}, { runtime: 'local_llm' }, { model: 'gpt-4.1-nano' }), { available: ALL, spawn, workDir: tmp(), env, localModels: ['llama3:8b'] })
    assert.equal(JSON.parse(spawn.calls[0].stdin).model, 'qwen3:8b', 'a model the node lacks falls back to the node default')
  })

  it('a non-zero exit fails with stderr, and no answer leaks into stdout', async () => {
    const spawn = fakeSpawn(exitWith(1, 'partial', 'auth expired'))
    const r = await agentRun.runAgentRun(task(), { available: ALL, spawn, workDir: tmp() })
    assert.equal(r.status, 'failed')
    assert.equal(r.stdout, '')
    assert.equal(r.exit_code, 1)
    assert.match(r.error, /exited with code 1: auth expired/)
  })

  it('an empty answer is a failure, not a result', async () => {
    const spawn = fakeSpawn(exitWith(0, '   \n'))
    const r = await agentRun.runAgentRun(task(), { available: ALL, spawn, workDir: tmp() })
    assert.equal(r.status, 'failed')
    assert.match(r.error, /without an answer/)
  })

  it('enforces timeout_seconds: kills the harness and reports timeout', async () => {
    const spawn = fakeSpawn(() => { /* never exits */ })
    const r = await agentRun.runAgentRun(task({ timeout_seconds: 2 }), { available: ALL, spawn, workDir: tmp(), secondMs: 10, killGraceMs: 10 })
    assert.equal(r.status, 'timeout')
    assert.match(r.error, /timed out after 2s/)
    assert.deepEqual(spawn.calls[0].child.killed.slice(0, 1), ['SIGTERM'])
    assert.equal(r.stdout, '')
  })

  it('a missing binary is reported by name', async () => {
    const spawn = () => {
      const c = new EventEmitter()
      c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.stdin = new PassThrough()
      c.exitCode = null; c.signalCode = null
      setImmediate(() => c.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })))
      return c
    }
    const r = await agentRun.runAgentRun(task(), { available: ALL, spawn, workDir: tmp(), claudeBin: 'claude' })
    assert.equal(r.status, 'failed')
    assert.match(r.stderr, /claude is not installed/)
  })
})

describe('run_on_node capability advertisement', () => {
  const exe = (set) => (p) => set.has(p)

  it('lists only runtimes found on this machine', () => {
    const home = '/home/u'
    const env = { PATH: '/usr/bin' }
    assert.deepEqual(agentRun.runOnNodeCapability(agentRun.detectRuntimes({ home, env, exists: exe(new Set()) })), { version: 1, runtimes: [] })
    const found = agentRun.detectRuntimes({ home, env, exists: exe(new Set(['/usr/bin/claude'])) })
    assert.deepEqual(found, { claude_code: '/usr/bin/claude' })
    assert.deepEqual(agentRun.runOnNodeCapability(found), { version: 1, runtimes: ['claude_code'] })
  })

  it('finds the iris CLI in ~/.iris/bin as the opencode runtime', () => {
    const found = agentRun.detectRuntimes({ home: '/home/u', env: { PATH: '/usr/bin' }, exists: exe(new Set(['/home/u/.iris/bin/iris'])) })
    assert.deepEqual(found, { opencode: '/home/u/.iris/bin/iris' })
  })

  it('claims local_llm only when the model server answered with models', () => {
    const base = { home: '/h', env: { PATH: '' }, exists: () => false }
    assert.deepEqual(agentRun.detectRuntimes({ ...base, localModels: null }), {})
    assert.deepEqual(agentRun.detectRuntimes({ ...base, localModels: { available: true, models: [] } }), {})
    assert.deepEqual(agentRun.detectRuntimes({ ...base, localModels: { available: false, models: ['a'] } }), {})
    assert.deepEqual(agentRun.runOnNodeCapability(agentRun.detectRuntimes({ ...base, localModels: { available: true, models: ['qwen3:8b'] } })), { version: 1, runtimes: ['local_llm'] })
  })

  it('the executor advertises what it detects and the heartbeat sends it', () => {
    const ex = new TaskExecutor({}, {})
    ex.getLocalModelsReport = () => ({ available: true, models: ['qwen3:8b'] })
    ex.agentRunRuntimes({ fresh: true, deps: { home: '/h', env: { PATH: '/x' }, exists: (p) => p === '/x/claude' } })
    assert.deepEqual(ex.runOnNodeCapability(), { version: 1, runtimes: ['claude_code', 'local_llm'] })
    const src = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'index.js'), 'utf8')
    assert.match(src, /run_on_node: this\.executor\.runOnNodeCapability\(\)/)
  })
})

describe('executor wiring', () => {
  it('agent_run is a structured type and execute() short-circuits it before the runtime branch', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'task-executor.js'), 'utf8')
    assert.match(src, /KNOWN_STRUCTURED_TYPES = new Set\(\[[^\]]*'agent_run'/)
    const shortCircuit = src.indexOf("if (task.type === 'agent_run') {")
    const runtimeBranch = src.indexOf('result = await this.runRuntimeProcess(task, runtime')
    assert.ok(shortCircuit > 0 && shortCircuit < runtimeBranch)
  })

  it('runAgentRun on the executor uses detected binaries and registers the child for cancel', async () => {
    const ex = new TaskExecutor({}, {})
    ex.runningTasks = new Map()
    const spawn = fakeSpawn(exitWith(0, 'answer'))
    const r = await ex.runAgentRun(task(), { projectDir: tmp() }, { found: { claude_code: '/opt/claude' }, spawn })
    assert.equal(spawn.calls[0].cmd, '/opt/claude')
    assert.equal(ex.runningTasks.get('task-ar-1'), spawn.calls[0].child)
    assert.equal(r.stdout, 'answer')
    const refused = await ex.runAgentRun(task({}, { runtime: 'opencode' }), { projectDir: tmp() }, { found: { claude_code: '/opt/claude' }, spawn })
    assert.match(refused.error, /"opencode" is not available/)
  })
})
