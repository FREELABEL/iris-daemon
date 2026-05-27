import { test } from '@playwright/test';
import { LinkedInInboxProvider } from './helpers/providers/linkedin-inbox-provider';
import {
  fetchBoardLeads, runInboxScan, syncInbox, printSummary, sendResultAlert,
  sendDiscordAlert, Lead, ScanConfig,
} from './helpers/inbox-scanner';
import * as fs from 'fs';
import * as path from 'path';

const TOKEN = process.env.HEYIRIS_TOKEN;
if (!TOKEN) throw new Error('HEYIRIS_TOKEN env var required. Set in ~/.iris/bridge/.env or export it.');
const BOARD_ID = parseInt(process.env.BOARD_ID || '302', 10);
const LIMIT = parseInt(process.env.LIMIT || '20', 10);
const LINKEDIN_USER_NAME = process.env.LINKEDIN_USER_NAME || '';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const LINKEDIN_AUTH_FILE = process.env.BROWSER_SESSION_FILE
  || path.join(__dirname, 'linkedin-auth.json');
const API_BASE = process.env.IRIS_FL_API_URL || 'https://raichu.heyiris.io';

const DISCORD_WEBHOOK = process.env.PLATFORM_UPDATES_DISCORD_CHANNEL_WEBHOOK_URL || '';

test(`LinkedIn Inbox Reply Check -- Board ${BOARD_ID}`, async ({ page, context }) => {
  // ── Load LinkedIn session ──
  if (!fs.existsSync(LINKEDIN_AUTH_FILE)) {
    console.log('No linkedin-auth.json found.');
    console.log('Run: iris hive credentials save-session --platform linkedin --bloq <id>');
    return;
  }
  const state = JSON.parse(fs.readFileSync(LINKEDIN_AUTH_FILE, 'utf-8'));
  if (!state.cookies || state.cookies.length === 0) {
    console.log('LinkedIn auth file has no cookies.');
    return;
  }
  await context.addCookies(state.cookies);
  console.log(`LinkedIn session loaded (${state.cookies.length} cookies)`);

  // ── Session preflight ──
  console.log('Validating LinkedIn session...');
  await page.goto('https://www.linkedin.com/feed/', { timeout: 15000, waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const feedUrl = page.url();
  if (feedUrl.includes('/login') || feedUrl.includes('/authwall') || feedUrl.includes('/checkpoint')) {
    console.log('SESSION EXPIRED: LinkedIn -- re-save session');
    await sendDiscordAlert(DISCORD_WEBHOOK,
      `**LinkedIn Inbox Check -- Session Expired**\nBoard: \`${BOARD_ID}\`\nLinkedIn redirected to login.`
    );
    return;
  }
  console.log('LinkedIn session valid');

  // ── Fetch board leads (paginated) ──
  console.log(`Fetching leads from board ${BOARD_ID}...`);
  const boardLeads = await fetchBoardLeads<Lead>(API_BASE, TOKEN, BOARD_ID, (l) => ({
    id: l.id,
    name: (l.name || l.full_name || '').trim(),
  }));
  console.log(`Loaded ${boardLeads.length} leads from board ${BOARD_ID}`);
  if (boardLeads.length === 0) {
    console.log('No leads found on board -- nothing to match against.');
    return;
  }

  // ── Scan inbox ──
  console.log(`\nScanning LinkedIn inbox (limit: ${LIMIT} conversations)...`);
  const provider = new LinkedInInboxProvider();
  const inboxResult = await provider.discover(page, context, {
    targetUrl: 'https://www.linkedin.com/messaging/',
    limit: LIMIT,
    scrollAttempts: 10,
  });
  console.log(`\nInbox scan complete: ${inboxResult.profiles.length} conversations read`);

  // ── Detect replies + tag leads ──
  const config: ScanConfig = {
    platform: 'linkedin', account: 'linkedin', boardId: BOARD_ID,
    apiBase: API_BASE, token: TOKEN, dryRun: DRY_RUN,
    ourName: LINKEDIN_USER_NAME, discordWebhook: DISCORD_WEBHOOK,
  };

  const result = await runInboxScan(config, inboxResult.profiles, boardLeads, {
    autoDetectOurName: !LINKEDIN_USER_NAME,
  });
  printSummary(config, result);

  // ── Sync to inbox-sync API ──
  if (!DRY_RUN && inboxResult.profiles.length > 0) {
    await syncInbox(API_BASE, TOKEN, BOARD_ID, 'linkedin', 'linkedin', inboxResult.profiles, config.ourName);
  }

  await sendResultAlert(config, result);
});
