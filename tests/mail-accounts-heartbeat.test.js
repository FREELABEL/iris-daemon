'use strict'
/**
 * #191879 — a node says WHICH Mail.app accounts it has, not just that it has Mail.
 *
 * 2026-10-30: team@heyiris.io was added to Apple Mail and nobody could tell which Mac held it —
 * every node advertised `apple_mail: available` and nothing more, so each Mac had to be asked by
 * hand. These pin the heartbeat payload: accounts with their addresses, never secrets, never by
 * launching Mail, never by blocking the heartbeat.
 *
 * Fixtures are the real output of the read-only probe on iris-hive-002 and the MacBook that day.
 */
const test = require('node:test')
const assert = require('node:assert')
const { parseMailAccounts, createMailAccountsCache, ACCOUNTS_JXA } = require('../daemon/mail-accounts')

const HIVE_002 = JSON.stringify([
  { name: 'iCloud', id: 'A1', addresses: ['mayoalexandertd@icloud.com'], enabled: true },
  { name: 'Google', id: 'A2', addresses: ['alex@freelabel.net'], enabled: true },
  { name: 'amayo@mypathwaysai.com', id: 'A3', addresses: ['amayo@mypathwaysai.com'], enabled: true },
  { name: 'team@heyiris.io', id: 'A4', addresses: ['Team@HeyIris.io'], enabled: true },
])

test('parses the probe into name, id and lower-cased addresses', () => {
  const accts = parseMailAccounts(HIVE_002)
  assert.strictEqual(accts.length, 4)
  assert.deepStrictEqual(accts[3], { name: 'team@heyiris.io', id: 'A4', addresses: ['team@heyiris.io'], enabled: true })
})

test('a garbled probe answer throws instead of reading as "no accounts"', () => {
  assert.throws(() => parseMailAccounts('execution error: Mail got an error'))
  assert.throws(() => parseMailAccounts('{"not":"a list"}'))
})

test('the probe asks only for name, id, addresses and enabled — no server, user name or password', () => {
  for (const prop of ['name()', 'id()', 'emailAddresses()', 'enabled()']) assert.ok(ACCOUNTS_JXA.includes(prop), prop)
  for (const secret of ['password', 'userName', 'serverName', 'content(', 'messages']) assert.ok(!ACCOUNTS_JXA.includes(secret), secret)
})

test('the heartbeat payload carries the accounts once the background refresh lands', async () => {
  const cache = createMailAccountsCache({ platform: 'darwin', isMailRunning: async () => true, runProbe: async () => HIVE_002 })
  const first = cache.snapshot() // never blocks: kicks the refresh, answers from the (empty) cache
  assert.strictEqual(first.accounts, null)
  await cache._state.inflight
  const snap = cache.snapshot()
  assert.ok(snap.accounts.some((a) => a.addresses.includes('team@heyiris.io')))
  assert.strictEqual(snap.accounts_reason, null)
  assert.ok(snap.accounts_checked_at)
})

test('never launches Mail: when Mail is not running the probe is not run', async () => {
  let probed = 0
  const cache = createMailAccountsCache({ platform: 'darwin', isMailRunning: async () => false, runProbe: async () => { probed++; return HIVE_002 } })
  await cache.refresh()
  assert.strictEqual(probed, 0)
  const snap = cache.snapshot()
  assert.strictEqual(snap.accounts, null)
  assert.match(snap.accounts_reason, /not running/)
})

test('a failed probe keeps the last known accounts and says why', async () => {
  let fail = false
  const cache = createMailAccountsCache({ platform: 'darwin', isMailRunning: async () => true, runProbe: async () => { if (fail) throw new Error('-1743 not allowed'); return HIVE_002 } })
  await cache.refresh()
  fail = true
  await cache.refresh()
  const snap = cache.snapshot()
  assert.strictEqual(snap.accounts.length, 4)
  assert.match(snap.accounts_reason, /could not list/)
})

test('refreshes at most once per interval', async () => {
  let probed = 0
  let t = 1_000_000
  const cache = createMailAccountsCache({ platform: 'darwin', now: () => t, refreshMs: 60_000, isMailRunning: async () => true, runProbe: async () => { probed++; return HIVE_002 } })
  cache.snapshot(); await cache._state.inflight
  cache.snapshot(); cache.snapshot()
  assert.strictEqual(probed, 1)
  t += 61_000
  cache.snapshot(); await cache._state.inflight
  assert.strictEqual(probed, 2)
})

test('not a Mac: no probe, a reason, and accounts null', async () => {
  let probed = 0
  const cache = createMailAccountsCache({ platform: 'linux', runProbe: async () => { probed++; return HIVE_002 } })
  const snap = cache.snapshot()
  assert.strictEqual(probed, 0)
  assert.strictEqual(snap.accounts, null)
  assert.match(snap.accounts_reason, /macOS/)
})

test('bridge_capabilities.apple_mail carries the accounts fields (the heartbeat payload)', () => {
  const caps = require('../daemon/bridge-registry').capabilities()
  assert.ok(caps.apple_mail, 'apple_mail missing')
  for (const k of ['accounts', 'accounts_checked_at', 'accounts_reason']) assert.ok(k in caps.apple_mail, `apple_mail.${k} missing`)
})
