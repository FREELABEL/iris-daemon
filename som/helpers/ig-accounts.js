'use strict'
// Our own Instagram accounts, and whose login each instagram-auth-<handle>.json really holds.
//
// Two failures this exists to stop:
//
// #191633 — reading @thebeatbox__'s inbox made leads for @thediscoverpage_ and @freelabelnet,
//   because our own accounts had messaged it. ownedHandles() is the ONE list of our handles; every
//   path that creates a lead, DMs, or counts someone checks it.
//
// #191635 — instagram-auth-thediscoverpage_.json was byte-identical to instagram-auth-freelabelnet.json
//   (2026-10-03, 2026-10-26, 2026-10-28). The cloud session store is keyed by board + platform, not by
//   handle, and both accounts run on board 80, so a pull wrote @freelabelnet's login under
//   @thediscoverpage_'s name. writeAuthFile() is the only way to write an auth file: it needs the
//   username the session was verified as, and refuses a login another account's file already holds.
//
// Pure Node, no browser and no network: unit-tested in tests/som-ig-accounts.test.js.

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const SOM_DIR = path.join(__dirname, '..')
const AUTH_RE = /^instagram-auth-(.+)\.json$/
// Written into the session file by a check that saw which account was logged in. Playwright reads
// only `cookies` and `origins` from a storageState, so the extra key is ignored there, and it
// travels with the file through `iris som push-sessions` / pull-sessions.
const STAMP_KEY = 'iris_verified'

function normalizeHandle (h) {
  return String(h == null ? '' : h).trim().replace(/^@+/, '').trim().toLowerCase()
}

/** "instagram-auth-heyiris.io.json" → "heyiris.io"; anything else (incl. the legacy instagram-auth.json) → null. */
function authFileHandle (filename) {
  const m = AUTH_RE.exec(path.basename(String(filename || '')))
  return m ? normalizeHandle(m[1]) : null
}

function authFilePath (somDir, handle) {
  return path.join(somDir, `instagram-auth-${normalizeHandle(handle)}.json`)
}

/** Handles with an instagram-auth-<handle>.json in any of these directories. */
function listAuthAccounts (dirs) {
  const out = new Set()
  for (const dir of [].concat(dirs || [])) {
    let names = []
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const n of names) {
      const h = authFileHandle(n)
      if (h) out.add(h)
    }
  }
  return out
}

function splitHandles (raw) {
  return String(raw || '').split(',').map(s => normalizeHandle(s.split(':')[0])).filter(Boolean)
}

/**
 * Every Instagram handle that is us:
 *   - SOM_OWNED_HANDLES (comma list) — the explicit config;
 *   - every instagram-auth-<handle>.json we hold a login for;
 *   - every igAccount the SOM campaign cache knows, active or not;
 *   - the accounts this run reads (CAPTURE_ACCOUNTS, IG_ACCOUNT).
 */
function loadOwnedHandles ({ somDir = SOM_DIR, env = process.env, extraDirs } = {}) {
  const owned = new Set(splitHandles(env.SOM_OWNED_HANDLES))
  const dirs = [somDir].concat(extraDirs || [path.join(somDir, '..', '..', '..')])
  for (const h of listAuthAccounts(dirs)) owned.add(h)
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(somDir, '.som-campaigns-cache.json'), 'utf8'))
    for (const c of Object.values((cache && cache.campaigns) || {})) {
      const h = normalizeHandle(c && c.igAccount)
      if (h) owned.add(h)
    }
  } catch { /* no cache: the other sources still apply */ }
  for (const h of splitHandles(env.CAPTURE_ACCOUNTS)) owned.add(h)
  if (env.IG_ACCOUNT) owned.add(normalizeHandle(env.IG_ACCOUNT))
  owned.delete('')
  return owned
}

let cached = null
/** The process-wide owned list (computed once). Tests pass their own set instead. */
function ownedHandles () {
  if (!cached) cached = loadOwnedHandles()
  return cached
}

function isOwnedHandle (handle, owned = ownedHandles()) {
  const h = normalizeHandle(handle)
  return !!h && owned.has(h)
}

// ── Whose login is in a session file ───────────────────────────────

/** The logged-in Instagram user id (the ds_user_id cookie), or ''. */
function sessionUserId (state) {
  const cookies = (state && state.cookies) || []
  const c = cookies.find(k => k && k.name === 'ds_user_id' && /instagram\.com$/.test(String(k.domain || '').replace(/^\./, '')))
  return c && c.value ? String(c.value) : ''
}

function readState (file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function md5 (buf) {
  return crypto.createHash('md5').update(buf).digest('hex')
}

/**
 * Pairs of accounts whose auth files hold the same login: identical bytes, or the same
 * logged-in user id. Either way at least one of them is somebody else's session.
 */
function findDuplicateAuthFiles (somDir) {
  let names = []
  try { names = fs.readdirSync(somDir) } catch { return [] }
  const files = names.filter(n => authFileHandle(n)).sort().map(n => {
    const file = path.join(somDir, n)
    let bytes = null
    try { bytes = fs.readFileSync(file) } catch {}
    let state = null
    try { state = bytes ? JSON.parse(bytes.toString('utf8')) : null } catch {}
    return { handle: authFileHandle(n), file, sum: bytes ? md5(bytes) : '', userId: sessionUserId(state) }
  })
  const dupes = []
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const a = files[i]; const b = files[j]
      if (a.sum && a.sum === b.sum) dupes.push({ handles: [a.handle, b.handle], files: [a.file, b.file], why: 'identical files' })
      else if (a.userId && a.userId === b.userId) dupes.push({ handles: [a.handle, b.handle], files: [a.file, b.file], why: 'the same logged-in Instagram user' })
    }
  }
  return dupes
}

