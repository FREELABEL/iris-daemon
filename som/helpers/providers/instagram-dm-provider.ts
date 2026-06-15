import { Page } from '@playwright/test';
import { dismissInstagramPopups } from './base-provider';

export interface IgDmResult {
  handle: string;
  status: 'sent' | 'failed' | 'dry';
  delivered: boolean;
  error?: string;
}

/**
 * Instagram DM sender — extracted from som/batch-with-login.spec.ts (the proven
 * outreach send path) so the inbox follow-up responder can reuse the exact same
 * navigate → compose → send → delivery-confirm flow.
 *
 * Single-target by handle: opens the lead's profile, gets into the DM view via
 * one of three paths (already-in-DM / "Message" button / Options → "Send
 * message", following first if required), types the message, sends, and confirms
 * the message actually appears in the thread before reporting success.
 */
export class InstagramDmProvider {
  readonly platform = 'instagram';

  /**
   * Send a single DM to an Instagram handle on the currently logged-in session.
   * The `page` must belong to a context already authenticated as the sending
   * account (same cookie/storageState pattern as the outreach + inbox specs).
   *
   * @returns status + whether delivery was confirmed in the chat. In dryRun mode
   *          it navigates + types but clears the input and never sends.
   */
  async sendToHandle(
    page: Page,
    igHandle: string,
    message: string,
    opts: { dryRun?: boolean } = {}
  ): Promise<IgDmResult> {
    const handle = igHandle.replace(/^@/, '').trim();
    const dryRun = opts.dryRun ?? false;

    if (!handle) {
      return { handle, status: 'failed', delivered: false, error: 'empty handle' };
    }
    if (!message || !message.trim()) {
      return { handle, status: 'failed', delivered: false, error: 'empty message' };
    }

    // ── Navigate to the profile ──
    const profileUrl = `https://www.instagram.com/${handle}/`;
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);

    const url = page.url();
    if (url.includes('/accounts/login') || url.includes('/challenge/')) {
      return { handle, status: 'failed', delivered: false, error: 'session expired' };
    }

    await dismissInstagramPopups(page);

    const notFound = await page.locator('text=Sorry, this page').isVisible({ timeout: 1500 }).catch(() => false);
    if (notFound) {
      return { handle, status: 'failed', delivered: false, error: 'account not found' };
    }

    // ── Get into DM view (Paths A / B / C — mirrors batch-with-login.spec.ts) ──
    const dmInputSelector =
      'div[aria-label*="Message"][contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea[placeholder*="Message"], p[data-lexical-text], p[placeholder*="Message"]';
    let inDMView = false;

    // PATH A: already in a DM view
    const earlyDmInput = page.locator(dmInputSelector).first();
    if (page.url().includes('/direct/') || await earlyDmInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      inDMView = true;
    }

    // PATH B: profile "Message" button
    if (!inDMView) {
      const messageBtn = page
        .locator('button:text-is("Message"), div[role="button"]:text-is("Message"), a:text-is("Message"), header button:has-text("Message")')
        .first();
      if (await messageBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await messageBtn.click();
        await page.waitForTimeout(3000);
        await dismissInstagramPopups(page);
        const check = page.locator(dmInputSelector).first();
        if (page.url().includes('/direct/') || await check.isVisible({ timeout: 3000 }).catch(() => false)) {
          inDMView = true;
        }
      }
    }

    // PATH C: Options menu → "Send message" (accounts we don't follow), follow first if needed
    if (!inDMView) {
      const dotsClicked = await (async () => {
        for (const label of ['Options', 'More options']) {
          const svg = page.locator(`svg[aria-label="${label}"]`).first();
          if (await svg.isVisible({ timeout: 2000 }).catch(() => false)) {
            await svg.click();
            return true;
          }
        }
        const dotsBtn = page.locator('div[role="button"]:has(svg circle)').first();
        if (await dotsBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await dotsBtn.click();
          return true;
        }
        return false;
      })();

      if (dotsClicked) {
        await page.waitForTimeout(1000);
        const sendMsg = page.locator('text=Send message').first();
        if (await sendMsg.isVisible({ timeout: 3000 }).catch(() => false)) {
          await sendMsg.click();
          await page.waitForTimeout(2000);
          inDMView = true;
        } else {
          // Try following first, then retry
          await page.locator('text=Cancel').first().click().catch(() => {});
          await page.waitForTimeout(500);
          const followBtn = page.locator('button:text-is("Follow")').first();
          if (await followBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await followBtn.click();
            await page.waitForTimeout(2000);
            for (const label of ['Options', 'More options']) {
              const svg = page.locator(`svg[aria-label="${label}"]`).first();
              if (await svg.isVisible({ timeout: 2000 }).catch(() => false)) {
                await svg.click();
                await page.waitForTimeout(1000);
                const retrySend = page.locator('text=Send message').first();
                if (await retrySend.isVisible({ timeout: 3000 }).catch(() => false)) {
                  await retrySend.click();
                  await page.waitForTimeout(2000);
                  inDMView = true;
                }
                break;
              }
            }
          }
          if (!inDMView) {
            const lastResort = page.locator(dmInputSelector).first();
            if (await lastResort.isVisible({ timeout: 2000 }).catch(() => false)) {
              inDMView = true;
            }
          }
        }
      }
    }

    if (!inDMView) {
      return { handle, status: 'failed', delivered: false, error: 'could not open DM view (private/DM-restricted?)' };
    }

    // ── Type & send ──
    await page.waitForTimeout(800);

    // Dismiss the "Turn on Notifications" overlay that blocks the composer
    for (let attempt = 0; attempt < 3; attempt++) {
      const notNow = page.locator('button:has-text("Not Now"), button:has-text("Not now"), button:has-text("Cancel")').first();
      if (await notNow.isVisible({ timeout: 2000 }).catch(() => false)) {
        await notNow.click();
        await page.waitForTimeout(1000);
      } else {
        const dialog = page.locator('[role="dialog"]').first();
        if (await dialog.isVisible({ timeout: 500 }).catch(() => false)) {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(500);
        } else {
          break;
        }
      }
    }
    await dismissInstagramPopups(page);

    const dmInput = page.locator(dmInputSelector).first();
    if (!await dmInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      return { handle, status: 'failed', delivered: false, error: 'no DM input found' };
    }

    await dmInput.click();
    await dmInput.fill(message).catch(async () => {
      await page.keyboard.type(message, { delay: 15 });
    });
    await page.waitForTimeout(1000);

    if (dryRun) {
      // Clear the composer so nothing lingers, and report without sending.
      await page.keyboard.press('Control+a').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      return { handle, status: 'dry', delivered: false };
    }

    const sendBtn = page.locator('button:has-text("Send"):not([disabled])').first();
    if (await sendBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await sendBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    // ── Delivery confirmation: verify the message appeared in the thread ──
    await page.waitForTimeout(2000);
    const snippet = message.substring(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const delivered = await page
      .locator(`div[dir="auto"]:text-matches("${snippet}", "i")`)
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    return {
      handle,
      status: delivered ? 'sent' : 'failed',
      delivered,
      error: delivered ? undefined : 'message typed but not confirmed in chat',
    };
  }
}
