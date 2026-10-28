'use strict'

// #191615: on iris-hive-001 (Ubuntu) `iris daemon restart` printed "Started unsupervised" —
// nothing restarted the daemon if it crashed. Worse, that host had a hand-written SYSTEM unit,
// so `restart` killed systemd's child and started a nohup copy beside the one systemd respawned:
// the supervisor-plus-orphan split brain launchd taught us is worse than either alone (#185150).
//
// daemonctl is shell, so these tests run the REAL script against doubles on PATH: systemctl,
// loginctl, sudo, lsof, curl, pgrep, uname, sleep. The doubles keep a tiny simulated machine in
// a state dir: which units exist and run, who holds :3200 (a real `sleep` process, so `kill`
// really works), and every call made — which is what the assertions read.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const REPO = path.join(__dirname, '..')
let root, home, bridge, state, bin

const FAKE_SYSTEMCTL = String.raw`#!/bin/bash
S="$FAKE_STATE"
echo "systemctl $*" >> "$S/calls"
scope=system
if [ "$1" = "--user" ]; then scope=user; shift; fi
[ -f "$S/no-systemctl" ] && exit 1
pos=(); prop=""
while [ $# -gt 0 ]; do
  case "$1" in
    -p) prop="$2"; shift 2 ;;
    --quiet) quiet=1; shift ;;
    --value) shift ;;
    --now) now=1; shift ;;
    *) pos+=("$1"); shift ;;
  esac
done
verb="$pos"
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }
mainpid() { cat "$S/$scope.mainpid" 2>/dev/null; }
do_start() {
  [ -f "$S/$scope.start-fails" ] && exit 1
  alive "$(mainpid)" && return 0
  setsid /bin/sleep 300 >/dev/null 2>&1 < /dev/null &
  p=$!
  echo "$p" >> "$S/spawned"; echo "$p" > "$S/$scope.mainpid"
  # Like the real daemon, it binds :3200 only if nobody else holds it.
  h="$(cat "$S/port_holder" 2>/dev/null)"
  alive "$h" || echo "$p" > "$S/port_holder"
}
do_stop() {
  p="$(mainpid)"; alive "$p" && kill "$p" 2>/dev/null
  rm -f "$S/$scope.mainpid"
}
case "$verb" in
  show-environment) [ "$scope" = user ] && [ ! -f "$S/no-user-bus" ] && { echo "PATH=/usr/bin"; exit 0; }; exit 1 ;;
  daemon-reload|reset-failed) exit 0 ;;
  enable) touch "$S/$scope.enabled"; [ -n "$now" ] && do_start; exit 0 ;;
  disable) rm -f "$S/$scope.enabled"; [ -n "$now" ] && do_stop; exit 0 ;;
  start) do_start; exit 0 ;;
  stop) do_stop; exit 0 ;;
  restart) do_stop; do_start; exit 0 ;;
  is-active) alive "$(mainpid)" && { [ -z "$quiet" ] && echo active; exit 0; }; [ -z "$quiet" ] && echo inactive; exit 3 ;;
  is-enabled) [ -f "$S/$scope.enabled" ] && { [ -z "$quiet" ] && echo enabled; exit 0; }; [ -z "$quiet" ] && echo disabled; exit 1 ;;
  show)
    case "$prop" in
      LoadState) if [ "$scope" = system ] && [ -f "$S/system.loaded" ]; then echo loaded; else echo not-found; fi ;;
      MainPID) p="$(mainpid)"; alive "$p" && echo "$p" || echo 0 ;;
    esac
    exit 0 ;;
esac
exit 0
`

