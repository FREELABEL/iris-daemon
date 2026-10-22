const { test } = require('node:test')
const assert = require('node:assert')
const { PusherClient, resubscribeDelayMs } = require('../daemon/pusher-client')

/**
 * #190408 — a pusher-js reconnect does not re-establish the subscription. The daemon
 * subscribed once, logged the reconnect, and then received work through the 25s poll
 * while still looking healthy. These tests drive a fake Pusher through that exact sequence.
 */

class FakeChannel {
  constructor (name) {
    this.name = name
    this.subscribed = false
    this.handlers = {}
  }

  bind (event, fn) {
    ;(this.handlers[event] ||= []).push(fn)
  }

  emit (event, arg) {
    for (const fn of this.handlers[event] || []) fn(arg)
  }

  handlerCount (event) {
    return (this.handlers[event] || []).length
  }
}

class FakePusher {
  constructor (key, opts) {
    this.key = key
    this.options = opts
    this.channels = []
    this.subscribeCalls = 0
    this.connectionHandlers = {}
    this.disconnected = false
    this.connection = {
      bind: (event, fn) => {
        this.connectionHandlers[event] = fn
      }
    }
  }

  subscribe (name) {
    this.subscribeCalls++
    const channel = new FakeChannel(name)
    this.channels.push(channel)
    return channel
  }

  disconnect () {
    this.disconnected = true
  }

  emitState (current) {
    this.connectionHandlers.state_change?.({ current })
  }
}

function harness () {
  const pusher = new FakePusher()
  const client = new PusherClient('key', 'eu', 'private-node.abc', { post: async () => ({}) }, {
    Pusher: function () {
      return pusher
    }
  })
  return { pusher, client }
}

test('backoff starts at 1s, doubles, and caps at 30s', () => {
  assert.deepStrictEqual(
    [1, 2, 3, 4, 5, 6, 10].map(resubscribeDelayMs),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000]
  )
})

test('a successful subscription reports push delivery', async () => {
  const { pusher, client } = harness()
  const connected = client.connect()
  pusher.channels[0].subscribed = true
  pusher.channels[0].emit('pusher:subscription_succeeded')
  await connected
  assert.strictEqual(client.getDeliveryMode(), 'push')
  assert.strictEqual(pusher.subscribeCalls, 1)
  client.disconnect()
})

test('reconnecting with a lost subscription re-subscribes instead of waiting for the poll', async () => {
  const { pusher, client } = harness()
  const connected = client.connect()
  pusher.channels[0].subscribed = true
  pusher.channels[0].emit('pusher:subscription_succeeded')
  await connected

  // What actually happens after a socket reconnect: the channel is no longer subscribed.
  pusher.channels[0].subscribed = false
  pusher.emitState('disconnected')
  assert.strictEqual(client.getDeliveryMode(), 'poll-fallback')
  pusher.emitState('connected')

  assert.strictEqual(pusher.subscribeCalls, 2, 'must re-subscribe after a reconnect')
  client.disconnect()
})

test('a reconnect that kept its subscription does not subscribe again', async () => {
  const { pusher, client } = harness()
  const connected = client.connect()
  pusher.channels[0].subscribed = true
  pusher.channels[0].emit('pusher:subscription_succeeded')
  await connected

  pusher.emitState('connected')
  assert.strictEqual(pusher.subscribeCalls, 1)
  client.disconnect()
})

test('re-subscribing does not double the task handler', async () => {
  const { pusher, client } = harness()
  const seen = []
  client.onTaskDispatched((d) => seen.push(d))

  const connected = client.connect()
  pusher.channels[0].subscribed = true
  pusher.channels[0].emit('pusher:subscription_succeeded')
  await connected

  pusher.channels[0].subscribed = false
  pusher.emitState('connected')
  const live = pusher.channels[pusher.channels.length - 1]
  assert.strictEqual(live.handlerCount('task.dispatched'), 1)

  live.emit('task.dispatched', { task: { id: 't1' } })
  assert.deepStrictEqual(seen, [{ task: { id: 't1' } }])
  client.disconnect()
})

test('a subscription error falls back to polling and schedules a retry', async () => {
  const { pusher, client } = harness()
  const connected = client.connect()
  pusher.channels[0].emit('pusher:subscription_error', { status: 403 })
  await connected

  assert.strictEqual(client.getDeliveryMode(), 'poll-fallback')
  assert.strictEqual(client.resubscribeAttempt, 1, 'a failed subscription is retried, not accepted')
  client.disconnect()
})
