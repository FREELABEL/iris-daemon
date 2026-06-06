import { test } from '@playwright/test';
import { dismissInstagramPopups } from './helpers/providers/base-provider';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Instagram Follow-Up — Send a single DM reply to a specific handle.
 *
 * Env vars:
 *   TARGET_HANDLE   — IG username to DM (required)
 *   MESSAGE         — Message text to send (required)
 *   IG_ACCOUNT      — Which IG account to send from (default: heyiris.io)
 *   DRY_RUN         — If "1", type message but don't hit send
 *   BROWSER_SESSION_FILE — Path to session JSON
 */

const TARGET_HANDLE = process.env.TARGET_HANDLE || '';
const MESSAGE = process.env.MESSAGE || '';
const IG_ACCOUNT = process.env.IG_ACCOUNT || 'heyiris.io';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const MANUAL_MODE = process.env.MANUAL_MODE === '1';

const IG_AUTH_FILE = process.env.BROWSER_SESSION_FILE
  || path.join(__dirname, `instagram-auth-${IG_ACCOUNT}.json`);

test(`Instagram Follow-Up DM — @${TARGET_HANDLE}`, async ({ page, context }) => {
  if (!TARGET_HANDLE) {
    console.log('ERROR: TARGET_HANDLE env var required');
    return;
  }

  // ── Load session ──
  if (!fs.existsSync(IG_AUTH_FILE)) {
    console.log(`No session file: ${IG_AUTH_FILE}`);
    return;
  }
  const state = JSON.parse(fs.readFileSync(IG_AUTH_FILE, 'utf-8'));
  if (state.cookies?.length > 0) {
    await context.addCookies(state.cookies);
    console.log(`Session loaded for @${IG_ACCOUNT}`);
  } else {
    console.log('Session file has no cookies.');
    return;
  }

  // ── Navigate to DM thread ──
  // IG direct message URL format: /direct/t/{user_id} requires numeric ID
  // Instead: go to inbox and search for the handle
  console.log(`\nOpening DM thread with @${TARGET_HANDLE}...`);
  await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await dismissInstagramPopups(page);
  await page.waitForTimeout(1000);

  // Dismiss notification prompt
  for (const text of ['Not Now', 'Not now', 'Cancel']) {
    const btn = page.locator(`button:has-text("${text}")`).first();
    if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(500);
    }
  }

  let threadOpen = false;

  // Strategy 1: Go directly to the user's profile and click Message
  // This is the most reliable approach — avoids compose modal overlay issues
  console.log(`  Navigating to @${TARGET_HANDLE} profile...`);
  await page.goto(`https://www.instagram.com/${TARGET_HANDLE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await dismissInstagramPopups(page);

  const msgBtn = page.locator('div[role="button"]:has-text("Message"), button:has-text("Message")').first();
  if (await msgBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await msgBtn.click();
    await page.waitForTimeout(3000);
    threadOpen = true;
    console.log('  Opened DM via profile Message button');
  }

  // Strategy 2: Use the compose flow (New message → search → select)
  if (!threadOpen) {
    console.log('  Profile Message button not found, trying compose flow...');
    await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await dismissInstagramPopups(page);

    // Click compose/new message icon
    const composeBtn = page.locator('svg[aria-label="New message"], [aria-label="New message"]').first();
    if (await composeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await composeBtn.click();
      await page.waitForTimeout(2000);
    }

    // The compose modal has a search input — use keyboard to focus it
    // IG's overlay intercepts pointer events, so use Tab/keyboard navigation
    await page.keyboard.press('Tab');
    await page.waitForTimeout(500);
    await page.keyboard.type(TARGET_HANDLE, { delay: 30 });
    await page.waitForTimeout(3000);

    // Click the matching result (should appear below the search)
    const result = page.getByText(TARGET_HANDLE, { exact: false }).first();
    if (await result.isVisible({ timeout: 3000 }).catch(() => false)) {
      await result.click();
      await page.waitForTimeout(1000);

      // Click "Chat" or "Next"
      const nextBtn = page.locator('div[role="button"]:has-text("Chat"), div[role="button"]:has-text("Next")').first();
      if (await nextBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await nextBtn.click();
        await page.waitForTimeout(2000);
      }
      threadOpen = true;
    }
  }

  if (!threadOpen) {
    console.log(`  Could not open DM thread with @${TARGET_HANDLE}`);
    await page.screenshot({ path: `test-results/follow-up-fail-${Date.now()}.png` }).catch(() => {});
    return;
  }

  console.log(`  DM thread open with @${TARGET_HANDLE}`);

  // ── Manual mode: just keep the browser open ──
  if (MANUAL_MODE) {
    console.log('\n  ═══════════════════════════════════════════════');
    console.log('  MANUAL MODE — Browser is open. Type your reply.');
    console.log('  Close the browser window when done.');
    console.log('  ═══════════════════════════════════════════════\n');
    // Keep browser open until user closes it (Playwright will wait for test timeout)
    await page.waitForTimeout(600000); // 10 minutes max
    return;
  }

  // ── AI/auto mode: type and send the message ──
  if (!MESSAGE) {
    console.log('  ERROR: MESSAGE env var required for auto mode');
    return;
  }

  // Find the message input
  const inputSelectors = [
    'div[role="textbox"][contenteditable="true"]',
    'textarea[placeholder*="Message"]',
    'div[aria-label*="Message"][contenteditable="true"]',
    'p[data-lexical-text]',
  ];

  let inputEl = null;
  for (const sel of inputSelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
      inputEl = el;
      break;
    }
  }

  if (!inputEl) {
    console.log('  Could not find message input');
    await page.screenshot({ path: `test-results/follow-up-no-input-${Date.now()}.png` }).catch(() => {});
    return;
  }

  // Type the message
  await inputEl.click();
  await page.waitForTimeout(500);
  await page.keyboard.type(MESSAGE, { delay: 15 });
  await page.waitForTimeout(1000);

  const preview = MESSAGE.substring(0, 80);
  console.log(`  Message: "${preview}${MESSAGE.length > 80 ? '...' : ''}"`);

  if (DRY_RUN) {
    console.log('  [DRY RUN] Message typed but NOT sent');
    await page.screenshot({ path: `test-results/follow-up-dry-${TARGET_HANDLE}-${Date.now()}.png` }).catch(() => {});
    // Clear and close
    await page.keyboard.press('Meta+a');
    await page.keyboard.press('Backspace');
    return;
  }

  // Send (press Enter — IG sends on Enter by default)
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);
  console.log(`  SENT to @${TARGET_HANDLE}`);
});