class DuplicateAuthError extends Error {}

function duplicateMessage (d) {
  return `instagram-auth-${d.handles[0]}.json and instagram-auth-${d.handles[1]}.json hold ${d.why} — ` +
    `one account's login was copied to the other (#191635). Refusing to use either; ` +
    `log each account in again on this machine.`
}

/** Throws DuplicateAuthError, naming both files, when this account's file duplicates another's. */
function assertDistinctAuthFile (somDir, handle) {
  const h = normalizeHandle(handle)
  const d = findDuplicateAuthFiles(somDir).find(x => x.handles.includes(h))
  if (d) throw new DuplicateAuthError(duplicateMessage(d))
}

/**
 * The only way to write instagram-auth-<handle>.json.
 * verifiedUsername is the username Instagram showed as logged in for THIS session; it must be the
 * handle. The file is refused when another account's file already holds the same login.
 */
function writeAuthFile (somDir, handle, state, { verifiedUsername, now = () => new Date().toISOString() } = {}) {
  const h = normalizeHandle(handle)
  if (!h) throw new Error('writeAuthFile: no handle')
  const viewer = normalizeHandle(verifiedUsername)
  if (!viewer) throw new Error(`refusing to save a login as @${h}: nobody checked which account it is logged in as`)
  if (viewer !== h) throw new Error(`refusing to save a login as @${h}: the session is logged in as @${viewer}`)
  if (!state || !Array.isArray(state.cookies) || state.cookies.length === 0) {
    throw new Error(`refusing to save a login as @${h}: the session has no cookies`)
  }
  const userId = sessionUserId(state)
  if (!userId) throw new Error(`refusing to save a login as @${h}: the session has no ds_user_id cookie (not logged in)`)

  const target = authFilePath(somDir, h)
  let names = []
  try { names = fs.readdirSync(somDir) } catch {}
  for (const n of names) {
    const other = authFileHandle(n)
    if (!other || other === h) continue
    const otherState = readState(path.join(somDir, n))
    if (otherState && sessionUserId(otherState) === userId) {
      throw new DuplicateAuthError(`refusing to save @${h}'s login: instagram-auth-${other}.json already holds the same Instagram user (${userId}). ` +
        'One account\'s login must never be saved under another\'s name (#191635).')
    }
  }

  const out = { ...state, [STAMP_KEY]: { handle: h, userId, verifiedAt: now() } }
  fs.mkdirSync(somDir, { recursive: true })
  const tmp = `${target}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, target)
  return target
}

/**
 * A session from somewhere this machine did not watch log in (the cloud store) may only be
 * saved as @handle if a check that saw the logged-in username stamped it as @handle, and the
 * login in it is still the one stamped. Returns '' when it may be saved, or the reason not.
 */
function pulledSessionProblem (handle, state) {
  const h = normalizeHandle(handle)
  const stamp = state && state[STAMP_KEY]
  const userId = sessionUserId(state)
  if (!userId) return `the cloud session for @${h} is not logged in (no ds_user_id cookie)`
  if (!stamp || !stamp.handle) return `the cloud session for @${h} was never verified as @${h} — nothing proves whose login it is`
  if (normalizeHandle(stamp.handle) !== h) return `the cloud session for @${h} is @${normalizeHandle(stamp.handle)}'s login`
  if (String(stamp.userId || '') !== userId) return `the cloud session for @${h} no longer holds the login that was verified as @${h}`
  return ''
}

/** Stamp an existing auth file as verified for handle (after a live check saw it logged in as handle). */
function stampVerifiedAuthFile (somDir, handle, opts = {}) {
  const state = readState(authFilePath(somDir, handle))
  if (!state) throw new Error(`no readable instagram-auth-${normalizeHandle(handle)}.json to stamp`)
  const stamp = state[STAMP_KEY]
  if (stamp && normalizeHandle(stamp.handle) === normalizeHandle(handle) && String(stamp.userId) === sessionUserId(state)) return false
  const { [STAMP_KEY]: _old, ...clean } = state
  writeAuthFile(somDir, handle, clean, { verifiedUsername: handle, ...opts })
  return true
}

/** Boards that more than one IG account runs on: the cloud holds ONE Instagram login per board. */
function sharedBoards (configs) {
  const byBoard = new Map()
  for (const c of Object.values(configs || {})) {
    const ig = normalizeHandle(c && c.igAccount)
    const board = c && c.boardId
    if (!ig || !board) continue
    const key = String(board)
    if (!byBoard.has(key)) byBoard.set(key, new Set())
    byBoard.get(key).add(ig)
  }
  const out = new Map()
  for (const [board, set] of byBoard) if (set.size > 1) out.set(board, [...set].sort())
  return out
}

module.exports = {
  STAMP_KEY,
  normalizeHandle,
  authFileHandle,
  authFilePath,
  listAuthAccounts,
  loadOwnedHandles,
  ownedHandles,
  isOwnedHandle,
  sessionUserId,
  findDuplicateAuthFiles,
  assertDistinctAuthFile,
  DuplicateAuthError,
  writeAuthFile,
  pulledSessionProblem,
  stampVerifiedAuthFile,
  sharedBoards,
}
