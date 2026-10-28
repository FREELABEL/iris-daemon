'use strict'
// Comment a keyword, get a DM (FL-CO-47, #190735).
//
// The pure half of som/instagram-keyword-dm.spec.ts and POST /api/instagram/keyword-dm: which
// commenters qualify, who the ledger says was already handled, what each one is sent, and how many
// may be sent in one run. No browser here, so every rule that decides who gets a message is
// unit-tested (tests/keyword-dm.test.js) without logging into anything.

const fs = require('fs')
const os = require('os')
const path = require('path')

const DEFAULT_MAX_SENDS = 10
const MAX_SENDS_CEILING = 25
const RESULT_PREFIX = 'KEYWORD_DM_RESULT '
const DEFAULT_LEDGER_FILE = path.join(os.homedir(), '.iris', 'keyword-dm-ledger.json')

// Errors that mean nothing reached the person, so the ledger must not hold them against a retry.
const RETRYABLE_ERRORS = /session expired|challenge/i

/** "PIPELINE, Guide" → ['pipeline', 'guide']; blanks and duplicates dropped. */
function parseKeywords (raw) {
  const out = []
  for (const k of String(raw || '').split(',')) {
    const kw = k.trim().replace(/^#/, '').toLowerCase()
    if (kw && !out.includes(kw)) out.push(kw)
  }
  return out
}

function escapeRegex (s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The keyword this comment contains as a whole word, case-insensitive, or null.
 * "PIPELINE please" and "#pipeline 🙏" match "pipeline"; "pipelines" and "mypipeline" do not.
 */
function matchKeyword (commentText, keywords) {
  const text = String(commentText || '')
  for (const kw of keywords) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegex(kw)}($|[^\\p{L}\\p{N}_])`, 'iu')
    if (re.test(text)) return kw
  }
  return null
}

/** Clamp a requested cap: default 10, never above 25, never below 1. */
function clampMax (raw) {
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_SENDS
  return Math.min(n, MAX_SENDS_CEILING)
}

/** Only DRY_RUN=0 (or "false") sends. Unset, empty or anything else is a dry run. */
function isDryRun (raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase()
  return !(v === '0' || v === 'false')
}

function normalizeHandle (h) {
  return String(h || '').trim().replace(/^@/, '').toLowerCase()
}

/** Fill {handle} in the message template. */
function fillTemplate (template, handle) {
  return String(template || '').replace(/\{handle\}/g, String(handle || '').replace(/^@/, ''))
}

/**
 * The ledger key for a post: its shortcode, so /p/ABC, /reel/ABC/, ?igsh=… and a trailing slash
 * are all the same post. Returns null for anything that is not an instagram post or reel URL.
 */
function postKey (postUrl) {
  const m = String(postUrl || '').match(/^https?:\/\/(?:www\.)?instagram\.com\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i)
  return m ? m[1] : null
}

function readLedger (file = DEFAULT_LEDGER_FILE) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (data && typeof data === 'object' && data.posts && typeof data.posts === 'object') return data
  } catch { /* missing or corrupt: start empty */ }
  return { posts: {} }
}

function ledgerEntries (ledger, postUrl) {
  const key = postKey(postUrl)
  if (!key || !ledger || !ledger.posts || !ledger.posts[key]) return []
  return Array.isArray(ledger.posts[key].entries) ? ledger.posts[key].entries : []
}

/**
 * Handles the ledger holds against another DM on this post. A dry-run entry never counts (it sent
 * nothing), nor does a failure that never reached the person (session expired). Any other real
 * attempt does — including "typed but not confirmed", which may well have been delivered, and a
 * second copy is worse than a missed one.
 */
function handledHandles (ledger, postUrl) {
  const out = new Set()
  for (const e of ledgerEntries(ledger, postUrl)) {
    if (!e || e.dry) continue
    if (e.status !== 'sent' && RETRYABLE_ERRORS.test(String(e.error || ''))) continue
    out.add(normalizeHandle(e.handle))
  }
  return out
}

/** Append results to the ledger in memory; returns the same ledger. */
function appendLedger (ledger, postUrl, results) {
  const key = postKey(postUrl)
  if (!key) throw new Error(`not an instagram post URL: ${postUrl}`)
  ledger.posts = ledger.posts || {}
  const post = ledger.posts[key] || (ledger.posts[key] = { postUrl, entries: [] })
  for (const r of results) post.entries.push(r)
  post.updatedAt = new Date().toISOString()
  return ledger
}

function writeLedger (file, ledger) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const { writeFileAtomic } = require('../../lib/atomic-write')
  writeFileAtomic(file, JSON.stringify(ledger, null, 2))
}

/**
 * Decide who gets a message. `commenters` is [{ username, commentText }] in page order.
 * Returns { targets, skipped } where skipped carries a reason per handle and targets is capped at max.
 * `only`, when non-empty, is the list a person confirmed after a dry run: nobody outside it is sent,
 * so a comment that arrived between the preview and the send is not messaged unseen.
 */
function selectTargets ({ commenters, keywords, account, handled, max, only, owned }) {
  const self = normalizeHandle(account)
  // Every account we own, not just the one sending: ours comment on each other's posts (#191633).
  const ours = owned || require('./ig-accounts').ownedHandles()
  const allow = only && only.size ? only : null
  const done = handled || new Set()
  const cap = clampMax(max)
  const seen = new Set()
  const targets = []
  const skipped = []
  for (const c of commenters || []) {
    const handle = normalizeHandle(c && c.username)
    if (!handle || seen.has(handle)) continue
    const comment = String((c && c.commentText) || '')
    const keyword = matchKeyword(comment, keywords)
    if (!keyword) continue // not asking; not listed, not a skip
    seen.add(handle)
    if (handle === self || ours.has(handle)) { skipped.push({ handle, comment, reason: 'own account' }); continue }
    if (done.has(handle)) { skipped.push({ handle, comment, reason: 'already in ledger' }); continue }
    if (allow && !allow.has(handle)) { skipped.push({ handle, comment, reason: 'not in the confirmed list' }); continue }
    if (targets.length >= cap) { skipped.push({ handle, comment, reason: `over cap (${cap})` }); continue }
    targets.push({ handle, comment, keyword })
  }
  return { targets, skipped }
}

/** ONLY_HANDLES env → Set of normalized handles (empty Set when unset). */
function parseHandles (raw) {
  return new Set(String(raw || '').split(',').map(normalizeHandle).filter(Boolean))
}

/** Is this send result the account being logged out or challenged? Then the run must stop. */
function isSessionStop (result) {
  return !!result && result.status === 'failed' && RETRYABLE_ERRORS.test(String(result.error || ''))
}

/** Human-ish gap between sends, same jitter shape as the comments provider: base ± 40%. */
function jitterDelay (baseMs = 45000, rand = Math.random) {
  return Math.max(0, Math.round(baseMs + (rand() - 0.5) * baseMs * 0.8))
}

/** The machine-readable last line the daemon route parses out of the spec's stdout. */
function formatResultLine (summary) {
  return RESULT_PREFIX + JSON.stringify(summary)
}

function parseResultLine (stdout) {
  const lines = String(stdout || '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const idx = lines[i].indexOf(RESULT_PREFIX)
    if (idx === -1) continue
    try { return JSON.parse(lines[i].slice(idx + RESULT_PREFIX.length)) } catch { /* keep looking */ }
  }
  return null
}

/**
 * Validate a POST /api/instagram/keyword-dm body and turn it into the spec's env.
 * Returns { error } or { env, dry, max }. `send` must be literally true to send.
 */
function buildRunEnv (body, { ledgerFile = DEFAULT_LEDGER_FILE } = {}) {
  const b = body || {}
  const postUrl = String(b.postUrl || '').trim()
  if (!postKey(postUrl)) return { error: 'postUrl must be an instagram.com /p/ or /reel/ URL' }
  const keywords = parseKeywords(b.keyword)
  if (!keywords.length) return { error: 'keyword is required (comma-separate several)' }
  const message = String(b.message || '')
  if (!message.trim()) return { error: 'message is required' }
  if (message.length > 1000) return { error: 'message is longer than 1000 characters' }
  const account = String(b.account || '').trim().replace(/^@/, '')
  if (account && !/^[A-Za-z0-9._]{1,30}$/.test(account)) return { error: 'account is not a valid instagram handle' }
  const dry = b.send !== true
  let only = []
  if (b.handles != null) {
    if (!Array.isArray(b.handles)) return { error: 'handles must be an array of instagram handles' }
    only = [...new Set(b.handles.map(normalizeHandle).filter(Boolean))]
    if (only.some(h => !/^[a-z0-9._]{1,30}$/.test(h))) return { error: 'handles must be instagram handles' }
  }
  const max = clampMax(b.max)
  const env = {
    POST_URL: postUrl,
    KEYWORD: keywords.join(','),
    MESSAGE: message,
    DRY_RUN: dry ? '1' : '0',
    MAX_SENDS: String(max),
    LEDGER_FILE: ledgerFile,
  }
  if (account) env.IG_ACCOUNT = account
  if (only.length) env.ONLY_HANDLES = only.join(',')
  return { env, dry, max }
}

module.exports = {
  DEFAULT_MAX_SENDS,
  MAX_SENDS_CEILING,
  DEFAULT_LEDGER_FILE,
  RESULT_PREFIX,
  parseKeywords,
  matchKeyword,
  clampMax,
  isDryRun,
  normalizeHandle,
  parseHandles,
  fillTemplate,
  postKey,
  readLedger,
  ledgerEntries,
  handledHandles,
  appendLedger,
  writeLedger,
  selectTargets,
  isSessionStop,
  jitterDelay,
  formatResultLine,
  parseResultLine,
  buildRunEnv,
}
