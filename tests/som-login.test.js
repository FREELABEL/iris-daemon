// #191636 — `iris som login <handle>`: a headed window, a human login, a verified save.
// Fakes only: no browser, no network, no launchctl, no real instagram-auth file (temp dirs).
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')

const igLogin = require('../som/helpers/ig-login')
const gui = require('../som/helpers/gui-launch')
const login = require('../som/login')
const ig = require('../som/helpers/ig-accounts')

function tmp () { return fs.mkdtempSync(path.join(os.tmpdir(), 'som-login-')) }
function session (userId) {
  return {
    cookies: [
      { name: 'sessionid', value: `${userId}%3Afake`, domain: '.instagram.com', path: '/' },
      { name: 'ds_user_id', value: String(userId), domain: '.instagram.com', path: '/' },
    ],
    origins: [],
  }
}

/**
 * A fake headed browser. `script` is called on every poll with the poll number and may:
 * log the person in (return a userId), or close the window. Nothing is ever typed by us.
 */
function fakeBrowser ({ loginAt = Infinity, userId = '111', closeAt = Infinity, viewerAt = 0, onlyWindow = false } = {}) {
  const browser = new EventEmitter()
  const page = new EventEmitter()
  const calls = { goto: [], fill: 0, type: 0, closed: false, identify: 0 }
  let polls = 0
  page.goto = async (url) => { calls.goto.push(url) }
  page.fill = () => { calls.fill++ }
  page.type = () => { calls.type++ }
  const context = {
    newPage: async () => page,
    cookies: async () => {
      polls++
      if (polls >= closeAt) { page.emit('close'); if (!onlyWindow) browser.emit('disconnected'); return [] }
      return polls >= loginAt ? session(userId).cookies : [{ name: 'csrftoken', value: 'x', domain: '.instagram.com' }]
    },
    storageState: async () => session(userId),
  }
  browser.close = async () => { calls.closed = true }
  return { launch: async () => ({ browser, context }), calls, polls: () => polls, viewerAt }
}

const instant = { sleep: async () => {} }
function fakeClock (stepMs = 1000) { let t = 0; return () => (t += stepMs) }

test('a login verified as the handle is saved through writeAuthFile, stamped', async () => {
  const dir = tmp()
  const b = fakeBrowser({ loginAt: 3, userId: '111' })
  const r = await igLogin.runLogin({ handle: '@HeyIris.io', somDir: dir, launch: b.launch, identify: async () => ({ username: 'heyiris.io' }), ...instant, clock: fakeClock() })
  assert.strictEqual(r.outcome, 'saved', r.message)
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'instagram-auth-heyiris.io.json'), 'utf8'))
  assert.strictEqual(saved[ig.STAMP_KEY].handle, 'heyiris.io')
  assert.strictEqual(saved[ig.STAMP_KEY].userId, '111')
  assert.strictEqual(ig.pulledSessionProblem('heyiris.io', saved), '')
  assert.deepStrictEqual(b.calls.goto, [igLogin.LOGIN_URL])
  assert.strictEqual(b.calls.fill + b.calls.type, 0, 'never types anything into the page')
  assert.ok(b.calls.closed, 'the browser is closed afterwards')
})

test('logged in as a different account: refused, nothing written', async () => {
  const dir = tmp()
  const b = fakeBrowser({ loginAt: 2, userId: '222' })
  const r = await igLogin.runLogin({ handle: 'thediscoverpage_', somDir: dir, launch: b.launch, identify: async () => ({ username: 'freelabelnet' }), ...instant, clock: fakeClock() })
  assert.strictEqual(r.outcome, 'mismatch')
  assert.strictEqual(r.viewer, 'freelabelnet')
  assert.match(r.message, /logged in as @freelabelnet, not @thediscoverpage_/)
  assert.deepStrictEqual(fs.readdirSync(dir), [])
  assert.strictEqual(igLogin.EXIT_CODES[r.outcome], 2)
})

