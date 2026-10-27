'use strict'

/**
 * Where a slow request spent its time, stage by stage (#191306).
 *
 * Measured 2026-10-27 on the MacBook: GET /api/sessions/opencode took 33–40 s even at limit=25,
 * while every part of it measured alone was fast (Desktop SQLite 146 ms, lsof 30 ms, the engine
 * 5 ms, /health 10–200 ms). Guessing which stage it is failed four times; this records it instead.
 *
 * `mark(name)` closes the stage that ran since the previous mark. Pure apart from the clock.
 */
function stageTimer (now = () => Number(process.hrtime.bigint() / 1000000n)) {
  const start = now()
  let last = start
  const stages = {}
  return {
    mark (name) {
      const t = now()
      stages[name] = (stages[name] || 0) + (t - last)
      last = t
    },
    total () { return now() - start },
    stages,
    /** "total 33012ms — files 12ms, desktop 140ms, servers 32800ms", slowest stages first. */
    summary () {
      const parts = Object.entries(stages).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}ms`)
      return `total ${this.total()}ms — ${parts.join(', ')}`
    }
  }
}

/** A list call slower than this logs its breakdown. The heartbeat refresh waits 5 s per provider. */
const SLOW_MS = 2000

module.exports = { stageTimer, SLOW_MS }
