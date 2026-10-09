'use strict'

// Free space where this daemon WRITES, re-measured while it runs (#188700, Hermes audit
// EVAL #188663). Before this the only disk number was `df -k /` taken once at startup and cached
// for 24h — it measured `/`, not ~/.iris, and a disk that filled after boot was invisible to the
// platform until tasks started failing with raw ENOSPC text.
//
// statfs is a syscall, not a subprocess, so this is safe on the heartbeat path; it is still
// sampled at most once a minute because the answer does not change faster than that matters.

const fs = require('fs')
const os = require('os')
const path = require('path')

const SAMPLE_MS = 60_000
let cache = null
let lastWriteError = null

function measure (dir) {
  const s = fs.statfsSync(dir)
  const gb = (blocks) => Math.round((blocks * s.bsize) / 1e8) / 10 // one decimal
  return { path: dir, free_gb: gb(s.bavail), total_gb: gb(s.blocks) }
}

/** The report for the heartbeat, or null when this platform cannot measure it. */
function diskReport ({ dir = path.join(os.homedir(), '.iris'), now = Date.now(), statfs = measure } = {}) {
  if (!cache || now - cache.at >= SAMPLE_MS) {
    try {
      cache = { at: now, value: statfs(dir) }
    } catch {
      cache = { at: now, value: null }
    }
  }
  if (!cache.value) return null
  return lastWriteError ? { ...cache.value, last_write_error: lastWriteError } : { ...cache.value }
}

/** Remember a failed state write (ENOSPC/EROFS), so the platform hears about it on the next beat. */
function recordWriteError (err, filePath) {
  lastWriteError = {
    code: String(err && err.code ? err.code : 'EIO'),
    file: path.basename(String(filePath || '')),
    at: new Date().toISOString()
  }
  cache = null // re-measure now: a write just failed, the free space is the question
}

function _resetForTests () { cache = null; lastWriteError = null }

module.exports = { diskReport, recordWriteError, _resetForTests }