test('the API naming a different user id than the cookie is refused too', async () => {
  const dir = tmp()
  const b = fakeBrowser({ loginAt: 1, userId: '333' })
  const r = await igLogin.runLogin({ handle: 'heyiris.io', somDir: dir, launch: b.launch, identify: async () => ({ username: 'heyiris.io', userId: '999' }), ...instant, clock: fakeClock() })
  assert.strictEqual(r.outcome, 'mismatch')
  assert.deepStrictEqual(fs.readdirSync(dir), [])
})

test('logged in but not yet identified (2FA screen): keeps waiting, saves once Instagram answers', async () => {
  const dir = tmp()
  const b = fakeBrowser({ loginAt: 1, userId: '444' })
  let asks = 0
  const identify = async () => (++asks < 3 ? { username: '' } : { username: 'heyiris.io' })
  const r = await igLogin.runLogin({ handle: 'heyiris.io', somDir: dir, launch: b.launch, identify, ...instant, clock: fakeClock() })
  assert.strictEqual(r.outcome, 'saved')
  assert.strictEqual(asks, 3)
})

test('the person closes the window: reported as closed, nothing written', async () => {
  const dir = tmp()
  const b = fakeBrowser({ closeAt: 4 })
  const r = await igLogin.runLogin({ handle: 'heyiris.io', somDir: dir, launch: b.launch, identify: async () => ({ username: 'heyiris.io' }), ...instant, clock: fakeClock() })
  assert.strictEqual(r.outcome, 'closed')
  assert.match(r.message, /window was closed/)
  assert.deepStrictEqual(fs.readdirSync(dir), [])
  assert.strictEqual(igLogin.EXIT_CODES[r.outcome], 3)
})

test('closing just the window (browser process still up) is also reported as closed', async () => {
  const dir = tmp()
  const b = fakeBrowser({ closeAt: 2, onlyWindow: true })
  const r = await igLogin.runLogin({ handle: 'heyiris.io', somDir: dir, launch: b.launch, identify: async () => ({ username: 'heyiris.io' }), timeoutMs: 60000, ...instant, clock: fakeClock() })
  assert.strictEqual(r.outcome, 'closed')
})

test('nobody logs in: times out, nothing written', async () => {
  const dir = tmp()
  const b = fakeBrowser({})
  const r = await igLogin.runLogin({ handle: 'heyiris.io', somDir: dir, launch: b.launch, identify: async () => ({ username: 'heyiris.io' }), timeoutMs: 10000, ...instant, clock: fakeClock(1000) })
  assert.strictEqual(r.outcome, 'timeout')
  assert.ok(b.polls() >= 5 && b.polls() <= 10, `polled until the deadline, not forever (${b.polls()})`)
  assert.deepStrictEqual(fs.readdirSync(dir), [])
  assert.ok(b.calls.closed)
})

test('a login another account\'s file already holds is refused (#191635), the other file untouched', async () => {
  const dir = tmp()
  const other = path.join(dir, 'instagram-auth-freelabelnet.json')
  fs.writeFileSync(other, JSON.stringify(session('555')))
  const before = fs.readFileSync(other, 'utf8')
  const b = fakeBrowser({ loginAt: 1, userId: '555' })
  const r = await igLogin.runLogin({ handle: 'thediscoverpage_', somDir: dir, launch: b.launch, identify: async () => ({ username: 'thediscoverpage_' }), ...instant, clock: fakeClock() })
  assert.strictEqual(r.outcome, 'refused')
  assert.match(r.message, /instagram-auth-freelabelnet\.json already holds/)
  assert.ok(!fs.existsSync(path.join(dir, 'instagram-auth-thediscoverpage_.json')))
  assert.strictEqual(fs.readFileSync(other, 'utf8'), before)
})

test('a browser that cannot open is an error, not a hang', async () => {
  const r = await igLogin.runLogin({ handle: 'heyiris.io', somDir: tmp(), launch: async () => { throw new Error("Executable doesn't exist") }, ...instant })
  assert.strictEqual(r.outcome, 'error')
  assert.match(r.message, /could not open a browser window/)
})

