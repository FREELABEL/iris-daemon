/**
 * Send person-approved Instagram replies, one per handle, then read each one back and record it.
 *
 *   APPROVED_FILE=approved.json IG_ACCOUNT=thediscoverpage_ BOARD_ID=80 [DRY_RUN=1] npx playwright test send-approved-replies
 *
 * approved.json: [{ "handle": "...", "leadId": 123, "message": "..." }]
 * Only sends what is in the file, which a person approved. DRY_RUN types and does not send.
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { LeadgenApiClient } from './helpers/leadgen-api-client';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { recordReply, replyCampaign } = require('./helpers/record-reply');

const IG_ACCOUNT = process.env.IG_ACCOUNT!;
const BOARD_ID = Number(process.env.BOARD_ID || 0);
const DRY = process.env.DRY_RUN === '1';
const items: { handle: string; leadId: number; message: string }[] = JSON.parse(fs.readFileSync(process.env.APPROVED_FILE!, 'utf8'));
const INPUT = 'div[aria-label*="Message"][contenteditable="true"], div[contenteditable="true"][role="textbox"]';

test.setTimeout(15 * 60 * 1000);

test(`send approved replies as @${IG_ACCOUNT}`, async ({ browser }) => {
  const context = await browser.newContext({ storageState: path.join(__dirname, `instagram-auth-${IG_ACCOUNT}.json`) });
  const page = await context.newPage();
  const api = new LeadgenApiClient(process.env.HEYIRIS_TOKEN!, BOARD_ID);
  const results: any[] = [];

  for (const it of items) {
    const r: any = { handle: it.handle, leadId: it.leadId };
    try {
      await page.goto(`https://www.instagram.com/${it.handle}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000);
      if (!page.url().includes(it.handle)) throw new Error(`landed on ${page.url()}`);
      // A deleted or deactivated account: skip it and keep going (2026-10-28, @zander_colin)
      if (await page.getByText(/Sorry, this page isn.t available/).count()) {
        r.status = 'SKIPPED: account no longer exists';
        console.log(`RESULT ${JSON.stringify(r)}`); results.push(r); continue;
      }
      const btn = page.locator('div[role="button"]:text-is("Message"), button:text-is("Message"), a:text-is("Message")').first();
      const input = page.locator(INPUT).first();
      if (await btn.isVisible({ timeout: 5000 }).catch(() => false)) await btn.click();
      else {
        // No Message button (private or follow-gated profile): open the existing thread via ig.me
        await page.goto(`https://ig.me/m/${it.handle}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(5000);
      }
      await input.waitFor({ timeout: 20000 });
      // Instagram popups ("Turn on Notifications", etc.) cover the composer
      for (let k = 0; k < 2; k++) {
        const notNow = page.locator('button:text-is("Not Now"), button:text-is("Not now")').first();
        if (await notNow.isVisible({ timeout: 2000 }).catch(() => false)) { await notNow.click(); await page.waitForTimeout(1000); }
      }
      r.via = page.url().includes('/direct/') ? 'thread' : 'profile';
      await page.waitForTimeout(1500);
      // The notifications popup can appear after the thread opens: close it right before typing
      for (let k = 0; k < 3; k++) {
        const nn = page.locator('button:text-is("Not Now"), button:text-is("Not now")').first();
        if (await nn.isVisible({ timeout: 1500 }).catch(() => false)) { await nn.click(); await page.waitForTimeout(800); } else break;
      }
      await input.click();
      const lines = it.message.split('\n');
      for (let i = 0; i < lines.length; i++) {
        await page.keyboard.type(lines[i], { delay: 12 });
        if (i < lines.length - 1) { await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift'); }
      }
      await page.waitForTimeout(800);
      await page.screenshot({ path: `test-results/reply-${it.handle}${DRY ? '-dry' : ''}.png` });
      if (DRY) { r.status = 'typed (dry run, not sent)'; await input.press('Control+A'); await page.keyboard.press('Backspace'); }
      else {
        await page.keyboard.press('Enter');
        await page.waitForTimeout(4000);
        // match on plain words: emoji and curly apostrophes made the check miss a real send (2026-10-28)
        const words = (it.message.match(/[A-Za-z]{3,}/g) || []);
        const snippet = words.slice(-4).join(' ');
        const seen = snippet ? await page.locator(`text=/${words.slice(-4).join('[^A-Za-z]+')}/`).count() : 0;
        const left = (await input.innerText().catch(() => '')).trim();
        if (left.length > 0) throw new Error(`still in the message box (${left.length} chars), not sent`);
        r.status = seen ? 'sent + seen in thread' : 'sent (composer cleared); confirm with the capture read-back';
        // A one-off reply, not a campaign step: logged as a reply, labelled by account (#191637).
        const { rec, recordedAs } = await recordReply(api, it.leadId, { message: it.message, channel_account: IG_ACCOUNT, campaign_name: replyCampaign(IG_ACCOUNT, process.env.CAMPAIGN_NAME), bloq_id: BOARD_ID, ig_handle: it.handle });
        r.recordedAs = recordedAs;
        r.recorded = rec.success;
        await page.waitForTimeout(20000 + Math.random() * 20000); // human pace between sends
      }
    } catch (e: any) { r.status = "FAILED: " + e.message.split("\n")[0]; await page.screenshot({ path: `test-results/reply-${it.handle}-fail.png` }).catch(() => {}); }
    console.log(`RESULT ${JSON.stringify(r)}`);
    results.push(r);
    // failures are reported and skipped; the capture read-back after the run is the proof
  }
  await context.close();
});
