/**
 * PusherClient — Subscribes to a private Pusher channel
 * to receive real-time task dispatch events from the cloud.
 *
 * #190408: a pusher-js socket reconnects on its own, but that does NOT guarantee the
 * channel subscription survived — the library reconnects the socket and can leave the
 * subscription behind. Nothing here checked, so a node stayed "online", kept heartbeating,
 * and silently received work through the server's 25s poll instead of the push it thought
 * it had. 25s per task is the difference between Hive feeling instant and feeling broken.
 *
 * So: every time the connection comes back, ask the channel whether it is still subscribed
 * and re-subscribe when it is not. A subscription error is retried with backoff rather than
 * being treated as "carry on". The current delivery path is readable through
 * getDeliveryMode(), so a degraded node can say so instead of looking healthy.
 */

/** Backoff between re-subscription attempts: 1s, 2s, 4s … capped at 30s. */
function resubscribeDelayMs (attempt) {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 30000)
}

class PusherClient {
  constructor (pusherKey, cluster, channel, cloudClient, deps = {}) {
    this.pusherKey = pusherKey
    this.cluster = cluster
    this.channelName = channel
    this.cloudClient = cloudClient
    this.deps = deps
    this.pusher = null
    this.channel = null
    this.onTaskCallback = null
    this.deliveryMode = 'poll-fallback'
    this.resubscribeAttempt = 0
    this.resubscribeTimer = null
    this._boundChannel = null
    this._resolveConnect = null
  }

  async connect () {
    // Dynamic import — pusher-js is a dependency. Injectable so the reconnect contract
    // can be tested without a live Pusher account.
    const Pusher = this.deps.Pusher || require('pusher-js')

    this.pusher = new Pusher(this.pusherKey, {
      cluster: this.cluster,
      // Custom authorizer that uses our node API key
      authorizer: (channel) => ({
        authorize: async (socketId, callback) => {
          try {
            const result = await this.cloudClient.post('/api/v6/nodes/broadcasting/auth', {
              socket_id: socketId,
              channel_name: channel.name
            })
            callback(null, result)
          } catch (err) {
            callback(err, null)
          }
        }
      })
    })

    this._subscribe()

    return new Promise((resolve, reject) => {
      this._resolveConnect = resolve

      // Timeout after 10s — the daemon must start even when Pusher is unreachable; the
      // pending-task poll is the fallback and it works.
      const timer = setTimeout(() => resolve(), 10000)
      if (timer.unref) timer.unref()

      this.pusher.connection.bind('state_change', (states) => {
        if (states.current === 'disconnected') {
          this.deliveryMode = 'poll-fallback'
          console.log('[pusher] Disconnected — will reconnect automatically')
        } else if (states.current === 'connected') {
          console.log('[pusher] Connected')
          // The socket is back. The subscription may not be (#190408).
          if (!this.channel || !this.channel.subscribed) this._subscribe()
        }
      })
    })
  }

  /** Subscribe (or re-subscribe) and make sure the handlers sit on the live channel. */
  _subscribe () {
    if (!this.pusher) return
    this.channel = this.pusher.subscribe(this.channelName)
    this._bindHandlers()
  }

  _bindHandlers () {
    if (!this.channel) return
    // Re-subscribing can hand back the same channel instance; binding again would double
    // every task dispatch, so bind once per channel object.
    if (this._boundChannel === this.channel) return
    this._boundChannel = this.channel

    this.channel.bind('pusher:subscription_succeeded', () => {
      this.deliveryMode = 'push'
      this.resubscribeAttempt = 0
      console.log(`[pusher] Subscribed to ${this.channelName}`)
      if (this._resolveConnect) {
        this._resolveConnect()
        this._resolveConnect = null
      }
    })

    this.channel.bind('pusher:subscription_error', (err) => {
      // Not fatal — polling still delivers work — but it is not success either, and it is
      // exactly the state that used to be invisible.
      this.deliveryMode = 'poll-fallback'
      console.error(`[pusher] Subscription FAILED for ${this.channelName}:`, err?.status || err)
      this._scheduleResubscribe()
      if (this._resolveConnect) {
        this._resolveConnect()
        this._resolveConnect = null
      }
    })

    // Listen for task dispatch events
    this.channel.bind('task.dispatched', (data) => {
      if (this.onTaskCallback) {
        this.onTaskCallback(data)
      }
    })
  }

  _scheduleResubscribe () {
    if (this.resubscribeTimer) return
    const delay = resubscribeDelayMs(++this.resubscribeAttempt)
    console.log(`[pusher] Re-subscribing in ${Math.round(delay / 1000)}s (attempt ${this.resubscribeAttempt})`)
    this.resubscribeTimer = setTimeout(() => {
      this.resubscribeTimer = null
      this._subscribe()
    }, delay)
    if (this.resubscribeTimer.unref) this.resubscribeTimer.unref()
  }

  /** 'push' while the subscription is live, 'poll-fallback' when work arrives on the poll. */
  getDeliveryMode () {
    return this.deliveryMode
  }

  onTaskDispatched (callback) {
    this.onTaskCallback = callback
  }

  disconnect () {
    if (this.resubscribeTimer) {
      clearTimeout(this.resubscribeTimer)
      this.resubscribeTimer = null
    }
    if (this.pusher) {
      this.pusher.disconnect()
      this.pusher = null
    }
  }
}

module.exports = { PusherClient, resubscribeDelayMs }