test('handles are validated before anything opens', () => {
  assert.strictEqual(igLogin.parseHandle(' @HeyIris.io '), 'heyiris.io')
  for (const bad of ['', 'a b', 'x;rm -rf ~', '../etc', 'a'.repeat(31), '<x>']) {
    assert.throws(() => igLogin.parseHandle(bad), /not an Instagram username/, bad)
  }
})

test('identifyViewer reads the inbox document, then falls back to current_user', async () => {
  const html = '..."should_show_public_contacts":false,"username":"heyiris.io",...'
  const ctxInbox = { request: { get: async () => ({ text: async () => html }) } }
  assert.strictEqual((await igLogin.identifyViewer(ctxInbox)).username, 'heyiris.io')
  const seen = []
  const ctxApi = { request: { get: async (url, opts) => {
    seen.push([url, opts && opts.headers])
    if (url.includes('/direct/inbox')) return { text: async () => '<html>no viewer</html>' }
    return { json: async () => ({ user: { username: 'freelabelnet', pk: 42 } }) }
  } } }
  const who = await igLogin.identifyViewer(ctxApi)
  assert.deepStrictEqual([who.username, who.userId], ['freelabelnet', '42'])
  assert.ok(seen[1][1]['X-IG-App-ID'])
  const ctxNone = { request: { get: async () => { throw new Error('offline') } } }
  assert.strictEqual((await igLogin.identifyViewer(ctxNone)).username, '')
})

// ── macOS GUI session launch ──

test('the window is launched as a one-shot Interactive Aqua LaunchAgent in gui/<uid>', () => {
  const label = gui.jobLabel('heyiris.io', 'ab12')
  assert.strictEqual(label, 'io.heyiris.som-login.heyiris.io.ab12')
  const c = gui.commands({ uid: 501, label, plistPath: '/x/p.plist' })
  assert.deepStrictEqual(c.bootstrap, ['launchctl', ['bootstrap', 'gui/501', '/x/p.plist']])
  assert.deepStrictEqual(c.bootout, ['launchctl', ['bootout', `gui/501/${label}`]])
  assert.deepStrictEqual(c.consoleOwner, ['stat', ['-f', '%u', '/dev/console']])
  const xml = gui.buildPlist({ label, programArguments: ['/n/node', '/b/som/login.js', 'heyiris.io', '--run-window'], env: { HOME: '/Users/a&b' } })
  assert.match(xml, /<key>ProcessType<\/key><string>Interactive<\/string>/)
  assert.match(xml, /<key>LimitLoadToSessionType<\/key><string>Aqua<\/string>/)
  assert.match(xml, /<key>KeepAlive<\/key><false\/>/)
  assert.match(xml, /<string>\/b\/som\/login\.js<\/string>\s*<string>heyiris\.io<\/string>\s*<string>--run-window<\/string>/)
  assert.match(xml, /\/Users\/a&amp;b/)
  assert.doesNotMatch(xml, /Background/)
})

function fakeLaunchd ({ consoleUid = '501', bootStatus = 0, onBoot = () => {}, running = true } = {}) {
  const ran = []
  const exec = (cmd, args) => {
    ran.push([cmd, ...args])
    if (cmd === 'stat') return { status: 0, stdout: `${consoleUid}\n` }
    if (args[0] === 'bootstrap') { if (bootStatus === 0) onBoot(); return { status: bootStatus, stderr: bootStatus ? 'Bootstrap failed: 5: Input/output error' : '' } }
    if (args[0] === 'print') return { status: running ? 0 : 113, stdout: running ? 'state = running' : '' }
    return { status: 0 }
  }
  return { exec, ran }
}

