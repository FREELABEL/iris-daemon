'use strict'

// Write a state file so that a failed write leaves the OLD file intact (Hermes audit,
// EVAL #188663 — "cron survives a full / read-only disk").
//
// fs.writeFileSync truncates first and writes second. On a full disk (ENOSPC) the truncate
// succeeds and the write does not, leaving an empty or half-written file. For three files that
// is not a log line lost, it is state destroyed:
//
//   ~/.iris/config.json         node_api_key + node_id. The next boot swallows the parse error,
//                               starts from {}, and the node cannot authenticate — it is gone
//                               from the fleet until someone re-enrolls it by hand.
//   schedules.json              every local cron schedule, silently empty after a restart.
//   pending-results.json        offline schedule results; once corrupt, every later append
//                               fails to parse and drops the result.
//
// Write to a sibling temp file, fsync it, then rename over the target. rename(2) within one
// directory is atomic: readers see the old file or the new one, never a torn one. On any
// failure the temp file is removed and the error is rethrown — callers already catch and log,
// and now what they log is the truth (ENOSPC) instead of a corrupt file found next boot.

const fs = require('fs')
const path = require('path')

function writeFileAtomic (filePath, contents, options = {}) {
  const mode = options.mode
  const dir = path.dirname(filePath)
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
  let fd = null
  try {
    fd = fs.openSync(tmp, 'w', mode === undefined ? 0o666 : mode)
    fs.writeSync(fd, typeof contents === 'string' ? Buffer.from(contents, 'utf-8') : contents)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    if (mode !== undefined) {
      // `mode` on open applies only at creation and is masked by umask; set it outright.
      try { fs.chmodSync(tmp, mode) } catch { /* platform without chmod */ }
    }
    fs.renameSync(tmp, filePath)
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd) } catch {} }
    try { fs.unlinkSync(tmp) } catch {}
    throw err
  }
}

module.exports = { writeFileAtomic }
