import { Page, BrowserContext } from '@playwright/test';
import {
  DmTarget,
  DmResult,
  DmBatchResult,
  DmProviderOptions,
  DmProviderInterface,
} from './dm-provider-types';

export type { DmTarget, DmResult, DmBatchResult, DmProviderOptions };

export class LinkedInDmProvider implements DmProviderInterface {
  readonly platform = 'linkedin';
  private dryRun: boolean;
  private delayBetweenDms: number;
  private cooldownAfter: number;
  private cooldownDuration: number;

  constructor(options?: {
    dryRun?: boolean;
    delayBetweenDms?: number;
    cooldownAfter?: number;
    cooldownDuration?: number;
  }) {
    this.dryRun = options?.dryRun ?? false;
    this.delayBetweenDms = options?.delayBetweenDms ?? 4000;
    this.cooldownAfter = options?.cooldownAfter ?? 10;
    this.cooldownDuration = options?.cooldownDuration ?? 30000;
  }

  async sendBatch(
    page: Page,
    context: BrowserContext,
    targets: DmTarget[]
  ): Promise<DmBatchResult> {
    const results: DmResult[] = [];
    const batchStart = Date.now();
    let consecutiveSent = 0;

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const dmStart = Date.now();

      console.log(`\n  [${i + 1}/${targets.length}] ${target.name}`);
      console.log(`    URL: ${target.profileUrl}`);

      if (consecutiveSent > 0 && consecutiveSent % this.cooldownAfter === 0) {
        console.log(`    Cooldown: pausing ${this.cooldownDuration / 1000}s after ${consecutiveSent} DMs...`);
        await page.waitForTimeout(this.cooldownDuration);
      }

      try {
        const result = await this.sendSingleDm(page, context, target);
        results.push({ ...result, durationMs: Date.now() - dmStart });
        if (result.status === 'sent' || result.status === 'dry_run') {
          consecutiveSent++;
        }
      } catch (err: any) {
        console.log(`    ERROR: ${err.message}`);
        results.push({
          name: target.name,
          profileUrl: target.profileUrl,
          status: 'failed',
          error: err.message,
          durationMs: Date.now() - dmStart,
        });
      }

      if (i < targets.length - 1) {
        const jitter = Math.random() * 2000;
        await page.waitForTimeout(this.delayBetweenDms + jitter);
      }
    }

    const sent = results.filter(r => r.status === 'sent').length;
    const failed = results.filter(r => r.status === 'failed').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const dryRun = results.filter(r => r.status === 'dry_run').length;

    return { results, sent, failed, skipped, dryRun, totalDurationMs: Date.now() - batchStart };
  }

  private async sendSingleDm(
    page: Page,
    context: BrowserContext,
    target: DmTarget
  ): Promise<Omit<DmResult, 'durationMs'>> {
    if (!target.profileUrl || !target.profileUrl.includes('linkedin.com')) {
      console.log('    SKIP: No valid LinkedIn profile URL');
      return { name: target.name, profileUrl: target.profileUrl, status: 'skipped', error: 'No valid LinkedIn URL' };
    }

    await page.goto(target.profileUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000 + Math.random() * 2000);
    await this.dismissPopups(page);

    const notFound = await page.locator('text=Page not found').isVisible({ timeout: 2000 }).catch(() => false);
    if (notFound) {
      console.log('    SKIP: Profile not found');
      return { name: target.name, profileUrl: target.profileUrl, status: 'skipped', error: 'Profile not found' };
    }

    let messageOverlayOpen = false;
    const messageSelectors = [
      'button:has-text("Message")',
      'a:has-text("Message")',
      'button.pvs-profile-actions__action:has-text("Message")',
      '[data-control-name="message"]',
    ];

    for (const sel of messageSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(3000);
        messageOverlayOpen = true;
        break;
      }
    }

    if (!messageOverlayOpen) {
      const moreBtn = page.locator('button:has-text("More"), button[aria-label="More actions"]').first();
      if (await moreBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await moreBtn.click();
        await page.waitForTimeout(1500);
        const msgOption = page.locator('[role="menuitem"]:has-text("Message"), button:has-text("Message")').first();
        if (await msgOption.isVisible({ timeout: 3000 }).catch(() => false)) {
          await msgOption.click();
          await page.waitForTimeout(3000);
          messageOverlayOpen = true;
        } else {
          await page.keyboard.press('Escape');
        }
      }
    }

    if (!messageOverlayOpen) {
      console.log('    SKIP: No Message button found (may need to connect first)');
      return { name: target.name, profileUrl: target.profileUrl, status: 'skipped', error: 'No Message button' };
    }

    await this.dismissPopups(page);

    const inputSelectors = [
      'div.msg-form__contenteditable[contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
      'div.msg-form__msg-content-container div[contenteditable="true"]',
      'p.msg-form__placeholder',
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
      await page.keyboard.press('Escape');
      return { name: target.name, profileUrl: target.profileUrl, status: 'failed', error: 'No message input found' };
    }

    await inputEl.click();
    await page.waitForTimeout(500);
    try { await inputEl.fill(target.message); } catch { await page.keyboard.type(target.message, { delay: 20 }); }
    await page.waitForTimeout(1000);

    if (this.dryRun) {
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Backspace');
      await page.keyboard.press('Escape');
      return { name: target.name, profileUrl: target.profileUrl, status: 'dry_run' };
    }

    const sendSelectors = [
      'button.msg-form__send-button',
      'button[type="submit"]:has-text("Send")',
      'button:has-text("Send"):not([disabled])',
    ];

    let sent = false;
    for (const sel of sendSelectors) {
      const sendBtn = page.locator(sel).first();
      if (await sendBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await sendBtn.click();
        sent = true;
        break;
      }
    }
    if (!sent) { await page.keyboard.press('Enter'); }

    await page.waitForTimeout(2000);
    console.log('    SENT');
    return { name: target.name, profileUrl: target.profileUrl, status: 'sent' };
  }

  private async dismissPopups(page: Page): Promise<void> {
    for (const text of ['Dismiss', 'Not now', 'No thanks', 'Skip', 'Got it', 'Maybe later']) {
      const btn = page.locator(`button:has-text("${text}")`).first();
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(500);
      }
    }
  }
}