test('login.js on macOS bootstraps the window into the GUI session and relays its result', async () => {
  const home = tmp()
  const out = []
  let resultPath = null
  const ld = fakeLaunchd({ onBoot: () => {
    // what the LaunchAgent's runner would write
    fs.writeFileSync(resultPath, JSON.stringify({ outcome: 'saved', handle: 'heyiris.io', message: 'verified as @heyiris.io' }))
  } })
  const exec = (cmd, args) => {
    if (args[0] === 'bootstrap') {
      const plist = fs.readFileSync(args[2], 'utf8')
      resultPath = /<string>--result<\/string>\s*<string>([^<]+)<\/string>/.exec(plist)[1]
    }
    return ld.exec(cmd, args)
  }
  const code = await login.main(['heyiris.io', '--timeout', '60'], { platform: 'darwin', uid: 501, home, exec, nodePath: '/n/node', print: (l) => out.push(l), ...instant })
  assert.strictEqual(code, 0, out.join('\n'))
  const kinds = ld.ran.map(r => `${r[0]} ${r[1]}`)
  assert.deepStrictEqual(kinds.slice(0, 3), ['stat -f', 'launchctl bootout', 'launchctl bootstrap'])
  assert.strictEqual(kinds[kinds.length - 1], 'launchctl bootout', 'the job is removed afterwards')
  const boot = ld.ran.find(r => r[1] === 'bootstrap')
  assert.strictEqual(boot[2], 'gui/501')
  const plist = fs.readFileSync(boot[3], 'utf8')
  assert.match(plist, /<string>\/n\/node<\/string>/)
  assert.match(plist, /som\/login\.js<\/string>\s*<string>heyiris\.io<\/string>\s*<string>--run-window<\/string>/)
  assert.match(out.join('\n'), /OK: verified as @heyiris\.io/)
})

test('macOS with nobody at the screen: refused before anything starts', async () => {
  const ld = fakeLaunchd({ consoleUid: '0' })
  const out = []
  const code = await login.main(['heyiris.io'], { platform: 'darwin', uid: 501, home: tmp(), exec: ld.exec, print: (l) => out.push(l), ...instant, clock: fakeClock(1000) })
  assert.strictEqual(code, 1)
  assert.match(out.join('\n'), /nobody is logged in at this Mac's screen/)
  assert.ok(!ld.ran.some(r => r[1] === 'bootstrap'))
})

test('macOS: a bootstrap launchd refuses, or a window process that dies silently, is reported', async () => {
  const out = []
  const refused = fakeLaunchd({ bootStatus: 5 })
  assert.strictEqual(await login.main(['heyiris.io'], { platform: 'darwin', uid: 501, home: tmp(), exec: refused.exec, print: (l) => out.push(l), ...instant, clock: fakeClock(1000) }), 1)
  assert.match(out.join('\n'), /launchd would not start the login window/)
  const died = fakeLaunchd({ running: false })
  const out2 = []
  const code = await login.main(['heyiris.io'], { platform: 'darwin', uid: 501, home: tmp(), exec: died.exec, print: (l) => out2.push(l), ...instant, clock: fakeClock(1000) })
  assert.strictEqual(code, 1)
  assert.match(out2.join('\n'), /exited without a result/)
})

test('planLaunch: Mac → GUI session; Linux needs a display; the GUI job runs in-process', () => {
  assert.strictEqual(login.planLaunch({ platform: 'darwin', env: {} }).mode, 'gui-session')
  assert.strictEqual(login.planLaunch({ platform: 'darwin', env: {}, runWindow: true }).mode, 'in-process')
  assert.strictEqual(login.planLaunch({ platform: 'linux', env: { DISPLAY: ':0' } }).mode, 'in-process')
  assert.strictEqual(login.planLaunch({ platform: 'linux', env: {} }).mode, 'refuse')
})

test('--run-window writes the result file the GUI-session waiter reads', async () => {
  const dir = tmp()
  const result = path.join(dir, 'result.json')
  const b = fakeBrowser({ loginAt: 1, userId: '777' })
  const code = await login.main(['heyiris.io', '--run-window', '--result', result, '--som-dir', dir],
    { launch: b.launch, identify: async () => ({ username: 'heyiris.io' }), print: () => {} })
  assert.strictEqual(code, 0)
  assert.strictEqual(JSON.parse(fs.readFileSync(result, 'utf8')).outcome, 'saved')
  assert.ok(fs.existsSync(path.join(dir, 'instagram-auth-heyiris.io.json')))
})
