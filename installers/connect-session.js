#!/usr/bin/env node

/**
 * IRIS Connect — One-command browser session capture + upload.
 *
 * Opens a browser, lets the user log in, captures cookies,
 * and publishes them encrypted to the IRIS project vault.
 *
 * Usage:
 *   node connect-session.js --platform linkedin --project 217 --api-url https://iris-api.freelabel.net --user-id 193
 *   node connect-session.js --platform instagram --project 217
 *   node connect-session.js --platform twitter --project 217
 *   node connect-session.js --platform youtube --project 217
 *
 * Non-technical users: copy the command from the IRIS dashboard
 * Credentials tab and paste it into Terminal / Command Prompt.
 */

const { chromium } = require('playwright')
const https = require('https')
const http = require('http')
const { URL } = require('url')

// ── Parse CLI args ──────────────────────────────────────────────
function parseArgs () {
  const args = {}
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = process.argv[i + 1]
      if (next && !next.startsWith('--')) {
        args[key] = next
        i++
      } else {
        args[key] = true
      }
    }
  }
  return args
}

const args = parseArgs()
const PLATFORM = (args.platform || '').toLowerCase()
const PROJECT_ID = args.project || args['project-id'] || args['bloq-id']
const USER_ID = args['user-id'] || args.user || '193'
const API_URL = (args['api-url'] || args.api || 'https://iris-api.freelabel.net').replace(/\/$/, '')
const API_TOKEN = args.token || args['api-token'] || process.env.FL_RAICHU_API_TOKEN || ''

// ── Platform configs ────────────────────────────────────────────
const PLATFORMS = {
  linkedin: {
    name: 'LinkedIn',
    url: 'https://www.linkedin.com/login',
    cookieConsent: 'button:has-text("Accept cookies"), button:has-text("Accept & join")',
    loginChecks: [
      '.feed-identity-module, .scaffold-layout__main',
      'nav[aria-label="Primary"], .global-nav',
      'input[aria-label="Search"]',
      'a[href*="/messaging/"]'
    ],
    timeout: 300
  },
  instagram: {
    name: 'Instagram',
    url: 'https://www.instagram.com/accounts/login/',
    cookieConsent: 'button:has-text("Allow all cookies"), button:has-text("Allow essential and optional cookies")',
    loginChecks: [
      'svg[aria-label="Home"]',
      'svg[aria-label="Search"]',
      'svg[aria-label="Messenger"], svg[aria-label="Direct"]'
    ],
    timeout: 300
  },
  twitter: {
    name: 'Twitter / X',
    url: 'https://x.com/i/flow/login',
    cookieConsent: 'button:has-text("Accept all cookies"), button:has-text("Accept all")',
    loginChecks: [
      '[data-testid="AppTabBar_Home_Link"]',
      'a[aria-label="Home"]',
      '[data-testid="SideNav_AccountSwitcher_Button"]'
    ],
    timeout: 300
  },
  youtube: {
    name: 'YouTube',
    url: 'https://www.youtube.com',
    cookieConsent: 'button:has-text("Accept all"), button:has-text("Accept"), button:has-text("I agree")',
    loginChecks: [
      'button#avatar-btn, img.yt-spec-avatar-shape__avatar',
      'ytd-mini-guide-renderer, ytd-guide-renderer'
    ],
    timeout: 600
  }
}

// ── HTTP helper ─────────────────────────────────────────────────
function postJSON (url, body, token) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const mod = parsed.protocol === 'https:' ? https : http
    const payload = JSON.stringify(body)

    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) })
        } catch {
          resolve({ status: res.statusCode, body: data })
        }
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

