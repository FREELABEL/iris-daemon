#!/usr/bin/env node
/**
 * IRIS Hive — Save Browser Session
 *
 * Captures Playwright storageState (cookies + localStorage) for platforms
 * that require browser-based authentication. Sessions are stored locally
 * at ~/.iris/sessions/<platform>.json and used by the Hive daemon when
 * executing browser automation tasks.
 *
 * Usage:
 *   node save-session.js youtube       # Save YouTube/Google session
 *   node save-session.js instagram     # Save Instagram session
 *   node save-session.js <platform>    # Save session for any platform
 *
 * The script opens a headed browser. Log in manually. Once login is
 * detected (or you press Ctrl+C after logging in), cookies are saved.
 *
 * Requires: npx playwright (auto-installed on first run)
 */

const { execSync, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const SESSIONS_DIR = path.join(os.homedir(), '.iris', 'sessions')
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true })

const PLATFORMS = {
  youtube: {
    url: 'https://www.youtube.com',
    label: 'YouTube / Google',
    loginCheck: async (page) => {
      const avatar = await page.locator('button#avatar-btn, img.yt-spec-avatar-shape__avatar').first().isVisible().catch(() => false)
      const guide = await page.locator('ytd-mini-guide-renderer, ytd-guide-renderer').first().isVisible().catch(() => false)
      const signInGone = !(await page.locator('a[href*="accounts.google.com/ServiceLogin"], ytd-button-renderer a[aria-label="Sign in"]').first().isVisible().catch(() => false))
      return avatar || (guide && signInGone)
    }
  },
  instagram: {
    url: 'https://www.instagram.com',
    label: 'Instagram',
    loginCheck: async (page) => {
      const avatar = await page.locator('img[data-testid="user-avatar"], span[role="img"][data-testid]').first().isVisible().catch(() => false)
      const loginGone = !(await page.locator('input[name="username"]').first().isVisible().catch(() => false))
      return avatar || loginGone
    }
  },
  twitter: {
    url: 'https://x.com',
    label: 'Twitter / X',
    loginCheck: async (page) => {
      const nav = await page.locator('nav[aria-label="Primary"], a[data-testid="AppTabBar_Home_Link"]').first().isVisible().catch(() => false)
      return nav
    }
  },
  linkedin: {
    url: 'https://www.linkedin.com',
    label: 'LinkedIn',
    loginCheck: async (page) => {
      const feed = await page.locator('.feed-shared-update-v2, .scaffold-layout__main').first().isVisible().catch(() => false)
      return feed
    }
  }
}

