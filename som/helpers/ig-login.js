'use strict'
// Log an Instagram account in for SOM, by hand, and save the session only once Instagram says
// whose login it is (#191636).
//
// The person types the password and any 2FA code into the window. Nothing here reads, fills,
// stores or logs a credential: it opens the login page, waits, and watches for two things —
// a ds_user_id cookie (somebody is logged in) and the username Instagram serves for that login.
// The session is saved through ig-accounts.writeAuthFile, the one writer of
// instagram-auth-<handle>.json, and only when that username IS the handle asked for (#191635).
//
// The browser and the "who is logged in" check are injected, so the whole flow is unit-tested
// with fakes (tests/som-login.test.js) — no browser, no network, no real auth file.

const igAccounts = require('./ig-accounts')

const LOGIN_URL = 'https://www.instagram.com/accounts/login/'
const INBOX_URL = 'https://www.instagram.com/direct/inbox/'
const CURRENT_USER_URL = 'https://www.instagram.com/api/v1/accounts/current_user/?edit=true'
// The public web app id instagram.com itself sends; the private API refuses requests without it.
const IG_APP_ID = '936619743392459'

const OUTCOMES = ['saved', 'mismatch', 'refused', 'closed', 'timeout', 'error']
const EXIT_CODES = { saved: 0, error: 1, mismatch: 2, closed: 3, timeout: 4, refused: 5 }

// Instagram usernames: letters, digits, '.' and '_', at most 30. Validating here also keeps the
// handle safe to put in a file name, a launchd label and a shell line.
const HANDLE_RE = /^[a-z0-9._]{1,30}$/

function parseHandle (raw) {
  const h = igAccounts.normalizeHandle(raw)
  if (!HANDLE_RE.test(h)) throw new Error(`not an Instagram username: ${JSON.stringify(String(raw == null ? '' : raw))}`)
  return h
}

/**
 * The logged-in account's username, read from the inbox document Instagram serves.
 * '' when it cannot be determined — which means "not confirmed", never "fine".
 */
function viewerUsernameFromHtml (html) {
  const s = String(html || '')
  const m = s.match(/"should_show_public_contacts":(?:true|false),"username":"([^"]+)"/) ||
    s.match(/"viewer":\{[^{}]*"username":"([^"]+)"/)
  return m ? m[1] : ''
}

function cookieUserId (cookies) {
  return igAccounts.sessionUserId({ cookies: cookies || [] })
}

/**
 * Ask Instagram, with this browser context's own cookies, which account is logged in.
 * Two independent sources: the inbox document (what the SOM inbox reader already trusts), then
 * the current_user API. Returns { username, userId } or { username: '' } when neither answered.
 */
async function identifyViewer (context) {
  try {
    const res = await context.request.get(INBOX_URL, { timeout: 20000 })
    const username = viewerUsernameFromHtml(await res.text())
    if (username) return { username, source: 'inbox' }
  } catch { /* fall through to the API */ }
  try {
    const res = await context.request.get(CURRENT_USER_URL, { timeout: 20000, headers: { 'X-IG-App-ID': IG_APP_ID } })
    const body = await res.json()
    const user = body && body.user
    if (user && user.username) return { username: String(user.username), userId: user.pk != null ? String(user.pk) : '', source: 'current_user' }
  } catch { /* not answered */ }
  return { username: '' }
}

const realSleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Open a headed window on the login page, wait for the person to log in, verify, save.
 *
 * deps:
 *   launch()   → { browser, context } — a HEADED browser (the person needs to see it)
 *   identify(context) → { username, userId? }
 *   somDir     — where instagram-auth-<handle>.json lives
 * Resolves to { outcome, handle, viewer?, file?, message } with outcome one of OUTCOMES.
 * Never throws for a person's action (closing the window, logging in as someone else).
 */
async function runLogin ({
  handle,
  somDir,
  launch,
  identify = identifyViewer,
  timeoutMs = 8 * 60 * 1000,
  pollMs = 2000,
  log = () => {},
  sleep = realSleep,
  clock = () => Date.now(),
}) {
  const h = parseHandle(handle)
  let browser = null
  let context = null
  let closed = false
  const done = (outcome, message, extra = {}) => ({ outcome, handle: h, message, ...extra })

  try {
    try {
      ({ browser, context } = await launch())
    } catch (err) {
      return done('error', `could not open a browser window: ${err.message}`)
    }
    const markClosed = () => { closed = true }
    if (browser && typeof browser.on === 'function') browser.on('disconnected', markClosed)
    const page = await context.newPage()
    if (page && typeof page.on === 'function') page.on('close', markClosed)

    log(`A browser window is open on the Instagram login page. Log in as @${h} there —`)
    log('type the password and any 2FA code yourself. Nothing is saved until Instagram confirms the account.')
    // A slow first load is not a failure: the window is the person's to drive (they can reload).
    // Only a load that never starts is reported, and the wait goes on.
    page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
      .catch(err => { if (!closed) log(`the login page has not finished loading (${String(err.message).split('\n')[0]}) — reload it in the window if it stays blank`) })

    const deadline = clock() + timeoutMs
    while (clock() < deadline) {
      if (closed) return done('closed', `the window was closed before @${h} was logged in — nothing was saved`)
      let cookies = []
      try { cookies = await context.cookies('https://www.instagram.com') } catch (err) {
        if (closed) continue
        throw err
      }
      const userId = cookieUserId(cookies)
      if (userId) {
        let who = { username: '' }
        try { who = (await identify(context)) || { username: '' } } catch { who = { username: '' } }
        if (closed) continue
        const viewer = igAccounts.normalizeHandle(who.username)
        if (viewer) {
          if (viewer !== h) {
            return done('mismatch', `this window is logged in as @${viewer}, not @${h} — nothing was saved. ` +
              `Run the login again and log in as @${h} (log out of @${viewer} first).`, { viewer })
          }
          if (who.userId && who.userId !== userId) {
            return done('mismatch', `Instagram reports @${viewer} as user ${who.userId} but the session's cookie is user ${userId} — nothing was saved`, { viewer })
          }
          const state = await context.storageState()
          try {
            const file = igAccounts.writeAuthFile(somDir, h, state, { verifiedUsername: viewer })
            return done('saved', `logged in and verified as @${viewer} — saved ${require('path').basename(file)}`, { viewer, file })
          } catch (err) {
            return done('refused', err.message, { viewer })
          }
        }
        // Logged in, but Instagram has not said as whom yet (a 2FA or "save login" screen):
        // keep waiting and ask again next time.
      }
      await sleep(pollMs)
    }
    return done('timeout', `nobody finished logging in as @${h} within ${Math.round(timeoutMs / 60000)} min — nothing was saved`)
  } catch (err) {
    if (closed) return done('closed', `the window was closed before @${h} was logged in — nothing was saved`)
    return done('error', err.message)
  } finally {
    try { if (browser) await browser.close() } catch {}
  }
}

/** The real headed browser: Playwright's Chromium from the daemon's own node_modules. */
function playwrightLauncher ({ channel } = {}) {
  return async () => {
    const { chromium } = require('playwright')
    const browser = await chromium.launch({ headless: false, ...(channel ? { channel } : {}) })
    const context = await browser.newContext({ viewport: null })
    return { browser, context }
  }
}

module.exports = {
  LOGIN_URL,
  OUTCOMES,
  EXIT_CODES,
  parseHandle,
  viewerUsernameFromHtml,
  identifyViewer,
  runLogin,
  playwrightLauncher,
}