// ── Main ────────────────────────────────────────────────────────
async function main () {
  // Validate args
  if (!PLATFORM || !PLATFORMS[PLATFORM]) {
    console.log('\n  IRIS Connect — Share your browser session with a project\n')
    console.log('  Usage:')
    console.log('    node connect-session.js --platform linkedin --project 217\n')
    console.log('  Platforms: linkedin, instagram, twitter, youtube')
    console.log('  Options:')
    console.log('    --platform     Platform to log into (required)')
    console.log('    --project      IRIS project/bloq ID (required)')
    console.log('    --user-id      Your IRIS user ID (default: 193)')
    console.log('    --api-url      IRIS API URL (default: https://iris-api.freelabel.net)')
    console.log('    --token        API auth token (or set FL_RAICHU_API_TOKEN env var)\n')
    process.exit(1)
  }

  if (!PROJECT_ID) {
    console.error('\n  Error: --project is required. Find your project ID in the IRIS dashboard.\n')
    process.exit(1)
  }

  const config = PLATFORMS[PLATFORM]

  console.log('')
  console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  IRIS Connect — ${config.name}`)
  console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  Project: ${PROJECT_ID}`)
  console.log(`  API:     ${API_URL}`)
  console.log('')

  // Launch browser
  console.log('  Opening browser...')
  const browser = await chromium.launch({ headless: false })
  const context = await browser.newContext()
  const page = await context.newPage()

  await page.goto(config.url)
  await page.waitForTimeout(3000)

  // Handle cookie consent
  const consentBtn = page.locator(config.cookieConsent).first()
  if (await consentBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await consentBtn.click()
    await page.waitForTimeout(1000)
  }

  console.log('')
  console.log('  ┌──────────────────────────────────────────┐')
  console.log('  │  Log in to ' + config.name.padEnd(30) + ' │')
  console.log('  │  in the browser window that just opened. │')
  console.log('  │                                          │')
  console.log('  │  Handle any 2FA prompts if they appear.  │')
  console.log('  │  This window will close automatically.   │')
  console.log('  └──────────────────────────────────────────┘')
  console.log('')

  // Poll for login
  let loggedIn = false
  for (let i = 0; i < config.timeout; i++) {
    for (const selector of config.loginChecks) {
      const visible = await page.locator(selector).first().isVisible().catch(() => false)
      if (visible) {
        loggedIn = true
        break
      }
    }
    if (loggedIn) { break }

    if (i > 0 && i % 15 === 0) {
      console.log(`  Waiting for login... (${i}s)`)
    }
    await page.waitForTimeout(1000)
  }

  if (!loggedIn) {
    console.log('  Timed out waiting for login. Please try again.')
    await browser.close()
    process.exit(1)
  }

  console.log('  Login detected! Capturing session...')
  await page.waitForTimeout(2000)

  // Capture session
  const storageState = await context.storageState()
  await browser.close()

  const cookieCount = (storageState.cookies || []).length
  console.log(`  Captured ${cookieCount} cookies.`)

  if (cookieCount === 0) {
    console.log('  Warning: No cookies captured. The session may not work.')
    process.exit(1)
  }

  // Upload to IRIS
  console.log(`  Uploading to IRIS (project ${PROJECT_ID})...`)
  try {
    const result = await postJSON(`${API_URL}/api/v1/project-credentials`, {
      bloq_id: Number(PROJECT_ID),
      user_id: Number(USER_ID),
      platform: PLATFORM,
      credential_type: 'browser_session',
      credentials: storageState
    }, API_TOKEN)

    if (result.status === 201 || result.status === 200) {
      console.log('')
      console.log('  ┌──────────────────────────────────────────┐')
      console.log('  │              Session saved!               │')
      console.log('  │                                          │')
      console.log(`  │  Platform: ${config.name.padEnd(28)} │`)
      console.log(`  │  Project:  ${String(PROJECT_ID).padEnd(28)} │`)
      console.log(`  │  Cookies:  ${String(cookieCount).padEnd(28)} │`)
      console.log('  │                                          │')
      console.log('  │  Your session is encrypted and ready     │')
      console.log('  │  for Hive automation tasks.              │')
      console.log('  └──────────────────────────────────────────┘')
      console.log('')
    } else {
      console.error(`  Upload failed (HTTP ${result.status}):`, result.body)
      // Save locally as fallback
      const fs = require('fs')
      const fallbackPath = `${PLATFORM}-auth-backup.json`
      fs.writeFileSync(fallbackPath, JSON.stringify(storageState, null, 2))
      console.log(`  Session saved locally to ${fallbackPath} as backup.`)
      console.log('  You can paste this into the IRIS dashboard Credentials tab.')
      process.exit(1)
    }
  } catch (err) {
    console.error('  Upload failed:', err.message)
    // Save locally as fallback
    const fs = require('fs')
    const fallbackPath = `${PLATFORM}-auth-backup.json`
    fs.writeFileSync(fallbackPath, JSON.stringify(storageState, null, 2))
    console.log(`  Session saved locally to ${fallbackPath} as backup.`)
    console.log('  You can paste this into the IRIS dashboard Credentials tab.')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('  Fatal error:', err.message)
  process.exit(1)
})
