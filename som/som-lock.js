// The SOM batch lock: is another batch really running on this machine? (#190291)
// Age alone isn't enough. A batch that crashes leaves the lock behind, and an age-only check then
// blocks every run for 30 minutes while each blocked run exits 0 and reports "completed".
const MAX_AGE_MS = 30 * 60 * 1000

function pidAlive (pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }   // EPERM: alive, not ours
}

// 'busy' when a live batch holds the lock and is under 30 minutes old; otherwise 'stale'.
function lockVerdict (lock, now = Date.now(), isAlive = pidAlive) {
  if (!lock || !Number.isInteger(lock.pid) || !Number.isFinite(lock.started)) return 'stale'
  if (!isAlive(lock.pid)) return 'stale'
  return now - lock.started < MAX_AGE_MS ? 'busy' : 'stale'
}

module.exports = { lockVerdict, pidAlive, MAX_AGE_MS }
