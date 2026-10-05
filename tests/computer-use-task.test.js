/**
 * computer_use (#187922) — the desktop lane, run against a FAKE Cua Driver.
 *
 * The real driver needs a logged-in desktop with Accessibility + Screen Recording granted (or a
 * Lume VM); neither exists on CI or this dev box. The adapter boundary is exactly where the fake
 * sits, so the loop under test — ask, act, report, stop — is the one production runs.
 */
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { runComputerUseTask, validate, shapes, splitImages, quietEnv, createDriver } = require('../daemon/computer-use-task')

const ROOT = path.resolve(__dirname, '..')
const PNG = Buffer.from('fake-png-bytes').toString('base64')

function fakeDriver (results = {}) {
  const calls = []
  return {
    calls,
    started: 0,
    stopped: 0,
    async start () { this.started++ },
    async call (tool, args) {
      calls.push({ tool, args })
      const r = results[tool]
      if (r instanceof Error) throw r
      return r || { ok: true }
    },
    async stop () { this.stopped++ }
  }
}

function task (config = {}, extra = {}) {
  return {
    id: 'cu-1',
    type: 'computer_use',
    config: {
      desktop: 'linux',
      steps: [
        { tool: 'list_apps', args: {} },
        { tool: 'type_text', args: { text: 'Jane Roe chart 448812' } },
        { tool: 'get_window_state', args: { pid: 42 } }
      ],
      ...config
    },
    ...extra
  }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cu-test-'))

describe('computer_use: validation mirrors the server', () => {
  it('needs an explicit desktop and only contract tools', () => {
    assert.throws(() => validate({ steps: [{ tool: 'list_apps' }] }), /config.desktop/)
    assert.throws(() => validate({ desktop: 'linux', steps: [{ tool: 'escalate_session' }] }), /not allowed/)
    assert.throws(() => validate({ desktop: 'linux', steps: [] }), /config.steps/)
    assert.ok(validate({ desktop: 'host', steps: [{ tool: 'click', args: { x: 1, y: 2 } }] }))
  })
})

describe('computer_use: the scripted task completes', () => {
  it('runs every step through the driver, asks before each, and reports shapes only', async () => {
    const drv = fakeDriver()
    const asked = []
    const r = await runComputerUseTask(task(), { driver: drv, step: async (b) => { asked.push(b); return { continue: true } }, taskDir: tmp() })
    assert.equal(r.status, 'completed', r.error)
    assert.deepEqual(drv.calls.map(c => c.tool), ['list_apps', 'type_text', 'get_window_state'])
    assert.equal(drv.started, 1)
    assert.equal(drv.stopped, 1)
    // one ask before and one report after each step
    assert.deepEqual(asked.map(a => a.phase), ['tool_call', 'tool_result', 'tool_call', 'tool_result', 'tool_call', 'tool_result'])
    assert.deepEqual(asked[2].arguments, { text: 'string' })
    assert.ok(!JSON.stringify(asked).includes('Jane Roe'), 'typed text never leaves in a step event')
    assert.ok(!JSON.stringify(r).includes('Jane Roe'), 'nor in the result')
  })
})

describe('computer_use: the kill switch', () => {
  it('stops before the next action when the cloud says stop (agent paused mid-run)', async () => {
    const drv = fakeDriver()
    let n = 0
    const r = await runComputerUseTask(task(), {
      driver: drv,
      taskDir: tmp(),
      step: async (b) => {
        n++
        // the operator pauses the agent after the first step has been reported
        return n <= 2 ? { continue: true } : { continue: false, reason: 'Agent is paused manually by an operator.' }
      }
    })
    assert.equal(r.status, 'failed')
    assert.match(r.error, /paused manually/)
    assert.deepEqual(drv.calls.map(c => c.tool), ['list_apps'], 'type_text must never run')
    assert.equal(r.metadata.stopped, true)
    assert.equal(drv.stopped, 1, 'the desktop is torn down even when stopped')
  })

  it('fails closed when the kill switch cannot be reached', async () => {
    const drv = fakeDriver()
    const r = await runComputerUseTask(task(), { driver: drv, taskDir: tmp(), step: async () => { throw new Error('ECONNREFUSED') } })
    assert.equal(r.status, 'failed')
    assert.match(r.error, /could not reach the kill switch/)
    assert.equal(drv.calls.length, 0)
  })

  it('honours the node\'s own pause between steps', async () => {
    const drv = fakeDriver()
    let paused = false
    const r = await runComputerUseTask(task(), {
      driver: drv,
      taskDir: tmp(),
      step: async (b) => { if (b.phase === 'tool_result') paused = true; return { continue: true } },
      isPaused: () => paused
    })
    assert.match(r.error, /node is paused/)
    assert.equal(drv.calls.length, 1)
  })
})

describe('computer_use: PHI — screens stay on the node', () => {
  const shot = { get_window_state: { elements: [{ role: 'row', element_token: 't1' }], screenshot: PNG, content: [{ type: 'image', data: PNG }] } }

  it('never uploads, never sends an image, and keeps the pictures in the task dir', async () => {
    const drv = fakeDriver(shot)
    const dir = tmp()
    const sent = []
    let uploads = 0
    const r = await runComputerUseTask(task({ phi: true, upload_screenshots: true }), {
      driver: drv,
      taskDir: dir,
      step: async (b) => { sent.push(b); return { continue: true } },
      upload: async () => { uploads++; return [] }
    })
    assert.equal(r.status, 'completed', r.error)
    assert.equal(uploads, 0, 'a PHI task never calls upload')
    assert.ok(!JSON.stringify(sent).includes(PNG), 'no step event carries a screen')
    assert.ok(!JSON.stringify(r).includes(PNG), 'the result carries no screen')
    assert.equal(r.data.screenshots_kept_on_node, 2)
    assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.png')).length, 2)
  })

  it('a non-PHI task that opts in does upload its screenshots', async () => {
    const drv = fakeDriver(shot)
    let uploaded = []
    const r = await runComputerUseTask(task({ upload_screenshots: true }), {
      driver: drv,
      taskDir: tmp(),
      step: async () => ({ continue: true }),
      upload: async (files) => { uploaded = files; return files.map(f => ({ filename: f.filename, url: 'https://cdn/x' })) }
    })
    assert.equal(r.status, 'completed')
    assert.equal(uploaded.length, 2)
    assert.equal(r.data.screenshots.length, 2)
  })
})

describe('computer_use: helpers and wiring', () => {
  it('splitImages strips named and MCP image blocks', () => {
    const [clean, imgs] = splitImages({ a: 1, screenshot: 'x', content: [{ type: 'image', data: 'y' }, { type: 'text', text: 'ok' }] })
    assert.equal(imgs.length, 2)
    assert.equal(clean.screenshot, '[kept on node]')
    assert.equal(clean.content[1].text, 'ok')
  })

  it('shapes keeps keys and types only', () => {
    assert.deepEqual(shapes({ x: 1, text: 'hi', on: true, keys: ['a'] }), { x: 'integer', text: 'string', on: 'boolean', keys: 'array' })
  })

  it('every process gets the documented telemetry off switches (Cua Driver and Lume default ON)', () => {
    const env = quietEnv({})
    assert.equal(env.DO_NOT_TRACK, '1')
    assert.equal(env.CUA_DRIVER_RS_TELEMETRY_ENABLED, 'false')
    assert.equal(env.LUME_TELEMETRY_ENABLED, 'false')
  })

  it('the linux desktop runs with no network and the documented call shape', async () => {
    const seen = []
    const drv = createDriver('linux', {}, { exec: async (cmd, args) => { seen.push([cmd, ...args]); return cmd === 'docker' && args[0] === 'run' ? 'cid\n' : '{"apps":[]}' } })
    await drv.start()
    const r = await drv.call('list_apps', {})
    await drv.stop()
    assert.deepEqual(seen[0].slice(0, 5), ['docker', 'run', '-d', '--rm', '--network'])
    assert.equal(seen[0][5], 'none')
    assert.deepEqual(seen[1], ['docker', 'exec', 'cid', 'cua-driver', 'call', 'list_apps', '{}'])
    assert.deepEqual(r, { apps: [] })
  })

  it('the executor short-circuits computer_use and the heartbeat advertises it', () => {
    const executor = fs.readFileSync(path.join(ROOT, 'daemon/task-executor.js'), 'utf8')
    const index = fs.readFileSync(path.join(ROOT, 'daemon/index.js'), 'utf8')
    assert.ok(executor.includes("task.type === 'computer_use'"))
    assert.ok(executor.includes("'computer_use'])"), 'listed in KNOWN_STRUCTURED_TYPES')
    assert.ok(index.includes("require('./computer-use-task').computerUseCapabilities()"))
  })
})
