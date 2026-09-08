'use strict'

/**
 * Ship a running task's output to the cloud while it is still running.
 *
 * The lines were already in hand — the executor collects stdout and stderr line by line and
 * hands them to console.log, where only someone sitting at that machine can see them. This
 * forwards them, so a task can be WATCHED rather than waited on.
 *
 * THE RULES, all of which exist because the wire is slower than a chatty process:
 *
 *  - BATCH on an interval, never per line. A build emitting 500 lines a second would otherwise
 *    make 500 HTTP calls and a 500-message Pusher storm.
 *  - DROP, never queue. If output outpaces the wire, the newest lines are what a watcher wants;
 *    an ever-growing backlog turns a live view into a delayed one and then into a memory leak.
 *  - COUNT what was dropped and say so. A gap the viewer cannot see is indistinguishable from
 *    a quiet task, which is the same collapse this fleet keeps paying for. The marker is part
 *    of the stream, not a log line nobody reads.
 *  - SEQUENCE every chunk. Pusher does not guarantee order, so the client needs to be able to
 *    tell "out of order" from "missing".
 *  - NEVER let a failed send affect the task. Live view is a convenience; a task must not fail
 *    because nobody was watching.
 */

const DEFAULTS = {
  intervalMs: 1000,
  /** Pusher's ceiling is ~10KB; the endpoint refuses above 8KB. Leave headroom for the marker. */
  maxChunkBytes: 7000,
  /** Above this many buffered lines we drop the oldest and count them. */
  maxBufferedLines: 500
}

class OutputStreamer {
  /**
   * @param {{reportOutput: (taskId:string, seq:number, chunk:string, stream:string)=>Promise<any>}} client
   */
  constructor (client, taskId, opts = {}) {
    this.client = client
    this.taskId = taskId
    this.opts = { ...DEFAULTS, ...opts }
    this.seq = 0
    this.buffers = { stdout: [], stderr: [] }
    this.dropped = { stdout: 0, stderr: 0 }
    this.timer = null
    this.stopped = false
    this.inFlight = false
  }

  push (line, stream = 'stdout') {
    if (this.stopped) return
    const buf = this.buffers[stream] || this.buffers.stdout
    buf.push(line)
    if (buf.length > this.opts.maxBufferedLines) {
      // Drop the OLDEST. A watcher wants what is happening now, not what happened while the
      // wire was busy.
      const lost = buf.length - this.opts.maxBufferedLines
      buf.splice(0, lost)
      this.dropped[stream] += lost
    }
  }

  start () {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => { this.flush().catch(() => {}) }, this.opts.intervalMs)
    // Do not hold the process open for a live view.
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** Take at most one chunk's worth off a buffer, prefixed with any gap marker. */
  _take (stream) {
    const buf = this.buffers[stream]
    if (!buf.length && !this.dropped[stream]) return null

    let chunk = ''
    if (this.dropped[stream]) {
      chunk += `… ${this.dropped[stream]} line(s) dropped — output faster than the wire\n`
      this.dropped[stream] = 0
    }
    while (buf.length) {
      const next = buf[0]
      if (chunk.length + next.length + 1 > this.opts.maxChunkBytes) break
      chunk += buf.shift() + '\n'
    }
    // A single line longer than a whole chunk would otherwise spin forever.
    if (!chunk && buf.length) chunk = buf.shift().slice(0, this.opts.maxChunkBytes) + '\n'
    return chunk || null
  }

  async flush () {
    if (this.inFlight) return   // never overlap; the next tick will carry it
    this.inFlight = true
    try {
      for (const stream of ['stdout', 'stderr']) {
        const chunk = this._take(stream)
        if (!chunk) continue
        try {
          await this.client.reportOutput(this.taskId, this.seq++, chunk, stream)
        } catch (e) {
          // Swallowed on purpose. A task must not fail because nobody was watching.
          if (!this._warned) {
            this._warned = true
            console.log(`[output-stream] live output unavailable for ${String(this.taskId).slice(0, 8)}: ${e.message}`)
          }
        }
      }
    } finally {
      this.inFlight = false
    }
  }

  async stop () {
    this.stopped = true
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    await this.flush()   // one last send, so the tail is not lost
  }
}

module.exports = { OutputStreamer, DEFAULTS }
