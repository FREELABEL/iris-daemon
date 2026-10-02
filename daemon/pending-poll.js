/**
 * Should the daemon ask the server for its own assigned/dispatched tasks right now? (#187457)
 *
 * Push is the fast path, but a push subscription can die silently — pusher-js reconnects the socket
 * without re-establishing every subscription, and nothing tells the daemon. Without this, such a node
 * only got its work through the server's 60 s orphan re-send. Asking after each successful heartbeat
 * bounds the delay to one heartbeat interval. Duplicate deliveries are already dropped by the
 * daemon's per-task dedup, so a task that arrives by push AND by poll runs once.
 */
function shouldPollPending ({ now, lastPollAt = 0, active = 0, max, intervalMs = 25000, paused = false }) {
  if (paused) return false
  const slots = Number.isFinite(max) && max > 0 ? max : 1
  if (active >= slots) return false
  return now - lastPollAt >= intervalMs
}

module.exports = { shouldPollPending }
