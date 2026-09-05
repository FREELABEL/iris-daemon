'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

/**
 * M6.2, node side — the files a script needs, written next to it before it runs.
 *
 * ADR-04 says assets do not execute, and the server enforces that on upload. This module
 * enforces WHERE they land, and it re-validates paths the server already validated.
 *
 * That is not redundancy for its own sake. This is the code that actually reaches a
 * filesystem: the server's rules could be relaxed later, an older server could be on the
 * other end, or a response could be altered in transit. Any of those turns "the server
 * checked" into a sentence nobody can rely on at the moment a file is written — and the cost
 * of being wrong here is a file outside the workspace.
 */

/** Same ceiling as the server, so a node cannot be made to write more than it agreed to. */
const MAX_TOTAL_BYTES = 8 * 1024 * 1024

/**
 * Decide where one asset may be written.
 *
 * COMPARES RESOLVED PATHS, NOT STRING PREFIXES. On macOS /tmp is a symlink to /private/tmp,
 * so an unresolved startsWith can compare two spellings of the same directory and be wrong in
 * both directions — and `/tmp/work-evil` shares a prefix with `/tmp/work` while being a
 * different place entirely. The separator on the end is what closes that.
 *
 * @returns {{ok: boolean, absolute?: string, reason?: string}}
 */
function planAssetWrite (workspaceDir, assetPath) {
  if (typeof assetPath !== 'string' || assetPath === '' || assetPath.length > 200) {
    return { ok: false, reason: 'asset path must be between 1 and 200 characters' }
  }
  if (assetPath.includes('\0')) {
    return { ok: false, reason: 'asset path contains a null byte' }
  }

  // `~` is refused explicitly. path.resolve does NOT expand it, so `~/.ssh/x` would land at
  // <workspace>/~/.ssh/x — inside the workspace, so not an escape, but a literal `~`
  // directory that a later shell expansion could misread. The server refuses it too; two
  // implementations of one rule should agree.
  if (assetPath.startsWith('~')) {
    return { ok: false, reason: 'asset path may not start with ~ (it is not expanded, and escapes the workspace by surprise)' }
  }

  const root = path.resolve(workspaceDir)
  const absolute = path.resolve(root, assetPath)

  // The trailing separator is load-bearing: without it, /tmp/work-evil passes a prefix test
  // against /tmp/work.
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    return { ok: false, reason: `asset path escapes the workspace: ${assetPath}` }
  }
  if (absolute === root) {
    return { ok: false, reason: 'asset path resolves to the workspace itself' }
  }

  return { ok: true, absolute }
}

/**
 * Write a script's assets into its workspace.
 *
 * VERIFIES EACH SHA BEFORE WRITING. A truncated download that runs anyway produces wrong
 * output rather than an error — the watermarker silently stamps half a logo — which is the
 * failure this whole epic keeps finding in other forms.
 *
 * Returns what it wrote so the caller can log it. Throws on a bad asset rather than skipping:
 * a script whose inputs are incomplete should not start.
 */
function materialiseAssets (workspaceDir, assets, log = console) {
  const written = []
  let total = 0

  for (const a of assets || []) {
    const plan = planAssetWrite(workspaceDir, a && a.path)
    if (!plan.ok) throw new Error(`refusing to write asset — ${plan.reason}`)

    const bytes = Buffer.from(String(a.content_base64 || ''), 'base64')
    if (bytes.length === 0) throw new Error(`asset '${a.path}' decoded to nothing`)

    total += bytes.length
    if (total > MAX_TOTAL_BYTES) throw new Error('assets exceed the total size limit for one script')

    if (a.sha256) {
      const got = crypto.createHash('sha256').update(bytes).digest('hex')
      if (got !== a.sha256) {
        throw new Error(`asset '${a.path}' failed its checksum — expected ${a.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…`)
      }
    }

    fs.mkdirSync(path.dirname(plan.absolute), { recursive: true })
    fs.writeFileSync(plan.absolute, bytes)
    // NEVER EXECUTABLE ON DISK, whatever the server said. ADR-04 is a property of the file,
    // and the mode is the only place that property is real once it is written.
    fs.chmodSync(plan.absolute, 0o644)
    written.push({ path: a.path, bytes: bytes.length })
  }

  if (written.length) {
    log.log(`[executor] materialised ${written.length} asset(s) (${total} bytes) into the workspace`)
  }

  return written
}

module.exports = { planAssetWrite, materialiseAssets, MAX_TOTAL_BYTES }
