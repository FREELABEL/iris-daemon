'use strict'

/**
 * Fill in the two fields opencode sessions report as null: `model` and `git_branch`.
 *
 * Both were hardcoded `null` in the /api/sessions/opencode handler, so HALF the fleet's
 * sessions had no model — measured: 10 of 20 on each of two machines. You could not answer
 * "what is this session costing me" for any opencode session.
 *
 * BOUNDED ON PURPOSE. The model lives in the message files, and a real session has hundreds
 * (272 in one measured here). Reading them all, per session, on a heartbeat is precisely the
 * failure that wedged a node for 26 hours — a recursive synchronous walk on a timer
 * (#182371). So:
 *
 *   - model  : ONE readdir + ONE file read per session, newest message only.
 *   - branch : reads `.git/HEAD` directly. No subprocess, no `git` call, one small file.
 *
 * Every path returns null rather than throwing. A missing field is a missing field; it must
 * never take down the session listing that carries it.
 */

const fs = require('fs')
const path = require('path')

/**
 * The model from a session's most recent message.
 *
 * @param {string} msgDir  ~/.local/share/opencode/storage/message/<session_id>
 * @returns {string|null}  e.g. "iris/iris-ai", or null when unknown
 */
function readOpencodeModel (msgDir) {
  try {
    if (!msgDir || !fs.existsSync(msgDir)) return null

    const files = fs.readdirSync(msgDir).filter((f) => f.endsWith('.json'))
    if (files.length === 0) return null

    // opencode message ids sort lexicographically by creation, so the last name is the
    // newest. This avoids stat()ing every file just to find the most recent one — the
    // difference between one syscall and several hundred.
    files.sort()
    const newest = files[files.length - 1]

    const d = JSON.parse(fs.readFileSync(path.join(msgDir, newest), 'utf8'))
    if (!d) return null

    // TWO SHAPES, both live in the same directory. Measured on real data:
    //   user      -> { model: { providerID, modelID } }
    //   assistant -> { modelID, providerID }   (top level, no `model` key at all)
    // Handling only the nested form returned null for every session whose newest message
    // was an assistant reply — which is most of them, and is why this looked broken after
    // the first fix. One sample was not enough to learn the schema.
    const providerID = d.providerID || (d.model && d.model.providerID) || null
    const modelID = d.modelID || (d.model && d.model.modelID) || null

    if (typeof d.model === 'string') return d.model

    if (providerID && modelID) {
      // Do NOT prefix when the modelID already carries the provider. Live data returns
      // providerID "iris" with modelID "iris/iris-ai", and blind concatenation produced
      // "iris/iris/iris-ai" — a value that looks like a model and matches nothing.
      return modelID.startsWith(`${providerID}/`) ? modelID : `${providerID}/${modelID}`
    }

    return modelID || providerID || null
  } catch {
    return null
  }
}

/**
 * The checked-out branch of a working directory, without spawning git.
 *
 * `.git/HEAD` is one short file: `ref: refs/heads/main`. A detached HEAD holds a raw sha
 * instead, which is reported as null — "not on a branch" is not a branch name, and
 * inventing one would be worse than admitting we do not have it.
 *
 * @returns {string|null}
 */
function readGitBranch (dir) {
  try {
    if (!dir) return null

    const head = path.join(dir, '.git', 'HEAD')
    if (!fs.existsSync(head)) return null

    const raw = fs.readFileSync(head, 'utf8').trim()
    const m = raw.match(/^ref:\s*refs\/heads\/(.+)$/)

    return m ? m[1] : null
  } catch {
    return null
  }
}

module.exports = { readOpencodeModel, readGitBranch }
