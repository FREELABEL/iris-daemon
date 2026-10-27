/**
 * Standalone reply capture — read every DM thread, write replies to the CRM, send nothing.
 *
 * Why this exists (#191269): reply capture used to run only as a PRE-FLIGHT inside a DM send
 * batch, against the newest 20 threads. Pausing campaigns therefore silenced reply capture
 * entirely, and on a busy day anything past thread 20 was never seen.
 *
 * This job is independent of sending. It runs on its own schedule, over every configured
 * account, and reads as far back as the provider can scroll.
 *
 * Config — either:
 *   CAPTURE_ACCOUNTS="heyiris.io:38,freelabelnet:24,thediscoverpage_:28"
 * or the single-account fallback:
 *   IG_ACCOUNT=heyiris.io BOARD_ID=38
 *
 * Optional:
 *   CAPTURE_LIMIT=500        max conversations per account (default 500)
 *   CAPTURE_SCROLLS=60       scroll attempts per account (default 60)
 *   DRY_RUN=1                match and report, write nothing
 *   BROWSER_SESSION_FILE     override the session file for the single-account fallback
 *
 * Example:
 *   npx playwright test capture-replies.spec.ts
 */
import { test, Browser, BrowserContext } from '@playwright/test';
import { InstagramInboxProvider } from './helpers/providers/instagram-inbox-provider';
import {
  fetchBoardLeads, runInboxScan, printSummary, sendResultAlert,
  persistUnmatchedReplies, sendDiscordAlert, Lead, ScanConfig,
} from './helpers/inbox-scanner';
import * as fs from 'fs';
import * as path from 'path';

const TOKEN = process.env.HEYIRIS_TOKEN;
if (!TOKEN) throw new Error('HEYIRIS_TOKEN env var required. Set in ~/.iris/bridge/.env or export it.');

const API_BASE = process.env.IRIS_FL_API_URL || 'https://raichu.heyiris.io';
const CAPTURE_LIMIT = parseInt(process.env.CAPTURE_LIMIT || '500', 10);
const CAPTURE_SCROLLS = parseInt(process.env.CAPTURE_SCROLLS || '60', 10);
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const DISCORD_WEBHOOK = process.env.PLATFORM_UPDATES_DISCORD_CHANNEL_WEBHOOK_URL || '';

interface CaptureAccount { account: string; boardId: number }

function accounts(): CaptureAccount[] {
  const raw = (process.env.CAPTURE_ACCOUNTS || '').trim();
  if (raw) {
    return raw.split(',')
      .map(pair => pair.trim())
      .filter(Boolean)
      .map(pair => {
        const [account, board] = pair.split(':');
        const boardId = parseInt(board, 10);
        if (!account || !Number.isFinite(boardId)) {
          throw new Error(`CAPTURE_ACCOUNTS entry "${pair}" is not account:boardId`);
        }
        return { account: account.replace(/^@/, ''), boardId };
      });
  }

  return [{
    account: process.env.IG_ACCOUNT || 'heyiris.io',
    boardId: parseInt(process.env.BOARD_ID || '38', 10),
  }];
}

/** Session files live next to this spec, or at the repo root on legacy installs. */
function sessionFile(account: string): string | null {
  const candidates = [
    process.env.BROWSER_SESSION_FILE,
    path.join(__dirname, `instagram-auth-${account}.json`),
    path.join(__dirname, '../../..', `instagram-auth-${account}.json`),
    path.join(__dirname, 'instagram-auth.json'),
  ].filter(Boolean) as string[];

  return candidates.find(p => fs.existsSync(p)) || null;
}

async function captureAccount(
  browser: Browser,
  { account, boardId }: CaptureAccount,
): Promise<void> {
  const label = `@${account} / Board ${boardId}`;
  console.log(`\n${'='.repeat(60)}\n  CAPTURE ${label}\n${'='.repeat(60)}`);

  const file = sessionFile(account);
  if (!file) {
    console.log(`  SKIP: no Instagram session file for @${account}`);
    await sendDiscordAlert(DISCORD_WEBHOOK, `**IG Reply Capture — no session** @${account} (board ${boardId})`);
    return;
  }

  const state = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (!state.cookies || state.cookies.length === 0) {
    console.log(`  SKIP: session file has no cookies (${file})`);
    return;
  }

  let context: BrowserContext | null = null;
  try {
    context = await browser.newContext();
    await context.addCookies(state.cookies);
    const page = await context.newPage();

    // ── Session preflight: never scan a logged-out shell and report "0 replies" ──
    await page.goto('https://www.instagram.com/', { timeout: 20000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const onLogin = page.url().includes('/accounts/login') || page.url().includes('/challenge/');
    const hasLoginForm = await page.locator('input[name="username"]').first()
      .isVisible({ timeout: 2000 }).catch(() => false);
    if (onLogin || hasLoginForm) {
      console.log(`  SESSION EXPIRED: @${account} — re-save the session`);
      await sendDiscordAlert(DISCORD_WEBHOOK, `**IG Reply Capture — session expired** @${account} (board ${boardId})`);
      return;
    }

    const boardLeads = await fetchBoardLeads<Lead>(API_BASE, TOKEN, boardId, (l) => ({
      id: l.id,
      name: (l.name || l.full_name || l.nickname || '').trim(),
      // Identity is the stored handle, never the display name (#191271)
      igHandle: (l.contact_info?.instagram || l.nickname || l.ig_handle || '')
        .replace(/^@/, '').trim(),
      phone: l.contact_info?.phone || l.phone || '',
    }));
    console.log(`  Loaded ${boardLeads.length} leads from board ${boardId}`);
    if (boardLeads.length === 0) {
      console.log(`  SKIP: board ${boardId} has no leads to match against`);
      return;
    }

    const provider = new InstagramInboxProvider();
    const inbox = await provider.discover(page, context, {
      targetUrl: 'https://www.instagram.com/direct/inbox/',
      limit: CAPTURE_LIMIT,
      scrollAttempts: CAPTURE_SCROLLS,
      scrollDelay: 2500,
    });
    console.log(`  Read ${inbox.profiles.length} conversations`);
    if (inbox.errors.length > 0) console.log(`  Provider errors: ${inbox.errors.join(', ')}`);

    const config: ScanConfig = {
      platform: 'instagram',
      account,
      boardId,
      apiBase: API_BASE,
      token: TOKEN,
      dryRun: DRY_RUN,
      ourName: '',
      discordWebhook: DISCORD_WEBHOOK,
    };

    const result = await runInboxScan(config, inbox.profiles, boardLeads, { autoDetectOurName: true });
    printSummary(config, result);

    // Non-lead replies become leads on this board instead of being dropped (#191270)
    await persistUnmatchedReplies(config, result);
    await sendResultAlert(config, result);
  } catch (err: any) {
    console.log(`  CAPTURE FAILED for ${label}: ${err.message}`);
    await sendDiscordAlert(DISCORD_WEBHOOK, `**IG Reply Capture — failed** ${label}\n${err.message}`);
  } finally {
    await context?.close().catch(() => {});
  }
}

test('Capture Instagram replies — every account, read-only', async ({ browser }) => {
  const list = accounts();
  // Reading hundreds of threads is slow by design — do not let the 10-minute default
  // kill a legitimate scan and turn it into a silent "0 replies".
  test.setTimeout(Math.max(600_000, list.length * 1_800_000));
  console.log(`Capturing replies for ${list.length} account(s), limit ${CAPTURE_LIMIT} threads each`);

  for (const entry of list) {
    await captureAccount(browser, entry);
  }
});