const FAKES = {
  systemctl: FAKE_SYSTEMCTL,
  loginctl: String.raw`#!/bin/bash
S="$FAKE_STATE"; echo "loginctl $*" >> "$S/calls"
case "$1" in
  show-user) cat "$S/linger" 2>/dev/null || echo no ;;
  enable-linger) [ -f "$S/linger-denied" ] && { echo "Access denied" >&2; exit 1; }; echo yes > "$S/linger" ;;
esac
`,
  sudo: String.raw`#!/bin/bash
S="$FAKE_STATE"; echo "sudo $*" >> "$S/calls"
[ -f "$S/sudo-denied" ] && { echo "sudo: a password is required" >&2; exit 1; }
[ "$1" = "-n" ] && shift
exec "$@"
`,
  lsof: String.raw`#!/bin/bash
h="$(cat "$FAKE_STATE/port_holder" 2>/dev/null)"
[ -n "$h" ] && kill -0 "$h" 2>/dev/null && echo "$h"
exit 0
`,
  curl: String.raw`#!/bin/bash
h="$(cat "$FAKE_STATE/port_holder" 2>/dev/null)"
if [ -n "$h" ] && kill -0 "$h" 2>/dev/null; then printf 200; else printf 000; exit 7; fi
`,
  pgrep: '#!/bin/sh\nexit 1\n',
  uname: '#!/bin/sh\nif [ "$1" = "-s" ] || [ -z "$1" ]; then echo "${FAKE_UNAME:-Linux}"; else /bin/uname "$@"; fi\n',
  sleep: '#!/bin/sh\nexec /bin/sleep 0.02\n'
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-sd-'))
  home = path.join(root, 'home')
  bridge = path.join(home, '.iris', 'bridge')
  state = path.join(root, 'state')
  bin = path.join(root, 'bin')
  for (const d of [bridge, state, bin, path.join(root, 'run')]) fs.mkdirSync(d, { recursive: true })
  fs.mkdirSync(path.join(bridge, 'installers', 'linux'), { recursive: true })
  fs.copyFileSync(path.join(REPO, 'daemonctl'), path.join(bridge, 'daemonctl'))
  fs.chmodSync(path.join(bridge, 'daemonctl'), 0o755)
  fs.copyFileSync(path.join(REPO, 'installers', 'linux', 'iris-daemon.service'),
    path.join(bridge, 'installers', 'linux', 'iris-daemon.service'))
  // The nohup fallback runs `node daemon.js`: a stub that takes :3200 and lingers.
  fs.writeFileSync(path.join(bridge, 'daemon.js'),
    `require('fs').writeFileSync(${JSON.stringify(path.join(state, 'port_holder'))}, String(process.pid)); setTimeout(() => {}, 30000)\n`)
  fs.mkdirSync(path.join(home, '.iris'), { recursive: true })
  fs.writeFileSync(path.join(home, '.iris', 'config.json'), JSON.stringify({ node_api_key: 'node_live_test' }))
  // Installer-shipped node, so daemonctl's resolver stops there and does not put a package
  // manager's bin dir (which may hold a real curl) in front of the doubles.
  const rt = path.join(home, '.iris', 'runtime', 'node-v0-test', 'bin')
  fs.mkdirSync(rt, { recursive: true })
  fs.symlinkSync(process.execPath, path.join(rt, 'node'))
  for (const [name, src] of Object.entries(FAKES)) fs.writeFileSync(path.join(bin, name), src, { mode: 0o755 })
  fs.writeFileSync(path.join(state, 'calls'), '')
})

afterEach(() => {
  const pids = []
  for (const f of ['spawned', 'port_holder', 'orphans']) {
    try { pids.push(...fs.readFileSync(path.join(state, f), 'utf8').split(/\s+/).filter(Boolean)) } catch {}
  }
  for (const p of pids) { try { process.kill(Number(p), 'SIGKILL') } catch {} }
  fs.rmSync(root, { recursive: true, force: true })
})

function ctl (...args) {
  const r = spawnSync('/bin/bash', [path.join(bridge, 'daemonctl'), ...args], {
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      FAKE_STATE: state,
      XDG_RUNTIME_DIR: path.join(root, 'run'),
      FAKE_UNAME: process.env.FAKE_UNAME_OVERRIDE || 'Linux'
    },
    encoding: 'utf8',
    timeout: 60000
  })
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr }
}
const calls = () => fs.readFileSync(path.join(state, 'calls'), 'utf8')
const touch = (f, v = '') => fs.writeFileSync(path.join(state, f), v)
const read = (f) => { try { return fs.readFileSync(path.join(state, f), 'utf8').trim() } catch { return '' } }
const unitFile = () => path.join(home, '.config', 'systemd', 'user', 'iris-daemon.service')
const alive = (pid) => { try { process.kill(Number(pid), 0); return true } catch { return false } }

/** An unsupervised daemon already holding :3200 — a real process, so `kill` really kills it. */
function orphan () {
  const r = spawnSync('/bin/bash', ['-c', 'setsid /bin/sleep 300 >/dev/null 2>&1 < /dev/null & echo $!'], { encoding: 'utf8' })
  const pid = r.stdout.trim()
  touch('port_holder', pid)
  fs.appendFileSync(path.join(state, 'orphans'), pid + '\n')
  return pid
}

