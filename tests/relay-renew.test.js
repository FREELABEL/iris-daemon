'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { verdict } = require('../relay/cert-check')

/** Relay certificate renewal + its alarm (#191664). */

const unit = fs.readFileSync(path.join(__dirname, '../relay/systemd/hive-relay-renew.service'), 'utf8')
const execStart = unit.split('\n').find((l) => l.startsWith('ExecStart='))

test('the renew unit speaks the lego 5 CLI: `run`, --renew-days — not the removed `renew`/--days', () => {
  assert.match(execStart, /\/lego --log\.format text run /)
  assert.doesNotMatch(execStart, /\slego renew\s/)
  assert.doesNotMatch(execStart, /\s--days\s/)
  assert.match(execStart, /--renew-days 30\b/)
})

test('renewal starts before the expiry alarm would fire', () => {
  const renewDays = Number(execStart.match(/--renew-days (\d+)/)[1])
  assert.ok(renewDays > 21, `renew at ${renewDays} days must be earlier than the 21-day alarm`)
})

test('a failed renewal alerts, and the served certificate is checked after the reload', () => {
  assert.match(unit, /^OnFailure=hive-relay-alert@%N\.service$/m)
  const post = unit.split('\n').filter((l) => l.startsWith('ExecStartPost='))
  assert.match(post[0], /systemctl reload hive-relay/)
  assert.match(post[1], /relay\/cert-check\.js/)
  assert.ok(fs.existsSync(path.join(__dirname, '../relay/systemd/hive-relay-alert@.service')))
})

test('the token never appears in the unit, only the file it is read from', () => {
  assert.match(execStart, /CF_DNS_API_TOKEN=\$\(cat [^)]+\)/)
})

test('verdict: under 21 days left fails, 21 or more passes', () => {
  const now = new Date('2026-12-01T00:00:00Z')
  const days = (d) => new Date(now.getTime() + d * 86400000)
  assert.deepStrictEqual(verdict(days(69), now), { days: 69, ok: true })
  assert.deepStrictEqual(verdict(days(21), now), { days: 21, ok: true })
  assert.strictEqual(verdict(days(20.9), now).ok, false)
  assert.strictEqual(verdict(days(-1), now).ok, false)
  assert.strictEqual(verdict(days(30), now, 45).ok, false)
})
