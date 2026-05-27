import { test, chromium } from '@playwright/test';
import { WhatsAppInboxProvider } from './helpers/providers/whatsapp-inbox-provider';
import {
  fetchBoardLeads, runInboxScan, syncInbox, printSummary, sendResultAlert,
  sendDiscordAlert, tagLeadAsReplied, Lead, ScanConfig,
} from './helpers/inbox-scanner';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TOKEN = process.env.HEYIRIS_TOKEN;
if (!TOKEN) throw new Error('HEYIRIS_TOKEN env var required. Set in ~/.iris/bridge/.env or export it.');
const BOARD_ID = parseInt(process.env.BOARD_ID || '38', 10);
const LIMIT = parseInt(process.env.LIMIT || '20', 10);
const WA_ACCOUNT = process.env.WA_ACCOUNT || 'default';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const SESSION_INPUT = process.env.BROWSER_SESSION_FILE
  || process.env.WA_SESSION_DIR
  || path.join(os.homedir(), '.iris', 'whatsapp-sessions', WA_ACCOUNT);
const API_BASE = process.env.IRIS_FL_API_URL || 'https://raichu.heyiris.io';

const DISCORD_WEBHOOK = process.env.PLATFORM_UPDATES_DISCORD_CHANNEL_WEBHOOK_URL || '';

/** Resolve session input to a usable directory, extracting archives if needed */
function resolveSessionDir(input: string): { dir: string; cleanup: boolean } {
  if (input.endsWith('.tar.gz') || input.endsWith('.tgz')) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-session-'));
    const { execSync } = require('child_process');
    execSync(`tar -xzf "${input}" -C "${tmpDir}"`, { stdio: 'pipe' });
    console.log(`  Extracted session archive to ${tmpDir}`);
    return { dir: tmpDir, cleanup: true };
  }
  if (input.endsWith('.json')) {
    console.log(`  ERROR: JSON session files not supported for WhatsApp.`);
    console.log(`  WhatsApp stores auth in IndexedDB, not cookies.`);
    console.log(`  Run: WA_ACCOUNT=${WA_ACCOUNT} npx playwright test som/save-whatsapp-session.spec.ts --headed`);
    return { dir: '', cleanup: false };
  }
  return { dir: input, cleanup: false };
}

test(`WhatsApp Inbox Reply Check — ${WA_ACCOUNT} / Board ${BOARD_ID}`, async () => {
  test.setTimeout(600000);

  const resolved = resolveSessionDir(SESSION_INPUT);
  if (!resolved.dir) return;
  const SESSION_DIR = resolved.dir;

  if (!fs.existsSync(SESSION_DIR) || !fs.readdirSync(SESSION_DIR).length) {
    console.log(`No session found: ${SESSION_DIR}`);
    console.log(`Run: WA_ACCOUNT=${WA_ACCOUNT} npx playwright test som/save-whatsapp-session.spec.ts --headed`);
    return;
  }

  console.log(`Launching WhatsApp Web with persistent session (${WA_ACCOUNT})...`);
  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: process.env.HEADLESS === '1',
    viewport: { width: 1280, height: 720 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = context.pages()[0] || await context.newPage();

  try {
    // ── Session preflight ──
    console.log('Validating WhatsApp session...');
    await page.goto('https://web.whatsapp.com/', { timeout: 30000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    const hasChatList = await page.locator('div[aria-label="Chat list"][role="grid"]')
      .isVisible({ timeout: 15000 }).catch(() => false);
    if (!hasChatList) {
      const hasSearch = await page.locator('div[contenteditable="true"][data-tab="3"]')
        .isVisible({ timeout: 3000 }).catch(() => false);
      if (!hasSearch) {
        console.log(`SESSION EXPIRED: ${WA_ACCOUNT} — re-scan QR code`);
        await sendDiscordAlert(DISCORD_WEBHOOK, `**WA Inbox Check -- Session Expired** ${WA_ACCOUNT}`);
        return;
      }
    }
    console.log(`Session valid for ${WA_ACCOUNT}`);

    // ── Fetch board leads ──
    console.log(`\nFetching leads from board ${BOARD_ID}...`);
    const boardLeads = await fetchBoardLeads<Lead>(API_BASE, TOKEN, BOARD_ID, (l) => {
      const name = (l.name || l.full_name || '').trim();
      const contactInfo = typeof l.contact_info === 'string' ? JSON.parse(l.contact_info || '{}') : (l.contact_info || {});
      const phone = contactInfo.phone || contactInfo.whatsapp || l.phone || '';
      const igHandle = name.startsWith('@') ? name.slice(1) : name;
      return { id: l.id, name, phone, igHandle };
    });
    console.log(`Loaded ${boardLeads.length} leads from board ${BOARD_ID}`);
    if (boardLeads.length === 0) {
      console.log('No leads found on board — nothing to match against.');
      return;
    }

    // ── Scan inbox ──
    console.log(`\nScanning WhatsApp inbox (limit: ${LIMIT} conversations)...`);
    const provider = new WhatsAppInboxProvider();
    const inboxResult = await provider.discover(page, context, {
      targetUrl: 'https://web.whatsapp.com/',
      limit: LIMIT,
      scrollAttempts: 20,
      scrollDelay: 3000,
    });
    console.log(`\nInbox scan complete: ${inboxResult.profiles.length} conversations read`);
    if (inboxResult.errors.length > 0) {
      console.log(`Errors: ${inboxResult.errors.join(', ')}`);
    }

    // ── Detect replies + tag leads ──
    const config: ScanConfig = {
      platform: 'whatsapp', account: WA_ACCOUNT, boardId: BOARD_ID,
      apiBase: API_BASE, token: TOKEN, dryRun: DRY_RUN,
      ourName: '', discordWebhook: DISCORD_WEBHOOK,
    };

    const result = await runInboxScan(config, inboxResult.profiles, boardLeads, {
      onEnrich: async (lead, contactPhone, contactName) => {
        const enrichMsg = `[wa-enrich] WhatsApp phone detected: ${contactPhone} (from conversation with "${contactName}"). Run \`iris leads update ${lead.id} --phone ${contactPhone}\` to confirm.`;
        if (!DRY_RUN) {
          await tagLeadAsReplied(API_BASE, TOKEN, lead.id, enrichMsg, false);
          console.log(`    Enrichment note added (phone: ${contactPhone})`);
        } else {
          console.log(`    [DRY RUN] Would add enrichment note: phone ${contactPhone}`);
        }
      },
    });

    printSummary(config, result);

    // ── Sync to inbox-sync API ──
    if (!DRY_RUN && inboxResult.profiles.length > 0) {
      await syncInbox(API_BASE, TOKEN, BOARD_ID, 'whatsapp', WA_ACCOUNT, inboxResult.profiles, '');
    }

    await sendResultAlert(config, result);
  } finally {
    await context.close();
    if (resolved.cleanup && fs.existsSync(SESSION_DIR)) {
      try { fs.rmSync(SESSION_DIR, { recursive: true }); } catch {}
    }
  }
});