describe('daemonctl on Linux with systemd --user (#191615)', () => {
  it('start with NO unit installed installs it, enables linger, and starts it under systemd', () => {
    const r = ctl('start')
    assert.equal(r.code, 0, r.all)
    assert.ok(fs.existsSync(unitFile()), 'the unit was not installed')
    const unit = fs.readFileSync(unitFile(), 'utf8')
    assert.match(unit, /^Restart=always$/m)
    assert.ok(unit.includes(`ExecStart=/bin/bash "${bridge}/installers/macos/iris-daemon-wrapper.sh"`), unit)
    assert.ok(!unit.includes('__BRIDGE_DIR__'), 'placeholder left in the installed unit')
    assert.match(calls(), /systemctl --user enable iris-daemon\.service/)
    assert.match(calls(), /systemctl --user start iris-daemon\.service/)
    assert.match(calls(), /loginctl enable-linger/)
    assert.match(r.out, /Daemon started \(systemd, PID: \d+\)/)
    assert.doesNotMatch(r.all, /unsupervised/i)
    assert.equal(read('port_holder'), read('user.mainpid'), "systemd's child must be the listener")
  })

  it('start with the unit installed goes through systemctl --user, never nohup', () => {
    assert.equal(ctl('start').code, 0)
    ctl('stop')
    fs.writeFileSync(path.join(state, 'calls'), '')
    const r = ctl('start')
    assert.equal(r.code, 0, r.all)
    assert.match(calls(), /systemctl --user start iris-daemon\.service/)
    assert.doesNotMatch(r.all, /Started unsupervised/)
  })

  it('says plainly when linger cannot be enabled — a user unit dies at logout without it', () => {
    touch('linger-denied')
    const r = ctl('start')
    assert.equal(r.code, 0, r.all)
    assert.match(r.err, /could not enable linger/)
    assert.match(r.err, /STOPS the daemon when .* logs out/)
    assert.match(r.err, /sudo loginctl enable-linger/)
  })

  it('restart kills an unsupervised orphan holding :3200 and leaves ONLY the supervised process', () => {
    ctl('start')
    const supervised = read('user.mainpid')
    const stray = orphan() // e.g. an old nohup copy that took the port back
    const r = ctl('restart')
    assert.equal(r.code, 0, r.all)
    assert.equal(alive(stray), false, 'the orphan survived the restart')
    assert.equal(alive(supervised), false, 'the old supervised process was not replaced')
    const now = read('user.mainpid')
    assert.ok(alive(now))
    assert.equal(read('port_holder'), now, 'the listener is not systemd\'s child')
    assert.match(calls(), /systemctl --user stop iris-daemon\.service[\s\S]*systemctl --user start iris-daemon\.service/)
  })

  it('restart keeps its exit code: 1 when the supervised daemon does not come up', () => {
    ctl('start')
    touch('user.start-fails')
    const r = ctl('restart')
    assert.equal(r.code, 1, r.all)
    assert.doesNotMatch(r.all, /Started unsupervised/, 'fell back to nohup beside a supervisor')
  })

  it('status says "supervised by systemd" for the unit, UNSUPERVISED for an orphan, and names a split brain', () => {
    ctl('start')
    touch('linger', 'yes')
    assert.match(ctl('status').out, /supervised by systemd \(user unit iris-daemon\.service, pid \d+\)/)

    ctl('stop')
    orphan()
    const un = ctl('status').out
    assert.match(un, /UNSUPERVISED/)
    assert.match(un, /iris-daemon supervise/)

    // The unit runs, but somebody else holds the port.
    fs.rmSync(path.join(state, 'port_holder'))
    const holder = orphan()
    spawnSync('/bin/bash', [path.join(bin, 'systemctl'), '--user', 'start', 'iris-daemon.service'], { env: { ...process.env, FAKE_STATE: state } })
    const sb = ctl('status').out
    assert.match(sb, /SPLIT BRAIN/)
    assert.ok(sb.includes(holder))
  })

  it('start refuses to call it started when an orphan, not systemd\'s child, holds :3200', () => {
    const stray = orphan() // holds the port but no daemon.sock, so `start` does not see "already running"
    const r = ctl('start')
    assert.equal(r.code, 1, r.all)
    assert.match(r.err, /SPLIT BRAIN/)
    assert.ok(r.err.includes(stray))
    assert.doesNotMatch(r.out, /Daemon started/)
  })

  it('stop stops the unit (so systemd does not respawn it) and removes daemon.pid', () => {
    ctl('start')
    fs.writeFileSync(path.join(home, '.iris', 'daemon.pid'), read('user.mainpid'))
    const r = ctl('stop')
    assert.equal(r.code, 0, r.all)
    assert.match(calls(), /systemctl --user stop iris-daemon\.service/)
    assert.equal(read('user.mainpid'), '')
    assert.ok(!fs.existsSync(path.join(home, '.iris', 'daemon.pid')))
  })
})

