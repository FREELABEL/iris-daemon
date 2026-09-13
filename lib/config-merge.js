'use strict'

/**
 * Merge a patch into ~/.iris/config.json without destroying what is already there.
 *
 * `iris-daemon register` used to do this:
 *
 *   printf '{"node_api_key":"%s","user_id":%s,"api_url":"..."}\n' ... > "$IRIS_CONFIG"
 *
 * `>` truncates, so every field outside those three was destroyed — including
 * node_id, the node's own identity — and api_url was silently reverted to the
 * default even when the machine pointed somewhere else. user_id came from
 * grepping a .env: unset produced `"user_id":0`, a valid-looking wrong owner, and
 * a non-numeric value produced `"user_id":abc`, which is not JSON at all, so the
 * daemon could no longer read its own config (#185145).
 *
 * The patch is passed as an object here and comes from STDIN in the CLI form
 * below — never argv, because the node key would otherwise show up in `ps` on a
 * machine other people share.
 */

const fs = require('fs')
const path = require('path')

/** Fields that must be a positive integer if present. */
function validate (patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('config patch must be a JSON object')
  }
  if (Object.keys(patch).length === 0) {
    // A no-op that prints "Registered!" is worse than an error: it teaches the
    // operator that the command worked.
    throw new Error('refusing an empty config patch — nothing would be written, and the caller would report success')
  }
  if ('user_id' in patch) {
    const raw = patch.user_id
    // Shell callers always hand over strings, so "193" has to be accepted — but
    // only when it is genuinely an integer.
    const n = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
      throw new Error(
        `refusing to write user_id=${JSON.stringify(raw)} — it must be a positive integer. ` +
        'This usually means IRIS_USER_ID is missing from ~/.iris/sdk/.env; run iris-login. ' +
        'Writing 0 would register this node under the wrong owner, and a non-numeric value ' +
        'would make config.json unparseable.'
      )
    }
    patch = { ...patch, user_id: n }
  }
  return patch
}

function mergeConfig (configPath, rawPatch) {
  const patch = validate(rawPatch)

  let existing = {}
  if (fs.existsSync(configPath)) {
    const text = fs.readFileSync(configPath, 'utf-8')
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed
      else throw new Error('not an object')
    } catch {
      // Do NOT discard it. A corrupt config is the only copy of whatever was in
      // there, and registration has to be able to recover the node regardless.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backup = path.join(path.dirname(configPath), `config.json.corrupt-${stamp}`)
      fs.writeFileSync(backup, text, { mode: 0o600 })
      console.warn(`[config] ${configPath} was unreadable — kept a copy at ${backup} and starting from the patch`)
    }
  }

  const merged = { ...existing, ...patch }

  // Atomic: a crash mid-write must not leave a truncated config holding a live key.
  const tmp = `${configPath}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, configPath)
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* best effort */ }
  }
  // rename preserves the temp file's mode, but an existing loose file could have
  // been 0644 — assert the result rather than trusting the path taken.
  fs.chmodSync(configPath, 0o600)

  return merged
}

module.exports = { mergeConfig }

// CLI:  node lib/config-merge.js <configPath>   with the patch JSON on stdin.
if (require.main === module) {
  const configPath = process.argv[2]
  if (!configPath) {
    console.error('usage: node lib/config-merge.js <config.json>   (patch JSON on stdin)')
    process.exit(2)
  }
  let stdin = ''
  process.stdin.setEncoding('utf-8')
  process.stdin.on('data', (c) => { stdin += c })
  process.stdin.on('end', () => {
    let patch
    try {
      patch = JSON.parse(stdin)
    } catch (err) {
      console.error(`[config] the patch on stdin is not valid JSON: ${err.message}`)
      process.exit(2)
    }
    try {
      const merged = mergeConfig(configPath, patch)
      // Keys only. Never echo values — this object holds a live node key.
      console.log(`[config] merged into ${configPath}; fields now: ${Object.keys(merged).sort().join(', ')}`)
    } catch (err) {
      console.error(`[config] ${err.message}`)
      process.exit(1)
    }
  })
}
