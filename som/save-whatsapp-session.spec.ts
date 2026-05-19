import { test, chromium } from '@playwright/test';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

/**
 * Save WhatsApp Web Session — persistent browser profile
 *
 * WhatsApp stores session in IndexedDB (not cookies), so Playwright's
 * context.storageState() won't capture it. We use chromium.launchPersistentContext()
 * which persists ALL browser storage to a directory on disk.
 *
 * Run once (headed): scan QR code with your phone.
 * Session persists ~14 days until phone disconnects.
 *
 * Usage:
 *   WA_ACCOUNT=default npx playwright test som/save-whatsapp-session.spec.ts --headed
 */

const WA_ACCOUNT = process.env.WA_ACCOUNT || 'default';
const SESSION_DIR = process.env.BROWSER_SESSION_FILE
  || process.env.WA_SESSION_DIR
  || path.join(os.homedir(), '.iris', 'whatsapp-sessions', WA_ACCOUNT);

test(`Save WhatsApp Session — ${WA_ACCOUNT}`, async () => {
  test.setTimeout(360000); // 6 minutes for QR scan
  // Ensure session directory exists
  fs.mkdirSync(SESSION_DIR, { recursive: true });

  console.log(`Session directory: ${SESSION_DIR}`);
  console.log(`Opening WhatsApp Web...`);
  console.log(`Scan QR code with your phone (you have up to 5 minutes).`);

  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: false,
    viewport: { width: 1280, height: 720 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://web.whatsapp.com/', { timeout: 30000, waitUntil: 'domcontentloaded' });

  // Poll for chat list to appear (indicates successful login)
  const maxWaitMs = 5 * 60 * 1000; // 5 minutes
  const pollIntervalMs = 3000;
  const startTime = Date.now();
  let loggedIn = false;

  while (Date.now() - startTime < maxWaitMs) {
    // Check for chat list (logged in)
    const hasChatList = await page.locator('div[aria-label="Chat list"][role="grid"]')
      .isVisible({ timeout: 2000 }).catch(() => false);

    if (hasChatList) {
      loggedIn = true;
      break;
    }

    // Also check for search bar (alternative login indicator)
    const hasSearch = await page.locator('div[contenteditable="true"][data-tab="3"]')
      .isVisible({ timeout: 1000 }).catch(() => false);

    if (hasSearch) {
      loggedIn = true;
      break;
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`  Waiting for login... (${elapsed}s)`);
    await page.waitForTimeout(pollIntervalMs);
  }

  if (loggedIn) {
    console.log(`\nSession saved successfully!`);
    console.log(`  Account: ${WA_ACCOUNT}`);
    console.log(`  Directory: ${SESSION_DIR}`);
    console.log(`\nSession persists on disk. Next run will skip QR scan.`);
  } else {
    console.log(`\nTimeout: QR code was not scanned within 5 minutes.`);
    console.log(`Re-run to try again.`);
  }

  await context.close();
});