describe('daemonctl on Linux WITHOUT systemd --user', () => {
  it('falls back to nohup, warns that nothing restarts it, and writes daemon.pid (#187776)', () => {
    touch('no-user-bus')
    const r = ctl('start')
    assert.equal(r.code, 0, r.all)
    assert.match(r.err, /systemd --user is not available/)
    assert.match(r.err, /NOTHING restarts it/)
    assert.match(r.out, /Started unsupervised/)
    assert.doesNotMatch(calls(), /systemctl --user (start|enable)/)
    assert.ok(!fs.existsSync(unitFile()))
    assert.equal(fs.readFileSync(path.join(home, '.iris', 'daemon.pid'), 'utf8').trim(), read('port_holder'))
    assert.match(ctl('status').out, /UNSUPERVISED .*systemd --user is not available/)
  })

  it('supervise refuses and changes nothing', () => {
    touch('no-user-bus')
    const r = ctl('supervise')
    assert.equal(r.code, 1)
    assert.match(r.err, /Nothing was changed/)
    assert.ok(!fs.existsSync(unitFile()))
  })
})

describe('a hand-written SYSTEM unit (iris-hive-001, #187774)', () => {
  function systemUnitRunning () {
    touch('system.loaded'); touch('system.enabled')
    spawnSync('/bin/bash', [path.join(bin, 'systemctl'), 'start', 'iris-daemon.service'], { env: { ...process.env, FAKE_STATE: state } })
    fs.writeFileSync(path.join(state, 'calls'), '')
    return read('system.mainpid')
  }

  it('restart never kills systemd\'s child and nohups beside it — it refuses without root', () => {
    const pid = systemUnitRunning()
    touch('sudo-denied')
    const r = ctl('restart')
    assert.equal(r.code, 1, r.all)
    assert.ok(alive(pid), 'killed the system unit\'s child — systemd would respawn it beside ours')
    assert.doesNotMatch(r.all, /Started unsupervised/)
    assert.match(r.err, /sudo systemctl stop iris-daemon\.service/)
    assert.match(r.err, /iris-daemon supervise/)
  })

  it('restart drives the system unit through sudo -n where root is passwordless', () => {
    systemUnitRunning()
    const r = ctl('restart')
    assert.equal(r.code, 0, r.all)
    assert.match(calls(), /sudo -n systemctl stop iris-daemon\.service[\s\S]*sudo -n systemctl start iris-daemon\.service/)
    assert.equal(read('port_holder'), read('system.mainpid'))
  })

  it('status reports it as supervised by systemd (system unit)', () => {
    systemUnitRunning()
    assert.match(ctl('status').out, /supervised by systemd \(SYSTEM unit/)
  })
})

describe('iris-daemon supervise — the migration', () => {
  it('moves a nohup daemon under systemd: old one stopped and port free BEFORE the unit starts', () => {
    const stray = orphan()
    const r = ctl('supervise')
    assert.equal(r.code, 0, r.all)
    assert.equal(alive(stray), false)
    const main = read('user.mainpid')
    assert.ok(alive(main))
    assert.equal(read('port_holder'), main, 'the unit did not become the listener')
    assert.match(r.out, new RegExp(`pid ${stray} -> ${main}`))
  })

  it('retires the system unit first, then starts the user unit — never two supervisors', () => {
    touch('system.loaded'); touch('system.enabled')
    spawnSync('/bin/bash', [path.join(bin, 'systemctl'), 'start', 'iris-daemon.service'], { env: { ...process.env, FAKE_STATE: state } })
    const old = read('system.mainpid')
    const r = ctl('supervise')
    assert.equal(r.code, 0, r.all)
    const c = calls()
    const disable = c.indexOf('sudo systemctl disable --now iris-daemon.service')
    const start = c.indexOf('systemctl --user start iris-daemon.service')
    assert.ok(disable > -1 && start > disable, c)
    assert.equal(alive(old), false)
    assert.ok(!fs.existsSync(path.join(state, 'system.enabled')), 'the system unit would come back at boot')
    assert.equal(read('port_holder'), read('user.mainpid'))
  })

  it('aborts without stopping anything when the system unit cannot be retired', () => {
    touch('system.loaded'); touch('system.enabled')
    spawnSync('/bin/bash', [path.join(bin, 'systemctl'), 'start', 'iris-daemon.service'], { env: { ...process.env, FAKE_STATE: state } })
    const old = read('system.mainpid')
    touch('sudo-denied')
    const r = ctl('supervise')
    assert.equal(r.code, 1)
    assert.ok(alive(old), 'took the node down without a replacement')
    assert.doesNotMatch(calls(), /systemctl --user start/)
  })

  it('--dry-run changes nothing', () => {
    const stray = orphan()
    const r = ctl('supervise', '--dry-run')
    assert.equal(r.code, 0)
    assert.match(r.out, /Would:/)
    assert.ok(alive(stray))
    assert.ok(!fs.existsSync(unitFile()))
  })
})

describe('the unit file', () => {
  const unit = fs.readFileSync(path.join(REPO, 'installers', 'linux', 'iris-daemon.service'), 'utf8')

  it('restarts on crash, with a back-off and a start limit so it cannot hot-loop forever', () => {
    assert.match(unit, /^Restart=always$/m)
    assert.match(unit, /^RestartSec=\d+$/m)
    assert.match(unit, /^StartLimitIntervalSec=\d+$/m)
    assert.match(unit, /^StartLimitBurst=\d+$/m)
    assert.match(unit, /^WantedBy=default\.target$/m)
  })

  it('puts ~/.iris/bin on PATH — the user manager does not, and the daemon runs `iris`', () => {
    assert.match(unit, /^Environment=PATH=%h\/\.iris\/bin:/m)
  })

  it('writes the same log files as the launchd plist', () => {
    const plist = fs.readFileSync(path.join(REPO, 'installers', 'macos', 'io.heyiris.daemon.plist'), 'utf8')
    for (const f of ['daemon.stdout.log', 'daemon.stderr.log']) {
      assert.ok(plist.includes(`.iris/logs/${f}`))
      assert.ok(unit.includes(`%h/.iris/logs/${f}`), `unit does not write ${f}`)
    }
  })

  it('carries no secrets', () => {
    const directives = unit.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).join('\n')
    assert.doesNotMatch(directives, /node_live_|KEY|TOKEN|SECRET|PASSWORD/i)
    assert.doesNotMatch(directives, /EnvironmentFile=/, 'an env file would put the node key in the unit\'s environment')
  })

  it('passes systemd-analyze verify --user, where systemd is available', (t) => {
    const probe = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' })
    if (probe.status !== 0) return t.skip('systemd-analyze not available')
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-'))
    const f = path.join(d, 'iris-daemon.service')
    fs.writeFileSync(f, unit.replaceAll('__BRIDGE_DIR__', REPO))
    const r = spawnSync('systemd-analyze', ['verify', '--user', f], { encoding: 'utf8' })
    fs.rmSync(d, { recursive: true, force: true })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stderr.trim(), '', `systemd-analyze warned:\n${r.stderr}`)
  })
})

describe('macOS is untouched', () => {
  it('a non-Linux start never calls systemctl', () => {
    process.env.FAKE_UNAME_OVERRIDE = 'Darwin'
    try {
      const r = ctl('start')
      assert.doesNotMatch(calls(), /systemctl/)
      assert.match(r.out, /Started unsupervised/) // no plist in this fake home
    } finally {
      delete process.env.FAKE_UNAME_OVERRIDE
    }
  })
})

describe('installers/install.sh on Linux', () => {
  const sh = fs.readFileSync(path.join(REPO, 'installers', 'install.sh'), 'utf8')
  it('no longer refuses Linux, and installs supervision through daemonctl supervise', () => {
    assert.doesNotMatch(sh, /supports macOS only/)
    assert.match(sh, /if \[ "\$\{OS\}" = "Linux" \]; then[\s\S]*daemonctl" supervise/)
  })
  it('parses', () => {
    assert.equal(spawnSync('/bin/bash', ['-n', path.join(REPO, 'installers', 'install.sh')]).status, 0)
  })
})
