'use strict'
/**
 * Which Mail.app accounts this Mac has — name, id and addresses, nothing else (#191879).
 *
 * WHY. Nodes advertised `apple_mail: available` and nothing about WHICH mailboxes they hold, so
 * "read team@heyiris.io" meant osascript-ing every Mac by hand (2026-10-30: the MacBook had five
 * accounts and not that one; another Mac was offline). And a Mail account NAME is not an identity:
 * "Google" is manage.amrecords@gmail.com on one Mac and alex@freelabel.net on another. The address
 * is the identity, so the heartbeat carries the addresses and the CLI routes on them.
 *
 * WHAT IS SENT. Account name, Mail's account id, the email addresses, enabled. No server names, no
 * user names, no passwords, no mailbox contents — the fleet needs to know which Mac to ask, not how
 * the Mac logs in.
 *
 * HOW IT STAYS HARMLESS.
 *   - Never probed inline: the heartbeat reads a cache, a refresh runs in the background, at most
 *     every REFRESH_MS. A heartbeat that can block makes a healthy node look dead.
 *   - Never LAUNCHES Mail. `tell application "Mail"` (and Application("Mail") in JXA) starts Mail if
 *     it is not running — a background probe must not open an app on the owner's screen. If Mail
 *     is not running the last known list is kept and the reason says so.
 *   - Counts before any bulk fetch: on an empty element list a JXA bulk property fetch throws
 *     -1728 instead of returning [] (measured 2026-09-17, comms-mail-applescript.ts).
 */
const { execFile } = require('child_process')

const REFRESH_MS = 10 * 60 * 1000

const ACCOUNTS_JXA = `(() => {
  const a = Application("Mail").accounts
  const n = a.length
  if (n === 0) return "[]"
  const names = a.name(), ids = a.id(), addrs = a.emailAddresses(), en = a.enabled()
  const out = []
  for (let i = 0; i < n; i++) out.push({ name: names[i], id: ids[i], addresses: addrs[i] || [], enabled: en[i] })
  return JSON.stringify(out)
})()`

/**
 * Parse the probe's stdout into [{name, id, addresses, enabled}]. Throws on anything that is not
 * the expected JSON — a garbled answer must not be advertised as "this Mac has no accounts".
 */
function parseMailAccounts (stdout) {
  const data = JSON.parse(String(stdout).trim())
  if (!Array.isArray(data)) throw new Error('Mail accounts probe did not return a list')
  return data
    .filter((a) => a && typeof a === 'object' && typeof a.name === 'string')
    .map((a) => ({
      name: a.name,
      id: a.id ? String(a.id) : null,
      addresses: (Array.isArray(a.addresses) ? a.addresses : [])
        .map((x) => String(x).trim().toLowerCase())
        .filter((x) => x.includes('@')),
      enabled: a.enabled !== false,
    }))
}

function defaultIsMailRunning () {
  return new Promise((resolve) => {
    execFile('/usr/bin/pgrep', ['-x', 'Mail'], { timeout: 5000 }, (err, stdout) => resolve(!err && String(stdout).trim() !== ''))
  })
}

function defaultRunProbe () {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', ACCOUNTS_JXA], { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || '').replace(/\s+/g, ' ').trim()
        if (/-1743|not allowed|not authori[sz]ed/i.test(msg)) return reject(new Error('Mail.app automation not authorized for the daemon (System Settings → Privacy & Security → Automation)'))
        return reject(new Error(`osascript: ${msg.slice(0, 200)}`))
      }
      resolve(stdout)
    })
  })
}

/**
 * A cache with a background refresh. `snapshot()` is what the heartbeat sends and never blocks.
 * Injected deps keep it testable without a Mac.
 */
function createMailAccountsCache (deps = {}) {
  const platform = deps.platform || process.platform
  const isMailRunning = deps.isMailRunning || defaultIsMailRunning
  const runProbe = deps.runProbe || defaultRunProbe
  const now = deps.now || Date.now
  const refreshMs = deps.refreshMs || REFRESH_MS

  const state = { accounts: null, checkedAt: null, reason: 'not checked yet', attemptedAt: 0, inflight: null }

  async function refresh () {
    if (platform !== 'darwin') {
      state.reason = 'Apple Mail requires macOS'
      return
    }
    state.attemptedAt = now()
    try {
      if (!(await isMailRunning())) {
        // Keep what we last saw: closing Mail does not remove its accounts.
        state.reason = state.accounts
          ? 'Mail.app is not running — showing the accounts it had when last checked'
          : 'Mail.app is not running — accounts are listed once it is open (the daemon never launches it)'
        return
      }
      state.accounts = parseMailAccounts(await runProbe())
      state.checkedAt = new Date(now()).toISOString()
      state.reason = null
    } catch (e) {
      state.reason = `could not list Mail accounts: ${e.message}`
    }
  }

  function maybeRefresh () {
    if (platform !== 'darwin') return
    if (state.inflight || now() - state.attemptedAt < refreshMs) return
    state.inflight = refresh().finally(() => { state.inflight = null })
  }

  /** {accounts, accounts_checked_at, accounts_reason} — accounts is null when never seen. */
  function snapshot () {
    maybeRefresh()
    return {
      accounts: state.accounts,
      accounts_checked_at: state.checkedAt,
      accounts_reason: platform === 'darwin' ? state.reason : 'Apple Mail requires macOS',
    }
  }

  return { snapshot, refresh, maybeRefresh, _state: state }
}

let shared = null
function mailAccountsSnapshot () {
  if (!shared) shared = createMailAccountsCache()
  return shared.snapshot()
}

module.exports = { ACCOUNTS_JXA, parseMailAccounts, createMailAccountsCache, mailAccountsSnapshot, REFRESH_MS }