async function saveSession (platform) {
  const config = PLATFORMS[platform]
  if (!config) {
    // Generic fallback — just open the URL and let user tell us when done
    console.log(`\n  Unknown platform "${platform}" — using generic mode.`)
    console.log('  Session will be saved when you close the browser.\n')
  }

  const label = config?.label || platform
  const url = config?.url || `https://www.${platform}.com`
  const sessionFile = path.join(SESSIONS_DIR, `${platform}.json`)

  console.log('')
  console.log('  ┌──────────────────────────────────────────────┐')
  console.log(`  │  IRIS Hive — Save ${label} Session`.padEnd(49) + '│')
  console.log('  ├──────────────────────────────────────────────┤')
  console.log(`  │  Output: ~/.iris/sessions/${platform}.json`.padEnd(49) + '│')
  console.log('  └──────────────────────────────────────────────┘')
  console.log('')

  // Find Playwright — check known locations before installing
  let playwrightPath = null
  const searchPaths = [
    path.join(__dirname, '..', 'node_modules', 'playwright'),
    // Freelabel project (if FREELABEL_PATH is set)
    process.env.FREELABEL_PATH && path.join(process.env.FREELABEL_PATH, 'node_modules', 'playwright'),
    // Common dev locations
    path.join(os.homedir(), 'sites', 'freelabel', 'node_modules', 'playwright'),
    path.join(os.homedir(), 'Sites', 'freelabel', 'node_modules', 'playwright')
  ].filter(Boolean)

  for (const p of searchPaths) {
    try {
      if (fs.existsSync(p)) { playwrightPath = p; break }
    } catch { /* skip */ }
  }

  if (!playwrightPath) {
    console.log('  Playwright not found. Installing...')
    execSync('npm install playwright', { cwd: path.join(__dirname, '..'), stdio: 'inherit' })
    playwrightPath = path.join(__dirname, '..', 'node_modules', 'playwright')
  }

  const { chromium } = require(playwrightPath)

  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized']
  })

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  })

  const page = await context.newPage()

  // Handle cookie consent
  await page.goto(url)
  await page.waitForTimeout(3000)

  const consentBtn = page.locator('button:has-text("Accept all"), button:has-text("Accept"), button:has-text("I agree")').first()
  if (await consentBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await consentBtn.click()
    await page.waitForTimeout(1000)
  }

  console.log(`  Please sign into ${label} in the browser window.`)
  console.log('  Handle any 2FA prompts if they appear.')
  console.log('  Login will be auto-detected, or close the browser when done.\n')

  // Poll for login (10 min timeout)
  let loggedIn = false
  const loginCheck = config?.loginCheck

  if (loginCheck) {
    for (let i = 0; i < 600; i++) {
      // Check if browser was closed
      if (!browser.isConnected()) break

      try {
        loggedIn = await loginCheck(page)
        if (loggedIn) break
      } catch {
        // Page might be navigating
      }

      if (i % 15 === 0 && i > 0) {
        console.log(`  Waiting for login... (${i}s)`)
      }
      await page.waitForTimeout(1000)
    }
  } else {
    // Generic: wait for browser close
    await new Promise(resolve => {
      browser.on('disconnected', resolve)
    })
  }

  if (browser.isConnected()) {
    if (!loggedIn && loginCheck) {
      console.log('  Login not detected after 10 minutes.')
      console.log('  Saving session anyway (cookies may still be valid).\n')
    } else if (loggedIn) {
      console.log('  Login detected!\n')
    }

    // Wait for cookies to settle
    await page.waitForTimeout(2000)

    // Save storageState
    await context.storageState({ path: sessionFile })
    await browser.close()
  } else {
    // Browser closed — save what we captured
    // Can't call storageState after close, so this path means we lost the session
    console.log('  Browser closed before session could be saved.')
    console.log('  Please try again and wait for login detection.\n')
    process.exit(1)
  }

  // Verify file
  if (fs.existsSync(sessionFile)) {
    const data = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'))
    const cookieCount = data.cookies?.length || 0
    console.log(`  Session saved! (${cookieCount} cookies)`)
    console.log(`  Location: ${sessionFile}`)
    console.log(`\n  Your Hive node can now run ${label} automation tasks.\n`)
  } else {
    console.log('  Failed to save session file.\n')
    process.exit(1)
  }
}

// ── CLI ─────────────────────────────────────────────────────────
const platform = process.argv[2]?.toLowerCase()

if (!platform || platform === '--help' || platform === '-h') {
  console.log('')
  console.log('  Usage: iris hive session save <platform>')
  console.log('')
  console.log('  Supported platforms:')
  for (const [key, val] of Object.entries(PLATFORMS)) {
    console.log(`    ${key.padEnd(15)} ${val.label}`)
  }
  console.log(`    <other>        Generic (any website)`)
  console.log('')
  console.log('  Sessions are saved to: ~/.iris/sessions/<platform>.json')
  console.log('  The Hive daemon uses them for browser automation tasks.\n')
  process.exit(0)
}

if (platform === 'list' || platform === 'ls') {
  console.log('\n  Saved sessions:')
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))
  if (files.length === 0) {
    console.log('    (none)\n')
  } else {
    for (const f of files) {
      const name = f.replace('.json', '')
      const stat = fs.statSync(path.join(SESSIONS_DIR, f))
      const age = Math.round((Date.now() - stat.mtimeMs) / 86400000)
      const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'))
      const cookies = data.cookies?.length || 0
      console.log(`    ${name.padEnd(15)} ${cookies} cookies  (${age}d ago)`)
    }
    console.log('')
  }
  process.exit(0)
}

saveSession(platform).catch(err => {
  console.error(`  Error: ${err.message}`)
  process.exit(1)
})
