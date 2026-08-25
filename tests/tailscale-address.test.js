'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { parseTailscaleIp, detectTailscaleIp, CANDIDATES } = require('../daemon/tailscale-address')

// #182368 — a node reports its own tailnet address so `hive fs` stops guessing from names.
// Pinned by tests because the module this replaces carried a docblock saying its fuzzy match
// was "pinned by tests rather than trusted" and had none.

test('parses the real single-address output', () => {
  assert.strictEqual(parseTailscaleIp('100.114.214.29\n'), '100.114.214.29')
  assert.strictEqual(parseTailscaleIp('  100.100.67.48  '), '100.100.67.48')
})

test('blank and non-string read as NO address, never as one', () => {
  // The failure that matters: "" dialled as a host is "connect to nowhere" presented as
  // an answer. Absence must stay absence.
  assert.strictEqual(parseTailscaleIp(''), null)
  assert.strictEqual(parseTailscaleIp('   \n  '), null)
  assert.strictEqual(parseTailscaleIp(null), null)
  assert.strictEqual(parseTailscaleIp(undefined), null)
})

test('refuses addresses outside the tailnet CGNAT range', () => {
  // A LAN or public address advertised as a tailnet one sends traffic to the wrong place.
  assert.strictEqual(parseTailscaleIp('192.168.1.5'), null)
  assert.strictEqual(parseTailscaleIp('10.0.0.4'), null)
  assert.strictEqual(parseTailscaleIp('169.150.224.129'), null)
  assert.strictEqual(parseTailscaleIp('100.63.255.255'), null)
  assert.strictEqual(parseTailscaleIp('100.128.0.1'), null)
})

test('accepts both edges of 100.64.0.0/10', () => {
  assert.strictEqual(parseTailscaleIp('100.64.0.1'), '100.64.0.1')
  assert.strictEqual(parseTailscaleIp('100.127.255.254'), '100.127.255.254')
})

test('refuses an octet out of range', () => {
  assert.strictEqual(parseTailscaleIp('100.64.0.999'), null)
  assert.strictEqual(parseTailscaleIp('100.999.0.1'), null)
})

test('AMBIGUITY IS REFUSED — two addresses is not an answer', () => {
  // Picking the first of several would be a guess, and guessing which machine to reach is
  // the entire defect this module exists to remove.
  assert.strictEqual(parseTailscaleIp('100.64.0.1\n100.64.0.2\n'), null)
})

test('error text on stdout does not parse as an address', () => {
  assert.strictEqual(parseTailscaleIp('failed to connect to local tailscaled'), null)
})

test('looks for tailscale outside PATH, because launchd gives a minimal one', () => {
  // The same trap that made `command -v tmux` report false for a working tmux.
  assert.ok(CANDIDATES.includes('/Applications/Tailscale.app/Contents/MacOS/Tailscale'))
  assert.ok(CANDIDATES.includes('/opt/homebrew/bin/tailscale'))
})

test('detection never throws on a machine with no tailscale', async () => {
  const ip = await detectTailscaleIp()
  assert.ok(ip === null || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip))
})
