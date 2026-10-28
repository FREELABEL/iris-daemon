'use strict'

// #191615: a Linux node running UNSUPERVISED must make the doctor fail, and say the one command
// that fixes it. Before this the supervisor check read launchd only, so on Linux it was always
// `unknown`: an unsupervised node never went red, and a supervised one never went green.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { verdict, collect } = require('../lib/linux-supervision')
const { evaluate } = require('../lib/daemon-doctor')

const supervised = () => ({
  systemdAvailable: true, userUnitInstalled: true, userActive: true, userPid: 700,
  systemUnitLoaded: false, systemActive: false, systemPid: null, linger: true, user: 'alex'
})
const nohup = () => ({ ...supervised(), userUnitInstalled: false, userActive: false, userPid: null })

test('supervised by the user unit, with linger, passes', () => {
  assert.equal(verdict(supervised(), 700).status, 'pass')
})

test('an unsupervised (nohup) daemon FAILS and names the fix', () => {
  const v = verdict(nohup(), 4242)
  assert.equal(v.status, 'fail')
  assert.match(v.detail, /UNSUPERVISED/)
  assert.match(v.detail, /4242/)
  assert.match(v.detail, /iris-daemon supervise/)
})

test('no systemd at all (container) still fails, and does not point at a command that cannot work', () => {
  const v = verdict({ ...nohup(), systemdAvailable: false }, 4242)
  assert.equal(v.status, 'fail')
  assert.match(v.detail, /systemd --user is not available/)
  assert.doesNotMatch(v.detail, /iris-daemon supervise/)
})

test('an orphan beside the supervised process is a split brain, with both pids', () => {
  const v = verdict(supervised(), 9999)
  assert.equal(v.status, 'fail')
  assert.match(v.detail, /SPLIT BRAIN/)
  assert.match(v.detail, /700/)
  assert.match(v.detail, /9999/)
})

test('a user unit with linger OFF fails — it dies at logout', () => {
  const v = verdict({ ...supervised(), linger: false }, 700)
  assert.equal(v.status, 'fail')
  assert.match(v.detail, /sudo loginctl enable-linger alex/)
})

test('system unit AND user unit both active is two supervisors', () => {
  const v = verdict({ ...supervised(), systemUnitLoaded: true, systemActive: true, systemPid: 800 }, 700)
  assert.equal(v.status, 'fail')
  assert.match(v.detail, /TWO SUPERVISORS/)
})

test('the legacy system unit counts as supervised, with a nudge to migrate', () => {
  const v = verdict({ ...nohup(), systemUnitLoaded: true, systemActive: true, systemPid: 318060 }, 318060)
  assert.equal(v.status, 'pass')
  assert.match(v.detail, /iris-daemon supervise/)
})

test('nothing listening is unknown, never a pass', () => {
  assert.equal(verdict(supervised(), null).status, 'unknown')
  assert.equal(verdict(nohup(), null).status, 'unknown')
})

test('iris-daemon doctor fails an unsupervised Linux node (exit code 1)', () => {
  const facts = {
    platform: 'linux',
    supervision: nohup(),
    launchdPid: null,
    portHolderPid: 4242,
    bridgeProcessPids: [4242],
    executorPids: [4242],
    monitorPids: [],
    processStartedMs: Date.parse('2026-10-28T15:00:00Z'),
    newestCodeMs: Date.parse('2026-10-28T14:00:00Z'),
    healthStatus: 200,
    config: { parsed: true, mode: 0o600, keys: ['node_api_key', 'user_id', 'node_id'] },
    watchdogKills: { sinceStart: 0, historical: 0 },
    stdoutLogBytes: 1024
  }
  const bad = evaluate(facts)
  const c = bad.checks.find((x) => x.id === 'launchd_pid_is_port_holder')
  assert.equal(c.status, 'fail')
  assert.match(c.detail, /iris-daemon supervise/)
  assert.equal(bad.exitCode, 1)

  const good = evaluate({ ...facts, supervision: { ...supervised(), userPid: 4242 } })
  assert.equal(good.checks.find((x) => x.id === 'launchd_pid_is_port_holder').status, 'pass')
  assert.equal(good.exitCode, 0, 'a supervised Linux node must be able to go green')
})

test('collect() reads systemd through the injected runner (no real systemctl)', () => {
  const seen = []
  const run = (cmd, args) => {
    seen.push(`${cmd} ${args.join(' ')}`)
    const a = args.join(' ')
    if (a === '--user show-environment') return 'PATH=/usr/bin'
    if (a.includes('LoadState')) return 'loaded'
    if (a === 'is-active iris-daemon.service') return 'active'
    if (a === 'show -p MainPID --value iris-daemon.service') return '318060'
    if (cmd === 'loginctl') return 'yes'
    return null
  }
  const s = collect({ run, home: '/nonexistent', user: 'alex', env: {} })
  assert.equal(s.systemActive, true)
  assert.equal(s.systemPid, 318060)
  assert.equal(s.userUnitInstalled, false)
  assert.equal(s.linger, true)
  assert.ok(seen.every((c) => !/\b(start|stop|restart|enable|disable)\b/.test(c)), 'the doctor must only read')
})
