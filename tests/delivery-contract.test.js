#!/usr/bin/env node
/**
 * The Hive task contract, node side (#187568). The server owns "created once" and "never
 * dispatched late"; these are the two rules only the machine can keep — ran once per key, and
 * never STARTED late by its own clock — plus the wiring that makes them reachable at all.
 */
const { test } = require('node:test')
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { decide, isPastDeadline, isExpiredRefusal, KeyLedger } = require('../daemon/delivery-contract')

const tmpLedger = () => new KeyLedger({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'keys-')), 'task-keys.json') })
const NOW = Date.parse('2026-10-02T18:00:00.000Z')

test('a task with no deadline is never late', () => {
  assert.strictEqual(isPastDeadline({ id: 't' }, NOW), false)
})

test('a task is late one millisecond after its deadline, not before', () => {
  const task = { id: 't', not_after: '2026-10-02T18:00:00.000Z' }
  assert.strictEqual(isPastDeadline(task, NOW), false)
  assert.strictEqual(isPastDeadline(task, NOW + 1), true)
})

test('an unreadable deadline is treated as none, not as already passed', () => {
  // The alternative — every task with a malformed timestamp silently refused — is a fleet that
  // stops running anything and reports nothing wrong.
  assert.strictEqual(isPastDeadline({ id: 't', not_after: 'soon' }, NOW), false)
})

test('a late task is expired, never run', () => {
  assert.deepStrictEqual(decide({ id: 't', not_after: '2026-10-02T17:59:59.000Z' }, tmpLedger(), NOW), { action: 'expire' })
})

test('a key that completed here is replayed, not run again', () => {
  const ledger = tmpLedger()
  ledger.begin('ring-8-01', 'task-a')
  ledger.finish('ring-8-01', 'task-a', { status: 'completed', output: 'in slot' })

  const v = decide({ id: 'task-a', idempotency_key: 'ring-8-01' }, ledger, NOW)
  assert.strictEqual(v.action, 'replay')
  assert.strictEqual(v.entry.result.output, 'in slot')
})

test('a key that FAILED here is forgotten, so its retry runs', () => {
  const ledger = tmpLedger()
  ledger.begin('k', 'task-a')
  ledger.finish('k', 'task-a', { status: 'failed', error: 'exit 1' })

  assert.deepStrictEqual(decide({ id: 'task-a', idempotency_key: 'k' }, ledger, NOW), { action: 'run' })
})

test('a different task with a key already running here is not started as a twin', () => {
  const ledger = tmpLedger()
  ledger.begin('k', 'task-a')

  assert.strictEqual(decide({ id: 'task-b', idempotency_key: 'k' }, ledger, NOW).action, 'skip')
})

test('the ledger survives a daemon restart — re-delivery happens exactly then', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'keys-')), 'task-keys.json')
  const before = new KeyLedger({ file })
  before.begin('k', 'task-a')
  before.finish('k', 'task-a', { status: 'completed', output: 'done' })

  const after = new KeyLedger({ file })
  assert.strictEqual(decide({ id: 'task-a', idempotency_key: 'k' }, after, NOW).action, 'replay')
})

test("the server's 409 expired refusal is recognised, and nothing else is", () => {
  assert.strictEqual(isExpiredRefusal(new Error('HTTP 409: {"error":"Task expired","status":"expired"}')), true)
  assert.strictEqual(isExpiredRefusal(new Error('HTTP 422: {"error":"Cannot accept task"}')), false)
  assert.strictEqual(isExpiredRefusal(new Error('HTTP 409: {"error":"conflict"}')), false)
})

// ─── the wiring: each rule is reachable from the path real tasks take ────────

const ROOT = path.resolve(__dirname, '..')
const daemon = fs.readFileSync(path.join(ROOT, 'daemon/index.js'), 'utf8')
const cloud = fs.readFileSync(path.join(ROOT, 'daemon/cloud-client.js'), 'utf8')
const dispatched = daemon.slice(daemon.indexOf('async handleTaskDispatched'), daemon.indexOf('async forwardToPeer'))

test('the dispatch path decides BEFORE it executes', () => {
  const decideAt = dispatched.indexOf('decide(task, this.keyLedger)')
  const executeAt = dispatched.indexOf('this.executor.execute(task)')
  assert.ok(decideAt > 0, 'handleTaskDispatched never consults the contract')
  assert.ok(decideAt < executeAt, 'the contract is consulted after the work already started')
})

test('an expired refusal returns before anything reports a failure', () => {
  const refusalAt = dispatched.indexOf('isExpiredRefusal(acceptErr)')
  const throwAt = dispatched.indexOf('throw acceptErr')
  assert.ok(refusalAt > 0 && refusalAt < throwAt, 'a 409 expired would fall through to "failed" and overwrite the status')
})

test('accept carries the arrival time, and every result reaches the ledger', () => {
  assert.match(dispatched, /acceptTask\(event\.task_id, \{ arrived_at:/)
  assert.match(cloud, /onResultSubmitted\(taskId, result\)/)
})
