// Playwright/Chromium provisioning for Hive nodes (#137525).
//
// Browser-driven discovery (Google Maps venue scrape, SOM, discover) needs the
// Playwright Chromium binary present on the node. When it's missing, a scrape
// script can print "please run npx playwright install" and STILL exit 0 —
// reporting 0 results as success. This module makes provisioning explicit and
// gives every caller ONE shared way to (a) install browsers, (b) check whether
// they're installed, and (c) recognize a browser-launch failure in task output.

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

// Signatures that mean "the browser never launched" — i.e. a scrape that returns
// 0 results because Chromium is missing/broken, NOT because there was nothing to
// find. Used to fail loudly even when the wrapping script exits 0.
const BROWSER_LAUNCH_FAILURE_RE =
  /please run\s+(npx\s+)?playwright install|Looks like Playwright (was just installed|is not installed)|Executable doesn't exist|browserType\.launch.*(Failed|Error)|Failed to launch.*chrom|spawn .*chrom.* ENOENT|playwright install/i

/** Resolve the pinned @playwright/test version from package.json (avoids node drift). */
function pinnedPlaywrightVersion () {
  try {
    const pkg = require(path.join(__dirname, '..', 'package.json'))
    return (pkg.dependencies?.['@playwright/test'] || pkg.devDependencies?.['@playwright/test'] || '').replace(/[\^~>=]/g, '')
  } catch {
    return ''
  }
}

/** The directory Playwright stores browser binaries in (honours PLAYWRIGHT_BROWSERS_PATH). */
function browsersCacheDir () {
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (override && override !== '0') return override
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
    : path.join(os.homedir(), '.cache', 'ms-playwright')
}

/** Non-mutating check: is a Chromium build present on this node? */
function chromiumInstalled () {
  try {
    const dir = browsersCacheDir()
    return fs.existsSync(dir) && fs.readdirSync(dir).some((d) => d.startsWith('chromium'))
  } catch {
    return false
  }
}

/**
 * Ensure Chromium is installed (idempotent — instant if already present).
 *
 * @param {{background?: boolean, timeoutMs?: number}} [opts]
 *   background: don't block — kick off the install and return immediately.
 * @returns {{installed: boolean, alreadyPresent: boolean, version: string, error?: string, pending?: boolean}}
 */
function ensureChromiumInstalled (opts = {}) {
  const version = pinnedPlaywrightVersion()
  if (chromiumInstalled()) {
    return { installed: true, alreadyPresent: true, version }
  }

  const cmd = version
    ? `npx @playwright/test@${version} install chromium`
    : 'npx playwright install chromium'

  if (opts.background) {
    // Fire-and-forget so daemon startup is never blocked on a ~100MB download.
    try {
      const { spawn } = require('child_process')
      const child = spawn('/bin/sh', ['-c', cmd], { stdio: 'ignore', detached: true })
      child.unref()
      return { installed: false, alreadyPresent: false, version, pending: true }
    } catch (e) {
      return { installed: false, alreadyPresent: false, version, error: e.message }
    }
  }

  try {
    execSync(cmd, { timeout: opts.timeoutMs || 180000, stdio: 'ignore' })
    return { installed: chromiumInstalled(), alreadyPresent: false, version }
  } catch (e) {
    return { installed: false, alreadyPresent: false, version, error: e.message }
  }
}

module.exports = {
  BROWSER_LAUNCH_FAILURE_RE,
  chromiumInstalled,
  ensureChromiumInstalled,
  browsersCacheDir,
  pinnedPlaywrightVersion,
}
