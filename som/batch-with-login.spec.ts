import { test, Page, Locator } from '@playwright/test';
import { AuthHelper } from './helpers/auth-helper';
import { LeadgenApiClient } from './helpers/leadgen-api-client';
import { scrapeProfileStats } from './helpers/providers/base-provider';
import { getDmProvider } from './helpers/providers/dm-provider-factory';
import type { DmTarget } from './helpers/providers/dm-provider-types';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { runInboxScan, fetchBoardLeads, printSummary, sendResultAlert, type ScanConfig, type Lead as InboxLead } from './helpers/inbox-scanner';
import { LinkedInInboxProvider } from './helpers/providers/linkedin-inbox-provider';
import { InstagramInboxProvider } from './helpers/providers/instagram-inbox-provider';

const TOKEN = process.env.HEYIRIS_TOKEN;
if (!TOKEN) throw new Error('HEYIRIS_TOKEN env var required. Set in ~/.iris/bridge/.env or export it.');
// Frontend auth needs a JWT (Passport OAuth token), not the simple API key.
// Read from elon frontend .env, or use IRIS_FRONTEND_TOKEN env var.
const FRONTEND_TOKEN = process.env.IRIS_FRONTEND_TOKEN || (() => {
  try {
    const envPath = path.join(__dirname, '../../fl-docker-dev/fl-elon-web-ui/.env');
    const envContent = require('fs').readFileSync(envPath, 'utf-8');
    const match = envContent.match(/FL_RAICHU_API_TOKEN=(.+)/);
    return match?.[1]?.trim() || TOKEN;
  } catch { return TOKEN; }
})();
const BOARD_ID = parseInt(process.env.BOARD_ID || '38', 10);
const LEADS_TO_PROCESS = parseInt(process.env.LIMIT || '5', 10);
// Strategy alias map — shell-safe aliases resolve to full names with spaces/pipes
const STRATEGY_ALIASES: Record<string, string> = {
  'ai-course-v3': 'AI Course | V3', 'ai-course': 'AI Course | V3',
  'creator-v1': 'Creator Outreach | V1', 'creator': 'Creator Outreach | V1',
  'dj-v1': 'DJ Outreach | V1', 'dj': 'DJ Outreach | V2',
  'mayo-v1': 'Mayo Outreach | V1', 'mayo': 'Mayo Outreach | V1',
  'freelabelnet-v1': 'Creator Outreach | V1', 'freelabelnet': 'Creator Outreach | V1',
  'beauty-v1': 'Beauty & Wellness Outreach | V1', 'beauty': 'Beauty & Wellness Outreach | V1',
};
const rawStrategy = process.env.STRATEGY || 'AI Course | V3';
const STRATEGY_NAME = STRATEGY_ALIASES[rawStrategy.toLowerCase()] || rawStrategy;
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const PERSONALIZE = process.env.PERSONALIZE === '1' || process.env.PERSONALIZE === 'true';
const VARY = process.env.VARY !== '0' && process.env.VARY !== 'false'; // Default: true (vary enabled)
const AUTO_ENRICH = process.env.AUTO_ENRICH === '1';
const WARMUP = process.env.WARMUP === '1' || process.env.ENGAGE === '1';
const WARMUP_LIKES = parseInt(process.env.WARMUP_LIKES || '2', 10);
const WARMUP_FOLLOW = process.env.WARMUP_FOLLOW !== '0'; // Default: follow during warmup
const STEP_MODE = (process.env.STEP || 'auto').toLowerCase();
const FIXED_STEP = /^\d+$/.test(STEP_MODE) ? parseInt(STEP_MODE, 10) : null; // null = auto
const IS_AUTO_STEP = !FIXED_STEP; // auto/next mode
const IG_ACCOUNT = process.env.IG_ACCOUNT || 'heyiris.io';
const PLATFORM = (process.env.PLATFORM || '').toLowerCase();
const IS_LINKEDIN = PLATFORM === 'linkedin' || !IG_ACCOUNT || IG_ACCOUNT === 'null' || IG_ACCOUNT === 'none';
const OUTREACH_FILTER = (process.env.FILTER || 'new').toLowerCase() as 'all' | 'new' | 'followup';
const WAIT_DAYS = parseInt(process.env.WAIT_DAYS || '2', 10);
// MODE=ui (default, V1): full UI flow — Apply Strategy → Generate → Send → Mark step done
// MODE=api (V2): fast API-direct — skip UI, navigate straight to IG. Requires outreach steps to exist.
const SOM_MODE = (process.env.MODE || 'ui').toLowerCase() as 'ui' | 'api';
// SCAN_INBOX: run inbox scan before outreach to catch replies (default: on)
const SCAN_INBOX = process.env.SCAN_INBOX !== '0';
const INBOX_LIMIT = parseInt(process.env.INBOX_LIMIT || '20', 10);

const LINKEDIN_AUTH_FILE = path.join(__dirname, 'linkedin-auth.json');
const DAILY_DM_CAP = parseInt(process.env.DAILY_DM_CAP || '40', 10);
const DM_SENT_FILE = path.join(__dirname, `../../test-results/.dm-sent-${IG_ACCOUNT}-${new Date().toISOString().slice(0, 10)}.json`);

// LinkedIn daily cap — separate from IG, defaults to 25 (safe limit for free accounts)
const LINKEDIN_DAILY_CAP = parseInt(process.env.LINKEDIN_DAILY_CAP || '25', 10);
const LI_DM_SENT_FILE = path.join(__dirname, `../../test-results/.dm-sent-linkedin-${new Date().toISOString().slice(0, 10)}.json`);

const IG_AUTH_FILE = process.env.BROWSER_SESSION_FILE
  || path.join(__dirname, `instagram-auth-${IG_ACCOUNT}.json`);
const IG_AUTH_LEGACY = path.join(__dirname, 'instagram-auth.json');

const DISCORD_WEBHOOK = process.env.PLATFORM_UPDATES_DISCORD_CHANNEL_WEBHOOK_URL || '';

/**
 * Read per-lead state directly from the workspace UI's `<tr>` data attributes.
 * Replaces the API-sourced leadMap (which had a 200-lead cap). The workspace
 * already renders id / igHandle / hasEmail / hasPhone / hasDmNote / hasReply
 * on every row — see fl-elon-web-ui BloqLeadsTab.vue.
 */
type RowAttrs = {
  id: number | null;
  igHandle: string | null;
  linkedinUrl: string | null;
  hasEmail: boolean;
  hasPhone: boolean;
  hasDmNote: boolean;
  hasReply: boolean;
  outreachCount: number;
};
async function readRowAttrs(row: Locator): Promise<RowAttrs> {
  const [id, ig, linkedin, hasEmail, hasPhone, hasDm, hasReply, outreach] = await Promise.all([
    row.getAttribute('data-lead-id'),
    row.getAttribute('data-ig-handle'),
    row.getAttribute('data-linkedin-url'),
    row.getAttribute('data-has-email'),
    row.getAttribute('data-has-phone'),
    row.getAttribute('data-has-dm-note'),
    row.getAttribute('data-has-reply'),
    row.getAttribute('data-outreach-count'),
  ]);
  const parsedId = parseInt(id || '', 10);
  return {
    id: Number.isFinite(parsedId) && parsedId > 0 ? parsedId : null,
    igHandle: ig ? ig.replace(/^@/, '').toLowerCase() || null : null,
    linkedinUrl: linkedin || null,
    hasEmail: hasEmail === 'true',
    hasPhone: hasPhone === 'true',
    hasDmNote: hasDm === 'true',
    hasReply: hasReply === 'true',
    outreachCount: parseInt(outreach || '0', 10) || 0,
  };
}

function sendDiscordAlert(message: string): Promise<void> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ content: message });
    const url = new URL(DISCORD_WEBHOOK);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, () => resolve());
    req.on('error', () => resolve()); // never block the test on notification failure
    req.write(body);
    req.end();
  });
}

/** Send a rich Discord embed (colors, fields, links) */
function sendDiscordBatchSummary(opts: {
  sent: number; skipped: number; failed: number;
  duration: string; boardId: number; strategy: string; igAccount: string;
  replies: { name: string; leadId: number; contact: string; lastMsg: string }[];
  leadTimings?: { name: string; duration: number; status: string }[];
}): Promise<void> {
  if (DRY_RUN) return Promise.resolve();
  const { sent, skipped, failed, duration, boardId, strategy, igAccount, replies, leadTimings } = opts;
  const total = sent + skipped + failed;
  const color = sent > 0 ? 0x44FF44 : failed > 0 ? 0xFF4444 : 0xFFAA00; // green / red / orange
  const boardUrl = `https://web.freelabel.net/iris?boardId=${boardId}&tab=leads`;

  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: 'DMs Sent', value: `**${sent}**`, inline: true },
    { name: 'Skipped', value: `${skipped}`, inline: true },
    { name: 'Failed', value: `${failed}`, inline: true },
    { name: 'Account', value: `@${igAccount}`, inline: true },
    { name: 'Strategy', value: strategy, inline: true },
    { name: 'Duration', value: `${duration}s`, inline: true },
  ];

  // Replied leads — the main thing the user wants to see
  let replySection = '';
  if (replies.length > 0) {
    const lines = replies.slice(0, 15).map(r => {
      const leadUrl = `${boardUrl}&lead=${r.leadId}`;
      const igUrl = `https://www.instagram.com/${r.contact.replace(/^@/, '')}/`;
      const msgPreview = r.lastMsg.length > 80 ? r.lastMsg.substring(0, 80) + '...' : r.lastMsg;
      return `**${r.name}** ([profile](${igUrl}) | [lead](${leadUrl}))\n> ${msgPreview}`;
    });
    replySection = lines.join('\n\n');
    if (replies.length > 15) replySection += `\n\n_...and ${replies.length - 15} more_`;
  }

  // Top sent leads
  let sentList = '';
  if (leadTimings && leadTimings.length > 0) {
    const sentLeads = leadTimings.filter(t => t.status === 'sent').slice(0, 10);
    if (sentLeads.length > 0) {
      sentList = sentLeads.map(t => `\`${t.name}\` (${t.duration}s)`).join(', ');
    }
  }

  const embeds: any[] = [{
    title: `${sent > 0 ? '✅' : '⚠️'} SOM Batch Complete — ${sent}/${total} sent`,
    color,
    fields,
    footer: { text: `Board ${boardId}` },
    timestamp: new Date().toISOString(),
    url: boardUrl,
  }];

  // Add reply embed if there are replies
  if (replies.length > 0) {
    embeds.push({
      title: `🔥 ${replies.length} Lead${replies.length > 1 ? 's' : ''} Ready to Talk`,
      description: replySection,
      color: 0xFF6600,
      footer: { text: 'Open inbox to continue the conversation' },
    });
  }

  // Add sent leads field if available
  if (sentList) {
    embeds[0].fields.push({ name: 'Sent To', value: sentList, inline: false });
  }

  const payload = { embeds };
  const body = JSON.stringify(payload);

  return new Promise((resolve) => {
    const url = new URL(DISCORD_WEBHOOK);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, () => resolve());
    req.on('error', () => resolve());
    req.write(body);
    req.end();
  });
}

/**
 * DM tracking — stores both count AND lead IDs sent today.
 * Lead IDs survive crashes: if we sent the DM but crashed before the API note,
 * the next run sees the ID in this file and skips the lead (idempotency).
 */
interface DmSentData {
  count: number;
  leadIds: number[];
  updated: string;
}

function readDmSentData(filePath: string): DmSentData {
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return {
        count: raw.count || (raw.leadIds?.length || 0),
        leadIds: Array.isArray(raw.leadIds) ? raw.leadIds : [],
        updated: raw.updated || '',
      };
    }
  } catch {}
  return { count: 0, leadIds: [], updated: '' };
}

function getDmsSentToday(): number {
  return readDmSentData(DM_SENT_FILE).count;
}
function recordDmSent(leadId?: number | null): void {
  const data = readDmSentData(DM_SENT_FILE);
  if (leadId && !data.leadIds.includes(leadId)) {
    data.leadIds.push(leadId);
  }
  data.count = data.leadIds.length || (data.count + 1);
  data.updated = new Date().toISOString();
  fs.mkdirSync(path.dirname(DM_SENT_FILE), { recursive: true });
  fs.writeFileSync(DM_SENT_FILE, JSON.stringify(data));
}
function wasLeadDmSentToday(leadId: number, filePath?: string): boolean {
  const data = readDmSentData(filePath || DM_SENT_FILE);
  return data.leadIds.includes(leadId);
}

/** LinkedIn-specific DM tracker */
function getLinkedInDmsSentToday(): number {
  return readDmSentData(LI_DM_SENT_FILE).count;
}
function recordLinkedInDmSent(leadId?: number | null): void {
  const data = readDmSentData(LI_DM_SENT_FILE);
  if (leadId && !data.leadIds.includes(leadId)) {
    data.leadIds.push(leadId);
  }
  data.count = data.leadIds.length || (data.count + 1);
  data.updated = new Date().toISOString();
  fs.mkdirSync(path.dirname(LI_DM_SENT_FILE), { recursive: true });
  fs.writeFileSync(LI_DM_SENT_FILE, JSON.stringify(data));
}

test(`Batch Outreach — Board ${BOARD_ID} / ${STRATEGY_NAME}`, async ({ page, context }) => {
  // ── AUTH (HeyIRIS) ──
  await AuthHelper.loginWithToken(page, FRONTEND_TOKEN);

  // ── AUTH (Instagram / LinkedIn) ── load saved session cookies into this context
  let igFile: string | null = null;
  if (IS_LINKEDIN) {
    // LinkedIn campaign — load LinkedIn cookies instead of Instagram
    if (fs.existsSync(LINKEDIN_AUTH_FILE)) {
      const state = JSON.parse(fs.readFileSync(LINKEDIN_AUTH_FILE, 'utf-8'));
      if (state.cookies && state.cookies.length > 0) {
        await context.addCookies(state.cookies);
        console.log(`✓ LinkedIn session loaded (${state.cookies.length} cookies)`);
      }
    } else {
      console.log(`⚠️  No linkedin-auth.json found — save LinkedIn session first\n`);
    }
  } else {
    igFile = fs.existsSync(IG_AUTH_FILE) ? IG_AUTH_FILE
      : fs.existsSync(IG_AUTH_LEGACY) ? IG_AUTH_LEGACY : null;
    if (igFile) {
      const state = JSON.parse(fs.readFileSync(igFile, 'utf-8'));
      if (state.cookies && state.cookies.length > 0) {
        await context.addCookies(state.cookies);
        console.log(`✓ Instagram session loaded for @${IG_ACCOUNT} (${state.cookies.length} cookies)`);
      }
    } else {
      console.log(`⚠️  No instagram-auth-${IG_ACCOUNT}.json found — run save-instagram-session first`);
      console.log(`   IG_ACCOUNT=${IG_ACCOUNT} npx playwright test tests/e2e/save-instagram-session.spec.ts --headed\n`);
    }
  }

  // ── PREFLIGHT: validate IG session before wasting time loading workspace ──
  if (!IS_LINKEDIN && igFile) {
    console.log('Validating Instagram session...');
    const checkPage = await context.newPage();
    try {
      await checkPage.goto('https://www.instagram.com/', { timeout: 15000, waitUntil: 'domcontentloaded' });
      await checkPage.waitForTimeout(1500);
      const checkUrl = checkPage.url();
      const onLogin = checkUrl.includes('/accounts/login') || checkUrl.includes('/challenge/');
      const hasForm = await checkPage.locator('input[name="username"], input[aria-label="Phone number, username, or email"]').first().isVisible({ timeout: 2000 }).catch(() => false);
      // Detect the logged-out splash page ("Log in or Sign up" with no nav)
      const hasLoggedOutSplash = await checkPage.locator('a:has-text("Log in"), button:has-text("Log in")').first().isVisible({ timeout: 1000 }).catch(() => false)
        && !(await checkPage.locator('svg[aria-label="Home"]').isVisible({ timeout: 500 }).catch(() => false));
      if (onLogin || hasForm || hasLoggedOutSplash) {
        console.log(`\n${'='.repeat(70)}`);
        console.log(`  SESSION EXPIRED: @${IG_ACCOUNT}`);
        console.log(`  Fix: IG_ACCOUNT=${IG_ACCOUNT} npx playwright test tests/e2e/save-instagram-session.spec.ts --headed`);
        console.log(`${'='.repeat(70)}\n`);
        fs.mkdirSync('test-results/screenshots', { recursive: true });
        await checkPage.screenshot({ path: `test-results/screenshots/session-expired-preflight-${IG_ACCOUNT}.png` }).catch(() => {});
        await sendDiscordAlert(
          `**SOM — Instagram Session Expired (preflight)**\n` +
          `Account: \`@${IG_ACCOUNT}\` | Board: \`${BOARD_ID}\`\n` +
          `Session dead before batch started. Re-save to fix.`
        );
        await checkPage.close();
        return; // Abort entire test
      }
      console.log(`Instagram session valid for @${IG_ACCOUNT}`);
    } catch (err: any) {
      console.log(`IG preflight check failed: ${err.message?.substring(0, 60)} — continuing anyway`);
    }
    await checkPage.close().catch(() => {});
  }

  // ── PREFLIGHT: validate LinkedIn session before wasting time loading workspace ──
  if (IS_LINKEDIN && fs.existsSync(LINKEDIN_AUTH_FILE)) {
    console.log('Validating LinkedIn session...');
    const checkPage = await context.newPage();
    try {
      await checkPage.goto('https://www.linkedin.com/feed/', { timeout: 15000, waitUntil: 'domcontentloaded' });
      await checkPage.waitForTimeout(2000);
      const liUrl = checkPage.url();
      const isExpired = liUrl.includes('/login') || liUrl.includes('/authwall') || liUrl.includes('/checkpoint');
      if (isExpired) {
        console.log(`\n${'='.repeat(70)}`);
        console.log(`  SESSION EXPIRED: LinkedIn`);
        console.log(`  Fix: npx playwright test tests/e2e/save-linkedin-session.spec.ts --headed`);
        console.log(`${'='.repeat(70)}\n`);
        fs.mkdirSync('test-results/screenshots', { recursive: true });
        await checkPage.screenshot({ path: `test-results/screenshots/session-expired-preflight-linkedin.png` }).catch(() => {});
        await sendDiscordAlert(
          `**SOM LinkedIn — Session Expired (preflight)**\n` +
          `Board: \`${BOARD_ID}\`\n` +
          `LinkedIn redirected to login. Re-save session to fix.`
        );
        await checkPage.close();
        return; // Abort entire test
      }
      console.log('LinkedIn session valid');
    } catch (err: any) {
      console.log(`LinkedIn preflight check failed: ${err.message?.substring(0, 60)} — continuing anyway`);
    }
    await checkPage.close().catch(() => {});
  }

  console.log(`\n📋 Campaign: Board ${BOARD_ID} / Strategy: ${STRATEGY_NAME}`);
  console.log(`   Instagram: @${IG_ACCOUNT}`);
  console.log(`   Limit: ${LEADS_TO_PROCESS} leads`);
  console.log(`   Step: ${FIXED_STEP ? `Fixed step ${FIXED_STEP}` : 'AUTO (next uncompleted)'}`);
  console.log(`   Filter: ${OUTREACH_FILTER === 'new' ? 'NEW ONLY (first contact)' : OUTREACH_FILTER === 'followup' ? 'FOLLOW-UP ONLY (continue sequences)' : 'ALL (new + follow-ups)'}`);
  console.log(`   Engine: ${SOM_MODE === 'api' ? 'API-DIRECT (v2 — fast, skip UI)' : 'UI (v1 — Apply Strategy flow)'}`);
  if (DRY_RUN) console.log('   Mode: DRY RUN (will NOT send DMs)');
  if (PERSONALIZE) console.log('   Mode: PERSONALIZE (fetch bio)');
  if (!VARY) console.log('   Mode: VARY DISABLED (skip variation)');
  if (WARMUP) console.log(`   Mode: WARMUP (like ${WARMUP_LIKES} posts${WARMUP_FOLLOW ? ' + follow' : ''} before DM)`);

  // ── DAILY DM CAP CHECK ──
  const dmsSentToday = IS_LINKEDIN ? getLinkedInDmsSentToday() : getDmsSentToday();
  const activeDailyCap = IS_LINKEDIN ? LINKEDIN_DAILY_CAP : DAILY_DM_CAP;
  const dmsRemaining = Math.max(0, activeDailyCap - dmsSentToday);
  const capLabel = IS_LINKEDIN ? 'LinkedIn' : `@${IG_ACCOUNT}`;
  console.log(`   Daily DM cap (${capLabel}): ${dmsSentToday}/${activeDailyCap} sent today (${dmsRemaining} remaining)`);

  // ── QUOTA DASHBOARD ──
  try {
    const quotaRes = await fetch(`${process.env.IRIS_FL_API_URL || 'https://raichu.heyiris.io'}/api/v1/outreach/quota?bloq_id=${BOARD_ID}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
    });
    if (quotaRes.ok) {
      const qd = await quotaRes.json() as any;
      const q = qd.quotas || {};
      const p = qd.progress || {};
      const pct = qd.percent || {};
      if (Object.keys(q).length > 0) {
        const bar = (pct: number) => { const f = Math.round((pct / 100) * 10); return '█'.repeat(f) + '░'.repeat(10 - f); };
        console.log('   ┌─ Quota Progress ─────────────────────────────┐');
        if (q.dms_per_week) console.log(`   │ DMs/wk:  ${bar(pct.dms ?? 0)} ${p.dms_this_week ?? 0}/${q.dms_per_week} (${pct.dms ?? 0}%)${(pct.dms ?? 0) >= 100 ? ' ✓' : ''} │`);
        if (q.replies_per_week) console.log(`   │ Replies: ${bar(pct.replies ?? 0)} ${p.replies_this_week ?? 0}/${q.replies_per_week} (${pct.replies ?? 0}%)${(pct.replies ?? 0) >= 100 ? ' ✓' : ''} │`);
        if (q.revenue_per_month) console.log(`   │ Rev/mo:  ${bar(pct.revenue ?? 0)} $${p.revenue_this_month ?? 0}/$${q.revenue_per_month} (${pct.revenue ?? 0}%) │`);
        if (q.deals_per_month) console.log(`   │ Deals:   ${bar(pct.deals ?? 0)} ${p.deals_this_month ?? 0}/${q.deals_per_month} (${pct.deals ?? 0}%)${(pct.deals ?? 0) >= 100 ? ' ✓' : ''} │`);
        console.log('   └───────────────────────────────────────────────┘');
      }
    }
  } catch {}

  if (!DRY_RUN && dmsRemaining <= 0) {
    console.log(`\n🚫 Daily ${IS_LINKEDIN ? 'LinkedIn' : 'IG'} DM limit reached (${dmsSentToday}/${activeDailyCap}) — aborting batch`);
    await sendDiscordAlert(
      `🚫 **SOM DM — Daily Limit Reached**\n` +
      `📋 Board: \`${BOARD_ID}\` | Account: \`${capLabel}\`\n` +
      `Sent ${dmsSentToday}/${activeDailyCap} DMs today. Try again tomorrow.`
    );
    return;
  }
  console.log('');

  // ── PRE-FLIGHT INBOX SCAN ──
  // Hoisted so batch completion can include reply summary in Discord notification
  let inboxReplies: { name: string; leadId: number; contact: string; lastMsg: string }[] = [];
  if (SCAN_INBOX) {
    console.log('📬 Pre-flight inbox scan...\n');
    try {
      const inboxApiBase = process.env.IRIS_FL_API_URL || 'https://raichu.heyiris.io';

      // Navigate to messaging
      const messagingUrl = IS_LINKEDIN
        ? 'https://www.linkedin.com/messaging/'
        : 'https://www.instagram.com/direct/inbox/';
      await page.goto(messagingUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3000);

      // Dismiss popups
      for (const text of ['Not Now', 'Not now', 'Cancel', 'Dismiss', 'No thanks', 'Got it']) {
        const btn = page.locator(`button:has-text("${text}")`).first();
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          await btn.click().catch(() => {});
          await page.waitForTimeout(500);
        }
      }

      // Scan inbox using the appropriate provider
      const provider = IS_LINKEDIN ? new LinkedInInboxProvider() : new InstagramInboxProvider();
      const inboxResult = await provider.discover(page, context, {
        targetUrl: messagingUrl,
        limit: INBOX_LIMIT,
        scrollAttempts: 5,
      });
      console.log(`   Scanned ${inboxResult.profiles.length} conversations`);

      // Fetch board leads for matching
      const inboxLeads = await fetchBoardLeads(inboxApiBase, TOKEN, BOARD_ID, (raw: any) => ({
        id: raw.id,
        name: raw.name || raw.nickname || '',
        igHandle: raw.contact_info?.instagram || raw.nickname?.replace(/^@/, '') || '',
        phone: raw.contact_info?.phone || raw.phone || '',
      }));

      // Run the scanner — matches, tags, reports
      const scanConfig: ScanConfig = {
        platform: IS_LINKEDIN ? 'linkedin' : 'instagram',
        account: IS_LINKEDIN ? 'linkedin' : IG_ACCOUNT,
        boardId: BOARD_ID,
        apiBase: inboxApiBase,
        token: TOKEN,
        dryRun: DRY_RUN,
        ourName: '',
        discordWebhook: DISCORD_WEBHOOK,
      };

      const scanResult = await runInboxScan(scanConfig, inboxResult.profiles, inboxLeads, { autoDetectOurName: true });
      printSummary(scanConfig, scanResult);
      await sendResultAlert(scanConfig, scanResult);
      inboxReplies = scanResult.tagged;

      if (scanResult.tagged.length > 0) {
        console.log(`\n   ${scanResult.tagged.length} leads replied — they will be skipped in outreach\n`);
      }
    } catch (inboxErr: any) {
      console.log(`   Inbox scan failed: ${inboxErr.message} — continuing to outreach\n`);
    }
  } else {
    console.log('📬 Inbox scan: OFF (set SCAN_INBOX=1 to enable)\n');
  }

  // ── ENRICHMENT SETUP (always-on) ──
  // apiClient is still used for state-mutating calls (addNote, quickEnrichInstagram).
  // Per-lead eligibility (hasDmNote, hasReply, igHandle, id) is read from the rendered
  // workspace UI via data-* attributes — no leadMap, no 200-cap, no API fanout.
  const apiClient = new LeadgenApiClient(TOKEN, BOARD_ID);
  const enrichStats = { checked: 0, enriched: 0, emailsFound: 0, alreadyHad: 0 };

  // ── NAVIGATE ──
  console.log('🚀 Navigating to leads...\n');
  await page.goto(`https://web.freelabel.net/iris?boardId=${BOARD_ID}&tab=leads`);

  // Wait for workspace to fully load (wait for loading spinner to disappear, then check nav)
  console.log('⏳ Waiting for workspace...');
  // First wait for the loading spinner to disappear
  await page.locator('text=Loading IRIS Memory').waitFor({ state: 'hidden', timeout: 60000 }).catch(() => {
    console.log('  ⏳ Loading spinner not found or already hidden');
  });
  // Then wait for the leads table or nav tabs to appear
  for (let i = 0; i < 30; i++) {
    const hasTable = await page.locator('table tbody').first().isVisible().catch(() => false);
    const hasNav = await page.locator('text=Contacts').first().isVisible().catch(() => false);
    if (hasTable || hasNav) { console.log('✓ Workspace loaded'); break; }
    if (i % 10 === 0) console.log(`  ⏳ ${i}s...`);
    await page.waitForTimeout(1000);
  }

  // Poll for leads
  let rowCount = 0;
  for (let i = 0; i < 30; i++) {
    rowCount = await page.locator('table tbody tr').count();
    if (rowCount > 0) break;
    console.log(`  ⏳ Waiting for leads... (${i + 1}/30)`);
    await page.waitForTimeout(2000);
  }
  console.log(`✓ Found ${rowCount} leads\n`);
  if (rowCount === 0 && SOM_MODE !== 'api') { console.log('⚠️  No leads.'); return; }
  if (rowCount === 0 && SOM_MODE === 'api') { console.log('⚠️  No leads in UI — continuing to API-direct mode (UI rows not needed)'); }

  await page.waitForTimeout(1000);

  // ── API PRE-FILTER: fetch eligible lead IDs from API instead of scanning all UI rows ──
  // On large boards (9000+ leads), scanning row-by-row through "Load More" only
  // reaches ~500 leads. Instead, fetch eligible lead IDs from the API and use them as
  // an allow-list when scanning the UI. This way we skip already-outreached leads.
  let apiFilteredIds: Set<number> | null = null;
  const apiBase = process.env.IRIS_FL_API_URL || 'https://raichu.heyiris.io';
  const apiToken = TOKEN;

  if (OUTREACH_FILTER === 'followup') {
    try {
      const fRes = await fetch(
        `${apiBase}/api/v1/leads/follow-up-ready?bloq_id=${BOARD_ID}&wait_days=${WAIT_DAYS}&limit=200`,
        { headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' } }
      );
      if (fRes.ok) {
        const fData = await fRes.json();
        const ids = (fData.data || []).map((l: any) => l.id).filter(Boolean);
        apiFilteredIds = new Set(ids);
        console.log(`✓ API follow-up ready: ${apiFilteredIds.size} leads past ${WAIT_DAYS}-day wait (of ${fData.total || '?'} eligible)`);
      }
    } catch (e: any) {
      console.log(`⚠️  API follow-up shortcut failed: ${e.message} — falling back to UI scan`);
    }
  } else if (OUTREACH_FILTER === 'new' || FIXED_STEP === 1) {
    // NEW OUTREACH: fetch only leads that have NO outreach steps yet
    try {
      // has_social=1 filters to leads with IG/social handles (skips non-DM-able leads like law firms)
      const socialFilter = IS_LINKEDIN ? '' : '&has_social=1';
      const perPage = Math.min(LEADS_TO_PROCESS * 3, 500);
      const freshRes = await fetch(
        `${apiBase}/api/v1/leads?bloq_id=${BOARD_ID}&outreach_status=no_outreach${socialFilter}&sort=updated_at&order=desc&per_page=${perPage}`,
        { headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' } }
      );
      if (freshRes.ok) {
        const freshData = await freshRes.json();
        const leads = freshData.data?.data || freshData.data || [];
        const ids = leads.map((l: any) => l.id).filter(Boolean);
        apiFilteredIds = new Set(ids);
        const totalFresh = freshData.data?.total || freshData.total || ids.length;
        console.log(`✓ API fresh leads: ${apiFilteredIds.size} without outreach (${totalFresh} total on board)`);
        if (apiFilteredIds.size === 0) {
          // No fresh leads — try not_contacted (have steps assigned but none completed yet)
          console.log('⚠️  No fresh leads. Checking for leads with incomplete outreach steps...');
          try {
            const pendingRes = await fetch(
              `${apiBase}/api/v1/leads?bloq_id=${BOARD_ID}&outreach_status=not_contacted${socialFilter}&sort=updated_at&order=desc&per_page=${perPage}`,
              { headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' } }
            );
            if (pendingRes.ok) {
              const pendingData = await pendingRes.json();
              const pendingLeads = pendingData.data?.data || pendingData.data || [];
              const pendingIds = pendingLeads.map((l: any) => l.id).filter(Boolean);
              if (pendingIds.length > 0) {
                apiFilteredIds = new Set(pendingIds);
                console.log(`✓ Found ${apiFilteredIds.size} leads with incomplete outreach — using those instead`);
              } else {
                console.log('⚠️  All leads fully contacted. Run leadgen to discover more.');
              }
            }
          } catch (e2: any) {
            console.log(`⚠️  Pending-lead fallback failed: ${e2.message}`);
          }
        }
      }
    } catch (e: any) {
      console.log(`⚠️  API fresh-lead shortcut failed: ${e.message} — falling back to UI scan`);
    }
  }

  // ── API-DIRECT MODE: only when MODE=api AND we have API-filtered IDs ──
  // MODE=ui (default): full UI flow with Apply Strategy + step tracking
  // MODE=api: fast direct navigation, skips UI table scan
  const useApiDirect = SOM_MODE === 'api' && !!(apiFilteredIds && apiFilteredIds.size > 0);
  if (useApiDirect) {
    console.log(`⚡ API-DIRECT MODE: ${apiFilteredIds!.size} leads from API — skipping UI table scan\n`);
  }

  // ── FILTER leads based on step mode — auto-paginate if needed ──
  // step=1 or unset: only leads WITHOUT outreach badge (need first contact)
  // step=N (N>1):    only leads WITH outreach badge (already started, need step N)
  // step=auto:       ALL leads — eligibility determined after opening panel
  const eligibleRows: number[] = [];
  let scannedUpTo = 0;

  // API-DIRECT skips the entire UI scanning/pagination loop
  if (!useApiDirect) {
  // Scale pagination with board size — small boards need 2-3 pages, large boards need more
  // Follow-up mode with API shortcut needs fewer pages (we have the ID allow-list)
  const MAX_LOAD_MORE = apiFilteredIds ? 5 : Math.min(Math.ceil(rowCount / 50) + 3, 40);

  for (let pageAttempt = 0; pageAttempt <= MAX_LOAD_MORE; pageAttempt++) {
    rowCount = await page.locator('table tbody tr').count();

    // Scan any NEW rows since last scan
    for (let r = scannedUpTo; r < rowCount; r++) {
      const row = page.locator('table tbody tr').nth(r);

      // API follow-up shortcut: check lead ID against the allow-list
      if (apiFilteredIds) {
        const rowAttrs = await readRowAttrs(row);
        if (rowAttrs.id && !apiFilteredIds.has(rowAttrs.id)) continue;
        eligibleRows.push(r);
        continue;
      }

      const hasOutreach = await row.locator('.fa-paper-plane').isVisible().catch(() => false);

      // Apply outreach filter first (filter= param controls which leads enter the batch)
      if (OUTREACH_FILTER === 'new' && hasOutreach) continue;      // new-only: skip leads with outreach
      if (OUTREACH_FILTER === 'followup' && !hasOutreach) continue; // followup-only: skip fresh leads

      if (IS_AUTO_STEP) {
        // Auto mode: include ALL leads (fresh + in-progress). Skip fully completed later.
        eligibleRows.push(r);
      } else if (FIXED_STEP === 1) {
        // Step 1: only leads without outreach (same as legacy behavior)
        if (!hasOutreach) eligibleRows.push(r);
      } else {
        // Step N>1: only leads that already have outreach started
        if (hasOutreach) eligibleRows.push(r);
      }
    }
    scannedUpTo = rowCount;

    console.log(`✓ Page ${pageAttempt + 1}: ${rowCount} rows scanned, ${eligibleRows.length} eligible (need ${LEADS_TO_PROCESS})`);

    // Do we have enough? Scan extra rows to account for leads without IG handles.
    // We need LEADS_TO_PROCESS DM-able leads, but some eligible rows won't have handles.
    if (eligibleRows.length >= LEADS_TO_PROCESS * 5) break;

    // Try clicking "Load More Leads"
    const loadMoreBtn = page.locator('button:has-text("Load More Leads")').first();
    if (await loadMoreBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      const disabled = await loadMoreBtn.isDisabled().catch(() => false);
      if (disabled) {
        console.log('⏭️  Load More button is disabled');
        break;
      }
      console.log('→ Loading more leads...');
      await loadMoreBtn.click();
      // Wait for new rows to appear
      for (let w = 0; w < 15; w++) {
        const newCount = await page.locator('table tbody tr').count();
        if (newCount > rowCount) break;
        await page.waitForTimeout(1000);
      }
      await page.waitForTimeout(2000);
    } else {
      // Check for "All X leads loaded" message — no more pages
      const allLoaded = await page.locator('text=leads loaded').isVisible().catch(() => false);
      if (allLoaded) console.log('✓ All leads loaded — no more pages');
      else console.log('⏭️  No Load More button found');
      break;
    }
  }
  } // end if (!useApiDirect) — UI scanning block

  // ── API-DIRECT: skip row scanning, process leads directly from API IDs ──
  if (useApiDirect && apiFilteredIds && apiFilteredIds.size > 0) {
    const dmsRemaining = IS_LINKEDIN ? Math.max(0, LINKEDIN_DAILY_CAP - getLinkedInDmsSentToday()) : Math.max(0, DAILY_DM_CAP - getDmsSentToday());
    const directLimit = DRY_RUN ? LEADS_TO_PROCESS : Math.min(LEADS_TO_PROCESS, dmsRemaining);
    const apiLeadIds = [...apiFilteredIds].slice(0, directLimit);
    console.log(`⚡ API-DIRECT: Processing ${apiLeadIds.length} leads by direct navigation\n`);

    const results = { sent: 0, skipped: 0, failed: 0, repliedSkipped: 0 };
    const leadTimings: { name: string; duration: number; status: string }[] = [];
    const batchStart = Date.now();

    for (let idx = 0; idx < apiLeadIds.length; idx++) {
      const leadId = apiLeadIds[idx];
      const leadStart = Date.now();
      console.log(`\n━━━ Lead ${idx + 1}/${apiLeadIds.length} (ID: ${leadId}) ━━━\n`);

      try {
        // Fetch lead details from API to get IG handle
        const leadRes = await fetch(
          `${apiBase}/api/v1/leads/${leadId}`,
          { headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' } }
        );
        if (!leadRes.ok) {
          console.log(`API error: ${leadRes.status}`);
          results.skipped++;
          leadTimings.push({ name: `#${leadId}`, duration: (Date.now() - leadStart) / 1000, status: 'skip' });
          continue;
        }
        const leadData = (await leadRes.json()).data || {};
        const contactInfo = leadData.contact_info || {};
        const rawHandle = IS_LINKEDIN
          ? (contactInfo.linkedin || contactInfo.linkedin_url || leadData.linkedin_url || '')
          : (contactInfo.instagram || contactInfo.social_handle || leadData.nickname || '');
        // For LinkedIn, extract the slug from the full URL for display/messages
        const igHandle = IS_LINKEDIN && rawHandle.includes('linkedin.com/')
          ? rawHandle.replace(/.*linkedin\.com\/in\//, '').replace(/\/$/, '')
          : rawHandle;
        // Keep the full URL for navigation
        const linkedInFullUrl = IS_LINKEDIN ? rawHandle : '';
        // Prefer enriched display name (real name) over raw handle
        const customFields = leadData.custom_fields || {};
        const displayName = customFields.ig_display_name || customFields.ig_enrichment?.full_name || '';
        const name = displayName || leadData.name || igHandle || `Lead #${leadId}`;
        console.log(`-> ${name} (${IS_LINKEDIN ? 'LinkedIn: ' + igHandle : '@' + igHandle})`);

        if (!igHandle) {
          console.log(`  No ${IS_LINKEDIN ? 'LinkedIn URL' : 'IG handle'} — skipping`);
          results.skipped++;
          leadTimings.push({ name, duration: (Date.now() - leadStart) / 1000, status: 'skip' });
          continue;
        }

        // Crash-proof dedup check (local file)
        const sentFile = IS_LINKEDIN ? LI_DM_SENT_FILE : DM_SENT_FILE;
        if (wasLeadDmSentToday(leadId, sentFile)) {
          console.log('  Already sent today — skipping');
          results.skipped++;
          leadTimings.push({ name, duration: (Date.now() - leadStart) / 1000, status: 'skip' });
          continue;
        }

        // ── OUTREACH MESSAGE DEDUP: skip if DM'd in last 3 days ──
        try {
          const omRes = await fetch(
            `${apiBase}/api/v1/leads/${leadId}/outreach/messages?direction=outbound`,
            { headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' } }
          );
          if (omRes.ok) {
            const omData = await omRes.json();
            const msgs = (omData.messages || []).filter((m: any) => m.type === 'instagram_dm');
            const threeDaysAgo = Date.now() - (3 * 24 * 60 * 60 * 1000);
            const recent = msgs.find((m: any) => new Date(m.sent_at || m.created_at).getTime() > threeDaysAgo);
            if (recent) {
              const age = Math.round((Date.now() - new Date(recent.sent_at || recent.created_at).getTime()) / (24*60*60*1000) * 10) / 10;
              console.log(`  ⏭️  Already DM'd ${age}d ago — skipping (anti-spam)`);
              results.skipped++;
              leadTimings.push({ name, duration: (Date.now() - leadStart) / 1000, status: 'skip' });
              continue;
            }
          }
        } catch (omErr: any) {
          console.log(`  ⛔ DEDUP CHECK FAILED (outreach messages): ${omErr.message} — skipping to be safe`);
          results.skipped++;
          leadTimings.push({ name, duration: (Date.now() - leadStart) / 1000, status: 'skip' });
          continue;
        }

        // ── NOTE-BASED DEDUP FALLBACK: check [SOM DM] or [SOM FAIL] notes ──
        // [SOM DM]: skip entirely (already contacted from this account — no time limit)
        // [SOM FAIL]: skip for 3 days (auto-retry after cooldown)
        try {
          const notes = leadData.notes || [];
          const threeDaysAgo = Date.now() - (3 * 24 * 60 * 60 * 1000);
          const recentNote = notes.find((n: any) => {
            const content = n.content || n.message || '';
            if (content.includes('[SOM DM]')) return true; // always skip — already DM'd
            if (content.includes('[SOM FAIL]')) return new Date(n.created_at).getTime() > threeDaysAgo; // 3-day cooldown
            return false;
          });
          if (recentNote) {
            const noteContent = recentNote.content || recentNote.message || '';
            const age = Math.round((Date.now() - new Date(recentNote.created_at).getTime()) / (24*60*60*1000) * 10) / 10;
            const reason = noteContent.includes('[SOM FAIL]') ? `failed ${age}d ago (cooldown)` : `DM'd ${age}d ago`;
            console.log(`  ⏭️  ${reason} — skipping`);
            results.skipped++;
            leadTimings.push({ name, duration: (Date.now() - leadStart) / 1000, status: 'skip' });
            continue;
          }
        } catch (noteErr: any) {
          console.log(`  ⛔ DEDUP CHECK FAILED (note scan): ${noteErr.message} — skipping to be safe`);
          results.skipped++;
          leadTimings.push({ name, duration: (Date.now() - leadStart) / 1000, status: 'skip' });
          continue;
        }

        // ── INITIALIZE OUTREACH STEPS (mirrors "Apply Strategy" in V1 UI) ──
        // Creates the 5-step strategy so the lead exits the "fresh" pool.
        // DRY RUN: skip — don't mutate the database, just check existing state.
        let stepId: number | null = null;
        if (!DRY_RUN) {
          try {
            const initRes = await fetch(
              `${apiBase}/api/v1/leads/${leadId}/outreach-steps/initialize-strategy`,
              { method: 'POST', headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ strategy_key: IS_LINKEDIN ? 'linkedin-first' : 'instagram-first' }) }
            );
            const initData: any = await initRes.json();
            if (initRes.ok) {
              const steps = initData.data?.steps || [];
              stepId = steps[0]?.id || null;
              console.log(`  ✓ Outreach steps initialized (${steps.length} steps, step1 id=${stepId})`);
            } else if (initRes.status === 400 && initData.message?.includes('already has')) {
              // Steps exist — fetch step 1 ID for completion later
              const stepsRes = await fetch(
                `${apiBase}/api/v1/leads/${leadId}/outreach-steps`,
                { headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' } }
              );
              const stepsData: any = await stepsRes.json();
              const steps = stepsData.data?.steps || [];
              stepId = steps[0]?.id || null;
              const completed = steps[0]?.is_completed;
              if (completed) {
                console.log(`  ⏭️  Step 1 already completed — skipping`);
                results.skipped++;
                leadTimings.push({ name, duration: (Date.now() - leadStart) / 1000, status: 'skip' });
                continue;
              }
              console.log(`  Steps already exist (step1 id=${stepId})`);
            } else {
              console.log(`  ⚠ Failed to initialize outreach: ${initData.message} — skipping`);
              results.skipped++;
              leadTimings.push({ name, duration: (Date.now() - leadStart) / 1000, status: 'skip' });
              continue;
            }
          } catch (initErr: any) {
            console.log(`  ⛔ Initialize outreach failed: ${initErr.message} — skipping`);
            results.skipped++;
            leadTimings.push({ name, duration: (Date.now() - leadStart) / 1000, status: 'skip' });
            continue;
          }
        } else {
          console.log(`  [DRY RUN] Would initialize outreach steps`);
        }

        // Generate message — same flow as V1 "Vary It" button:
        // 1. Get strategy script from outreach-strategy-templates (the REAL SOM scripts)
        // 2. Call generate-personalized-message with script + lead handle + name
        let msg = '';
        try {
          // Fetch strategy templates for this board
          const stratRes = await fetch(
            `${apiBase}/api/v1/bloqs/${BOARD_ID}/outreach-strategy-templates`,
            { headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' } }
          );
          let scriptText = '';
          if (stratRes.ok) {
            const stratData = (await stratRes.json()) as any;
            const templates = stratData.data?.templates || [];
            // Find matching strategy by name
            const strat = templates.find((t: any) => t.name === STRATEGY_NAME);
            if (strat?.steps?.[0]) {
              scriptText = strat.steps[0].instructions || '';
              console.log(`  Strategy script: "${scriptText.substring(0, 60)}..."`);
            }
          }

          if (scriptText) {
            // Use the same endpoint as V1's "Vary It" button
            const msgRes = await fetch(
              `${apiBase}/api/v1/ai/generate-personalized-message`,
              {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({
                  script_message: scriptText,
                  instagram_handle: igHandle,
                  lead_name: name,
                }),
              }
            );
            if (msgRes.ok) {
              const msgData = (await msgRes.json()) as any;
              msg = msgData.data?.message || msgData.message || '';
            }
          }

          if (!msg && scriptText) {
            // AI variation failed — use the raw script as-is (better than generic fallback)
            msg = scriptText;
            console.log(`  ⚠ AI variation failed — using raw script`);
          }

          if (!msg) {
            console.log(`  ⚠ Strategy script not found — using fallback`);
          }
        } catch (msgErr: any) {
          console.log(`  ⚠ Message generation failed: ${msgErr.message} — using fallback`);
        }
        if (!msg) {
          msg = `Hey ${name}! Noticed you're doing some interesting work. Would love to connect.`;
        }
        console.log(`-> Msg: "${msg.substring(0, 60)}..."`);

        // Navigate directly to profile
        const igPage = await context.newPage();
        const profileUrl = IS_LINKEDIN
          ? (linkedInFullUrl.startsWith('http') ? linkedInFullUrl : `https://www.linkedin.com/in/${igHandle}/`)
          : `https://www.instagram.com/${igHandle}/`;
        await igPage.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await igPage.waitForTimeout(3000);

        // Session check
        const igUrl = igPage.url();
        if (igUrl.includes('/accounts/login') || igUrl.includes('/challenge/')) {
          console.log('SESSION EXPIRED — aborting batch');
          await igPage.close().catch(() => {});
          results.failed++;
          break;
        }

        // Dismiss popups
        for (const text of ['Not Now', 'Not now', 'Cancel', 'Dismiss']) {
          const btn = igPage.locator(`button:has-text("${text}")`).first();
          if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
            await btn.click().catch(() => {});
            await igPage.waitForTimeout(500);
          }
        }

        // ── Full IG DM interaction (Paths A/B/C — same logic as main flow) ──
        const dismissIgPopup = async () => {
          for (const text of ['Not Now', 'Not now', 'Cancel', 'Dismiss']) {
            const btn = igPage.locator(`button:has-text("${text}")`).first();
            if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
              await btn.click().catch(() => {});
              await igPage.waitForTimeout(500);
            }
          }
        };

        // Check if account exists
        const notFound = await igPage.locator('text=Sorry, this page').isVisible().catch(() => false);
        if (notFound) {
          console.log('  Account not found — skipping');
          results.failed++;
          await igPage.close().catch(() => {});
          leadTimings.push({ name, duration: (Date.now() - leadStart) / 1000, status: 'fail' });
          continue;
        }

        // ── SCRAPE PROFILE (bio, followers, name) — save to notes + custom_fields ──
        if (!IS_LINKEDIN) {
          try {
            const profileStats = await scrapeProfileStats(igPage);
            if (profileStats && (profileStats.followers > 0 || profileStats.bio)) {
              console.log(`  Profile: ${profileStats.displayName || igHandle} | ${profileStats.followers.toLocaleString()} followers | ${profileStats.bio?.substring(0, 50) || 'no bio'}...`);
              if (!DRY_RUN && leadId) {
                // Save to notes
                const statsNote = [
                  `[SOM Inline Enrich]`,
                  profileStats.displayName ? `Name: ${profileStats.displayName}` : '',
                  `Followers: ${profileStats.followers.toLocaleString()}`,
                  `Posts: ${profileStats.posts.toLocaleString()}`,
                  profileStats.bio ? `Bio: ${profileStats.bio.substring(0, 200)}` : '',
                  profileStats.externalUrl ? `URL: ${profileStats.externalUrl}` : '',
                  profileStats.category ? `Category: ${profileStats.category}` : '',
                ].filter(Boolean).join(' | ');
                apiClient.addNote(leadId, statsNote, 'enrichment').catch(() => {});
                // Save to custom_fields
                apiClient.updateLead(leadId, {
                  custom_fields: {
                    ig_followers: profileStats.followers,
                    ig_following: profileStats.following,
                    ig_posts: profileStats.posts,
                    ig_bio: profileStats.bio?.substring(0, 500),
                    ig_display_name: profileStats.displayName,
                    ig_external_url: profileStats.externalUrl,
                    ig_category: profileStats.category,
                    ig_verified: profileStats.isVerified,
                    ig_scraped_at: new Date().toISOString(),
                  },
                }).catch(() => {});
              }
            }
          } catch (scrapeErr: any) {
            console.log(`  ⚠ Profile scrape failed: ${scrapeErr.message}`);
          }
        }

        // ── WARMUP: like posts + follow before DM (mirrors V1) ──
        if (WARMUP) {
          try {
            if (IS_LINKEDIN) {
              // LinkedIn warmup: dwell on profile (no likes/follow — LinkedIn detects automation)
              console.log('  Warmup: viewing LinkedIn profile...');
              await igPage.waitForTimeout(3000 + Math.random() * 3000);
              console.log(`    ${DRY_RUN ? '[DRY] Would view' : 'Viewed'} profile for dwell time`);
            } else {
          console.log(`  Warmup: liking ${WARMUP_LIKES} posts${WARMUP_FOLLOW ? ' + follow' : ''}...`);
            // Like posts
            for (let likeIdx = 0; likeIdx < WARMUP_LIKES; likeIdx++) {
              const postLinks = igPage.locator('a[href*="/p/"], a[href*="/reel/"]');
              const postCount = await postLinks.count().catch(() => 0);
              if (likeIdx >= postCount) break;
              await postLinks.nth(likeIdx).click();
              await igPage.waitForTimeout(1500);
              const alreadyLiked = igPage.locator('svg[aria-label="Unlike"]').first();
              const likeBtn = igPage.locator('svg[aria-label="Like"]').first();
              if (await alreadyLiked.isVisible({ timeout: 2000 }).catch(() => false)) {
                console.log(`    Post ${likeIdx + 1} already liked`);
              } else if (await likeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                if (!DRY_RUN) await likeBtn.click();
                console.log(`    ${DRY_RUN ? '[DRY] Would like' : 'Liked'} post ${likeIdx + 1}`);
              }
              await igPage.goBack();
              await igPage.waitForTimeout(1000);
            }
            // Follow
            if (WARMUP_FOLLOW) {
              const followBtn = igPage.locator('button:text-is("Follow")').first();
              if (await followBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                if (!DRY_RUN) await followBtn.click();
                console.log(`    ${DRY_RUN ? '[DRY] Would follow' : 'Followed'} @${igHandle}`);
              } else {
                console.log('    Already following or follow button not found');
              }
            }
            // Cooldown
            const cooldown = 3000 + Math.random() * 4000;
            await igPage.waitForTimeout(cooldown);
            } // end else (IG warmup)
          } catch (warmupErr: any) {
            console.log(`    Warmup error: ${warmupErr.message} — continuing to DM`);
          }
        }

        let inDMView = false;

        // ── LINKEDIN DM PATH ──
        if (IS_LINKEDIN) {
          // LinkedIn profile page: click "Message" button → opens messaging overlay
          const liMsgBtn = igPage.locator('button:has-text("Message"), a:has-text("Message")').first();
          if (await liMsgBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            console.log('  Clicking LinkedIn Message button...');
            await liMsgBtn.click();
            await igPage.waitForTimeout(3000);
            // Dismiss any LinkedIn popups
            for (const text of ['Dismiss', 'Not now', 'No thanks', 'Got it']) {
              const btn = igPage.locator(`button:has-text("${text}")`).first();
              if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
                await btn.click().catch(() => {});
                await igPage.waitForTimeout(500);
              }
            }
            inDMView = true;
          } else {
            // Try "Connect" first, then message
            const connectBtn = igPage.locator('button:has-text("Connect")').first();
            if (await connectBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
              console.log('  No Message button — trying Connect first...');
              if (!DRY_RUN) {
                await connectBtn.click();
                await igPage.waitForTimeout(1500);
                // Look for "Add a note" option in the connect dialog
                const addNote = igPage.locator('button:has-text("Add a note")').first();
                if (await addNote.isVisible({ timeout: 2000 }).catch(() => false)) {
                  await addNote.click();
                  await igPage.waitForTimeout(1000);
                  inDMView = true;
                  console.log('  Connect → Add a note (will send as connection request)');
                } else {
                  // Just send connection request without note
                  const sendBtn = igPage.locator('button:has-text("Send"), button[aria-label="Send now"]').first();
                  if (await sendBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                    await sendBtn.click();
                    console.log('  Sent connection request (no message)');
                  }
                  console.log('  Cannot DM — not connected. Connection request sent.');
                  results.failed++;
                  await igPage.close().catch(() => {});
                  leadTimings.push({ name, duration: (Date.now() - leadStart) / 1000, status: 'fail' });
                  continue;
                }
              } else {
                console.log('  [DRY RUN] Would click Connect → Add a note');
                results.failed++;
                await igPage.close().catch(() => {});
                leadTimings.push({ name, duration: (Date.now() - leadStart) / 1000, status: 'fail' });
                continue;
              }
            } else {
              console.log('  No Message or Connect button found — skipping');
              results.failed++;
              await igPage.close().catch(() => {});
              leadTimings.push({ name, duration: (Date.now() - leadStart) / 1000, status: 'fail' });
              continue;
            }
          }
        }

        // ── INSTAGRAM DM PATHS (skip if LinkedIn already handled above) ──
        if (!IS_LINKEDIN) {

        // PATH A: Already in DM view
        const earlyDmInput = igPage.locator('div[aria-label*="Message"][contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea[placeholder*="Message"], p[data-lexical-text], p[placeholder*="Message"]').first();
        if (igPage.url().includes('/direct/') || await earlyDmInput.isVisible({ timeout: 2000 }).catch(() => false)) {
          console.log('  Direct DM view detected');
          inDMView = true;
        }

        // PATH B: Profile has "Message" button (public account or already following)
        if (!inDMView) {
          // Broader selector — IG renders Message button as button, div[role=button], or header link
          const messageBtn = igPage.locator('button:text-is("Message"), div[role="button"]:text-is("Message"), a:text-is("Message"), header button:has-text("Message")').first();
          if (await messageBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            console.log('  Clicking Message button...');
            await messageBtn.click();
            await igPage.waitForTimeout(3000);
            await dismissIgPopup();
            // Verify we're now in DM view (URL changed or input appeared)
            const dmInputCheck = igPage.locator('div[aria-label*="Message"][contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea[placeholder*="Message"], p[data-lexical-text]').first();
            if (igPage.url().includes('/direct/') || await dmInputCheck.isVisible({ timeout: 3000 }).catch(() => false)) {
              inDMView = true;
            } else {
              console.log('  Message button clicked but DM view not opened — trying PATH C');
            }
          }
        }

        // PATH C: Options menu → "Send message" (for accounts we don't follow)
        if (!inDMView) {
          const dotsClicked = await (async () => {
            for (const label of ['Options', 'More options']) {
              const svg = igPage.locator(`svg[aria-label="${label}"]`).first();
              if (await svg.isVisible({ timeout: 2000 }).catch(() => false)) {
                await svg.click();
                return true;
              }
            }
            const dotsBtn = igPage.locator('div[role="button"]:has(svg circle)').first();
            if (await dotsBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
              await dotsBtn.click();
              return true;
            }
            return false;
          })();

          if (dotsClicked) {
            await igPage.waitForTimeout(1000);
            const sendMsg = igPage.locator('text=Send message').first();
            if (await sendMsg.isVisible({ timeout: 3000 }).catch(() => false)) {
              console.log('  Options -> Send message...');
              await sendMsg.click();
              await igPage.waitForTimeout(2000);
              inDMView = true;
            } else {
              // Try following first, then retry
              console.log('  No "Send message" — trying Follow first...');
              await igPage.locator('text=Cancel').first().click().catch(() => {});
              await igPage.waitForTimeout(500);
              const followBtn = igPage.locator('button:text-is("Follow")').first();
              if (await followBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                await followBtn.click();
                await igPage.waitForTimeout(2000);
                console.log('  Followed! Retrying Send message...');
                // Re-open options
                for (const label of ['Options', 'More options']) {
                  const svg = igPage.locator(`svg[aria-label="${label}"]`).first();
                  if (await svg.isVisible({ timeout: 2000 }).catch(() => false)) {
                    await svg.click();
                    await igPage.waitForTimeout(1000);
                    const retrySend = igPage.locator('text=Send message').first();
                    if (await retrySend.isVisible({ timeout: 3000 }).catch(() => false)) {
                      await retrySend.click();
                      await igPage.waitForTimeout(2000);
                      inDMView = true;
                    }
                    break;
                  }
                }
              }
              if (!inDMView) {
                // Last-resort: check if DM input is visible anywhere on the page
                const lastResortInput = igPage.locator('div[aria-label*="Message"][contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea[placeholder*="Message"], p[data-lexical-text]').first();
                if (await lastResortInput.isVisible({ timeout: 2000 }).catch(() => false)) {
                  console.log('  DM input found (last-resort check)');
                  inDMView = true;
                } else {
                  console.log('  Cannot DM this account — skipping');
                  results.failed++;
                  if (leadId) {
                    apiClient.addNote(leadId, `[SOM FAIL] Cannot open DM for @${igHandle} via @${IG_ACCOUNT} — account may be private or DM-restricted`).catch(() => {});
                  }
                  await igPage.close().catch(() => {});
                  leadTimings.push({ name, duration: (Date.now() - leadStart) / 1000, status: 'fail' });
                  continue;
                }
              }
            }
          } else {
            console.log('  No options button found — skipping');
            results.failed++;
            if (leadId) {
              apiClient.addNote(leadId, `[SOM FAIL] No options button for @${igHandle} via @${IG_ACCOUNT}`).catch(() => {});
            }
            await igPage.close().catch(() => {});
            leadTimings.push({ name, duration: (Date.now() - leadStart) / 1000, status: 'fail' });
            continue;
          }
        }
        } // end if (!IS_LINKEDIN) — IG paths

        // ── TYPE & SEND DM ──
        if (inDMView) {
          await igPage.waitForTimeout(800);

          // Dismiss "Turn on Notifications" overlay that blocks DM input on ALL accounts
          // Instagram shows this as a dialog/modal with "Turn On" and "Not Now" buttons
          for (let popupAttempt = 0; popupAttempt < 3; popupAttempt++) {
            const notNow = igPage.locator('button:has-text("Not Now"), button:has-text("Not now"), button:has-text("Cancel")').first();
            if (await notNow.isVisible({ timeout: 2000 }).catch(() => false)) {
              await notNow.click();
              console.log('  → Dismissed notifications popup');
              await igPage.waitForTimeout(1000);
            } else {
              // Also try clicking outside the dialog or pressing Escape to close any overlay
              const dialog = igPage.locator('[role="dialog"]').first();
              if (await dialog.isVisible({ timeout: 500 }).catch(() => false)) {
                await igPage.keyboard.press('Escape');
                console.log('  → Closed dialog via Escape');
                await igPage.waitForTimeout(500);
              } else {
                break;
              }
            }
          }

          if (!IS_LINKEDIN) await dismissIgPopup();
          // DM input selectors: IG uses aria-label="Message", LinkedIn uses role="textbox" in messaging overlay
          const dmInput = igPage.locator(IS_LINKEDIN
            ? 'div[role="textbox"][contenteditable="true"], div[aria-label*="Write a message"][contenteditable="true"], div.msg-form__contenteditable[contenteditable="true"]'
            : 'div[aria-label*="Message"][contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea[placeholder*="Message"], p[data-lexical-text], p[placeholder*="Message"]'
          ).first();

          if (await dmInput.isVisible({ timeout: 5000 }).catch(() => false)) {
            await dmInput.click();
            await dmInput.fill(msg).catch(async () => {
              await igPage.keyboard.type(msg, { delay: 15 });
            });
            await igPage.waitForTimeout(1000);

            if (DRY_RUN) {
              await igPage.screenshot({ path: `test-results/screenshots/api-direct-dry-${idx + 1}.png` }).catch(() => {});
              console.log(`  [DRY RUN] Message typed to @${igHandle}: "${msg.substring(0, 50)}..."`);
              results.sent++;
            } else {
              const sendBtn = igPage.locator('button:has-text("Send"):not([disabled])').first();
              if (await sendBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                await sendBtn.click();
              } else {
                await igPage.keyboard.press('Enter');
              }

              // ── DELIVERY CONFIRMATION: verify message appeared in chat ──
              await igPage.waitForTimeout(2000);
              const msgSnippet = msg.substring(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const delivered = await igPage.locator(`div[dir="auto"]:text-matches("${msgSnippet}", "i")`).first()
                .isVisible({ timeout: 3000 }).catch(() => false);

              if (delivered) {
                console.log('  DM sent!');
                results.sent++;
                recordDmSent(leadId);
                if (leadId) {
                  let recOk = false;
                  for (let att = 0; att < 3; att++) {
                    try {
                      const rr = await apiClient.recordDmSent(leadId, {
                        message: msg,
                        channel_account: IG_ACCOUNT,
                        campaign_name: STRATEGY_NAME,
                        bloq_id: BOARD_ID,
                        ig_handle: igHandle,
                        step_index: 0,
                      });
                      if (rr.success) { recOk = true; break; }
                      console.log(`  ⚠ recordDmSent attempt ${att + 1} failed: ${rr.message}`);
                    } catch (e: any) {
                      console.log(`  ⚠ recordDmSent attempt ${att + 1} error: ${e.message}`);
                    }
                    if (att < 2) await igPage.waitForTimeout(1000);
                  }
                  if (!recOk) console.log(`  ⛔ CRITICAL: Failed to record DM after 3 attempts!`);

                  if (stepId) {
                    try {
                      const cr = await apiClient.completeStep(leadId, stepId, process.env.STRATEGY);
                      if (cr.success) console.log(`  ✓ Step 1 completed via API`);
                      else console.log(`  ⚠ Step complete failed: ${cr.message}`);
                    } catch (stepErr: any) {
                      console.log(`  ⚠ Step complete error: ${stepErr.message}`);
                    }
                  }

                  try {
                    const enrichResp = await apiClient.quickEnrichInstagram(leadId);
                    if (enrichResp.success && enrichResp.contacts) {
                      const emails = enrichResp.contacts.emails || [];
                      const phones = enrichResp.contacts.phones || [];
                      if (emails.length > 0 || phones.length > 0) {
                        console.log(`  ✓ Enriched: ${emails.length} emails, ${phones.length} phones`);
                      }
                    }
                  } catch (enrichErr: any) {
                    console.log(`  ⚠ Enrich failed: ${enrichErr.message}`);
                  }
                }
              } else {
                console.log('  ⛔ DM not confirmed in chat — skipping note + step');
                results.failed++;
                // Record [SOM FAIL] so dedup skips this lead for 3 days (auto-retry after)
                if (leadId) {
                  apiClient.addNote(leadId, `[SOM FAIL] DM to @${igHandle} via @${IG_ACCOUNT} — message typed but not confirmed in chat`).catch(() => {});
                }
              }
            }
          } else {
            console.log('  No DM input found in view');
            results.failed++;
            // Record [SOM FAIL] for leads where DM view couldn't be opened
            if (leadId) {
              apiClient.addNote(leadId, `[SOM FAIL] Could not open DM view for @${igHandle} via @${IG_ACCOUNT} — account may be private or DM-restricted`).catch(() => {});
            }
          }
        }
        await igPage.close().catch(() => {});

        // leadTimings status is set by the catch block for errors; for normal flow, derive from results
        leadTimings.push({ name, duration: (Date.now() - leadStart) / 1000, status: 'sent' });
      } catch (err: any) {
        console.log(`Error: ${err.message?.substring(0, 100)}`);
        results.failed++;
        leadTimings.push({ name: `#${leadId}`, duration: (Date.now() - leadStart) / 1000, status: 'fail' });
      }

      // Human-like delay between leads
      if (idx < apiLeadIds.length - 1) {
        const delay = 4000 + Math.random() * 6000;
        await page.waitForTimeout(delay);
      }
    }

    // Summary
    const totalDuration = ((Date.now() - batchStart) / 1000).toFixed(1);
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(DRY_RUN ? '  DRY RUN COMPLETE (API-DIRECT)' : '  BATCH COMPLETE (API-DIRECT)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  Board: ${BOARD_ID}  |  Strategy: ${STRATEGY_NAME}`);
    console.log(`  ${DRY_RUN ? 'Would send' : 'Sent'}: ${results.sent}  |  Skip: ${results.skipped}  |  Fail: ${results.failed}`);
    console.log(`  Total: ${totalDuration}s`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Discord batch summary with inbox replies
    await sendDiscordBatchSummary({
      sent: results.sent, skipped: results.skipped, failed: results.failed,
      duration: totalDuration, boardId: BOARD_ID, strategy: STRATEGY_NAME,
      igAccount: IG_ACCOUNT, replies: inboxReplies, leadTimings,
    });
    return; // Done — skip the UI-based processing below
  }

  const skippedCount = scannedUpTo - eligibleRows.length;
  const filterLabel = OUTREACH_FILTER === 'new' ? ' [new only]' : OUTREACH_FILTER === 'followup' ? ' [follow-up only]' : '';
  const modeLabel = IS_AUTO_STEP ? 'eligible (auto mode)' : FIXED_STEP === 1 ? 'without outreach' : 'with outreach started';
  console.log(`\n✓ ${eligibleRows.length} leads ${modeLabel}${filterLabel} (skipping ${skippedCount})\n`);
  if (eligibleRows.length === 0) {
    const apiCount = apiFilteredIds ? apiFilteredIds.size : 0;
    const exhaustedMsg = apiFilteredIds && apiCount === 0
      ? `All leads on board have outreach assigned (API confirmed: 0 fresh leads).`
      : `All ${scannedUpTo} visible leads have outreach (${apiCount} fresh via API but not visible in current page).`;
    console.log(`⚠️  ${exhaustedMsg}`);
    const alert = `🚨 **SOM — Leads Exhausted**\n📋 Board: \`${BOARD_ID}\` | Strategy: \`${STRATEGY_NAME}\` | Account: \`@${IG_ACCOUNT}\`\n✅ ${exhaustedMsg}\n⚡ Run \`npm run leadgen:${IG_ACCOUNT}\` to discover more leads.`;
    await sendDiscordAlert(alert);
    return;
  }

  const results = { sent: 0, skipped: 0, failed: 0, repliedSkipped: 0 };
  const repliedLeads: { name: string; id: number | null; igHandle: string | null }[] = [];
  const leadTimings: { name: string; duration: number; status: string }[] = [];
  const batchStart = Date.now();
  // Cap to both LEADS_TO_PROCESS and remaining daily DM quota
  const effectiveLimit = DRY_RUN ? LEADS_TO_PROCESS : Math.min(LEADS_TO_PROCESS, dmsRemaining);
  if (effectiveLimit < LEADS_TO_PROCESS && !DRY_RUN) {
    console.log(`⚠️  Capping batch from ${LEADS_TO_PROCESS} to ${effectiveLimit} (daily DM quota)\n`);
  }
  // Pre-filter: remove rows where the lead has no usable contact channel.
  // For LinkedIn campaigns: filter by data-linkedin-url instead of data-ig-handle.
  // Reads each row's data attributes directly from the rendered DOM (no API call, no 200-cap).
  const dmableRows: number[] = [];
  for (const rowIdx of eligibleRows) {
    if (dmableRows.length >= effectiveLimit) break;
    const row = page.locator('table tbody tr').nth(rowIdx);
    const btn = row.locator('button.text-gray-300, button.text-white').first();
    const rowName = (await btn.textContent().catch(() => ''))?.trim() || '';
    if (!rowName) { dmableRows.push(rowIdx); continue; } // can't determine — let it through
    const rowAttrs = await readRowAttrs(row);
    if (IS_LINKEDIN) {
      if (rowAttrs.linkedinUrl) {
        dmableRows.push(rowIdx);
      } else {
        console.log(`⏭️  Pre-filter: "${rowName}" — no LinkedIn URL, skipping`);
      }
    } else {
      const rowNameIsHandle = !rowName.includes(' ') && /^[a-z0-9._]+$/i.test(rowName);
      if (rowNameIsHandle || rowAttrs.igHandle) {
        dmableRows.push(rowIdx);
      } else {
        console.log(`⏭️  Pre-filter: "${rowName}" — no IG handle, skipping`);
      }
    }
  }
  if (dmableRows.length < effectiveLimit && eligibleRows.length > dmableRows.length) {
    const channelLabel = IS_LINKEDIN ? 'LinkedIn URLs' : 'IG handles';
    console.log(`⚠️  Only ${dmableRows.length}/${effectiveLimit} leads have ${channelLabel} on this page`);
  }
  const toProcess = dmableRows;

  for (let idx = 0; idx < toProcess.length; idx++) {
    const rowIndex = toProcess[idx];
    const leadStart = Date.now();
    let dmSentThisLead = false;
    console.log(`\n━━━ Lead ${idx + 1}/${toProcess.length} (row ${rowIndex + 1}) ━━━\n`);

    try {
      // ── 1. CLICK LEAD ──
      const rowLocator = page.locator('table tbody tr').nth(rowIndex);
      const btn = rowLocator.locator('button.text-gray-300, button.text-white').first();
      const name = (await btn.textContent().catch(() => ''))?.trim() || `lead ${rowIndex + 1}`;
      console.log(`→ ${name}`);

      // Read eligibility from the rendered row (no API). Source of truth: BloqLeadsTab.vue.
      const rowAttrs = await readRowAttrs(rowLocator);

      // ── PRE-CHECK: Skip if outreach already assigned (orange badge = outreach steps exist) ──
      // NOTE: hasDmNote alone is NOT sufficient — a lead can have a [SOM DM] note from
      // a previous API-direct run but no outreach steps (so no orange badge, still shows "Fresh").
      // The authoritative check is outreachCount > 0 (steps assigned via Apply Strategy).
      if (rowAttrs.outreachCount > 0) {
        console.log(`⏭️  Outreach already assigned (${rowAttrs.outreachCount} steps) — skipping`);
        leadTimings.push({ name, duration: 0, status: 'skip' });
        results.skipped++; continue;
      }
      if (rowAttrs.hasDmNote && OUTREACH_FILTER === 'new') {
        console.log(`⏭️  Has DM note but no outreach steps — previously DM'd without strategy, skipping`);
        leadTimings.push({ name, duration: 0, status: 'skip' });
        results.skipped++; continue;
      }

      // ── CRASH-PROOF IDEMPOTENCY: Skip if we sent to this lead today (local file) ──
      // This catches the case where DM was sent but crash happened before API note was recorded.
      if (rowAttrs.id) {
        const sentFile = IS_LINKEDIN ? LI_DM_SENT_FILE : DM_SENT_FILE;
        if (wasLeadDmSentToday(rowAttrs.id, sentFile)) {
          console.log(`⏭️  Already sent today (crash-proof check) — skipping lead #${rowAttrs.id}`);
          leadTimings.push({ name, duration: 0, status: 'skip' });
          results.skipped++; continue;
        }
      }

      // Reply detection (#67772): skip leads who already replied — they need manual follow-up
      if (rowAttrs.hasReply) {
        console.log(`⏭️  Lead REPLIED (UI badge) — skipping automated outreach (handle manually)`);
        repliedLeads.push({ name, id: rowAttrs.id, igHandle: rowAttrs.igHandle });
        leadTimings.push({ name, duration: 0, status: 'skip-replied' });
        results.skipped++; results.repliedSkipped++; continue;
      }

      // ── PRE-CHECK: Skip leads with no IG handle ──
      // Need an IG handle to DM. Sources: (1) row's data-ig-handle, or (2) name itself
      // looks like a handle (no spaces, alphanumeric + dots/underscores).
      const nameIsHandle = !name.includes(' ') && /^[a-z0-9._]+$/i.test(name);
      if (!nameIsHandle && !rowAttrs.igHandle) {
        console.log(`⏭️  No Instagram handle — skipping (name: "${name}")`);
        results.skipped++; continue;
      }

      await btn.click();

      // Wait for panel
      let opened = false;
      for (let w = 0; w < 15; w++) {
        if (await page.locator('button:has-text("Details")').first().isVisible().catch(() => false)) { opened = true; break; }
        if (w === 5) await btn.click({ force: true }); // retry at 5s
        await page.waitForTimeout(1000);
      }
      if (!opened) { console.log('⚠️  Panel failed'); results.skipped++; continue; }
      console.log('✓ Panel open');

      // ── 2. OUTREACH TAB ──
      const outreach = page.locator('button:has-text("Outreach")').first();
      if (!(await outreach.isVisible({ timeout: 5000 }).catch(() => false))) {
        console.log('⚠️  No Outreach tab');
        await page.keyboard.press('Escape'); results.skipped++; continue;
      }
      await outreach.click();
      // Poll for outreach panel content instead of fixed 5s wait
      for (let w = 0; w < 20; w++) {
        const hasPlay = await page.locator('button[title="Generate message"]').count().catch(() => 0) > 0;
        const hasApply = await page.locator('button:has-text("Apply Strategy"), button:has-text("Apply"), text=No Outreach Strategy, text=Start with Default Strategy').first().isVisible().catch(() => false);
        if (hasPlay || hasApply) break;
        await page.waitForTimeout(250);
      }

      // ── 3. APPLY STRATEGY + DETECT STEP ──
      // Wait for Outreach panel to fully render (poll for any content signal)
      // IMPORTANT: Check for existing steps BEFORE "Apply Strategy" button,
      // because "Apply Strategy" is always visible even when a strategy is already applied.
      // If we detect Apply Strategy first, we'd re-apply and reset completed steps.
      let outreachState: 'fresh' | 'has-steps' | 'has-apply' | 'unknown' = 'unknown';
      for (let w = 0; w < 15; w++) {
        // Priority 1: Check for play buttons — strategy already applied with steps
        if (await page.locator('button[title="Generate message"]').count().catch(() => 0) > 0) {
          outreachState = 'has-steps'; break;
        }
        // Priority 2: Check for step circles (✓ marks) — strategy applied, steps may be completed
        const stepCircles = page.locator('.overflow-hidden.border.border-gray-700.rounded-lg button.rounded-full');
        if (await stepCircles.count().catch(() => 0) > 0) {
          outreachState = 'has-steps'; break;
        }
        // Priority 3: Fresh lead indicators
        if (await page.locator('text=No Outreach Strategy').isVisible().catch(() => false)) {
          outreachState = 'fresh'; break;
        }
        if (await page.locator('text=Start with Default Strategy').isVisible().catch(() => false)) {
          outreachState = 'fresh'; break;
        }
        // Priority 4: Apply Strategy button (only if no steps detected above)
        if (await page.locator('button:has-text("Apply Strategy")').isVisible().catch(() => false)) {
          outreachState = 'has-apply'; break;
        }
        if (await page.locator('button:has-text("Apply")').first().isVisible().catch(() => false)) {
          outreachState = 'has-apply'; break;
        }
        if (w % 5 === 4) console.log(`  ⏳ Waiting for Outreach panel... (${w + 1}s)`);
        await page.waitForTimeout(1000);
      }
      console.log(`→ Outreach state: ${outreachState}`);

      if (outreachState === 'unknown') {
        console.log('⚠️  Outreach panel timed out');
        await page.screenshot({ path: `test-results/screenshots/outreach-timeout-${idx + 1}.png` });
        await page.keyboard.press('Escape'); results.skipped++; continue;
      }

      // For leads that already have steps, skip re-applying the strategy (prevents resetting completed steps)
      const needsStrategyApply = outreachState === 'fresh' || outreachState === 'has-apply';

      if (outreachState === 'has-steps') {
        console.log('→ Strategy already applied, detecting current step...');
      } else {
        if (outreachState === 'fresh') {
          // Fresh lead — click "Start with Default Strategy" to initialize the outreach panel.
          // This creates default steps, but we immediately replace them with the target strategy.
          const startDefault = page.locator('button:has-text("Start with Default Strategy")').first();
          if (await startDefault.isVisible({ timeout: 3000 }).catch(() => false)) {
            console.log('→ Fresh lead — Start with Default Strategy...');
            await startDefault.click();
            // Wait for outreach panel to fully initialize with default steps
            // Poll for the Apply Strategy button (appears once default steps are created)
            for (let aw = 0; aw < 20; aw++) {
              const hasApply = await page.locator('button:has-text("Apply Strategy")').first().isVisible().catch(() => false);
              const hasApplyShort = await page.locator('button:has-text("Apply")').first().isVisible().catch(() => false);
              if (hasApply || hasApplyShort) break;
              await page.waitForTimeout(500);
            }
          }
        }

        // Apply the target strategy (replaces default steps with the correct ones)
        const applyBtn = page.locator('button:has-text("Apply Strategy")').first();
        if (await applyBtn.isVisible({ timeout: 15000 }).catch(() => false)) {
          console.log('→ Apply Strategy...');
          await applyBtn.click();

          const strat = page.locator(`button:has-text("${STRATEGY_NAME}")`).first();
          if (await strat.isVisible({ timeout: 10000 }).catch(() => false)) {
            console.log(`→ Selecting ${STRATEGY_NAME}`);
            await strat.click();

            const confirm = page.locator('button.swal2-confirm').first();
            if (await confirm.isVisible({ timeout: 5000 }).catch(() => false)) {
              console.log('→ Confirming replacement...');
              await confirm.click();
              // Wait for API to create steps + UI to re-render
              for (let pw = 0; pw < 15; pw++) {
                const playCount = await page.locator('button[title="Generate message"]').count().catch(() => 0);
                if (playCount > 0) { break; }
                await page.waitForTimeout(500);
              }
            }
          } else {
            console.log('⚠️  Strategy not found in dropdown');
            await page.keyboard.press('Escape');
            results.skipped++; continue;
          }
        } else {
          console.log('⚠️  No Apply Strategy button found');
          await page.screenshot({ path: `test-results/screenshots/no-apply-btn-${idx + 1}.png` });
        }
      }

      // ── 4. DETECT CURRENT STEP + SELECT TARGET PLAY BUTTON ──
      console.log('⏳ Waiting for steps...');

      // Wait for play buttons to appear
      let totalPlayButtons = 0;
      for (let w = 0; w < 30; w++) {
        totalPlayButtons = await page.locator('button[title="Generate message"]').count().catch(() => 0);
        if (totalPlayButtons > 0) break;
        if (w % 10 === 0 && w > 0) console.log(`  ⏳ Waiting for play button... (${w}s)`);
        await page.waitForTimeout(500);
      }

      // Detect which step to execute
      let targetStepIndex = 0; // default: step 1 (0-indexed)

      if (IS_AUTO_STEP || (FIXED_STEP && FIXED_STEP > 1)) {
        // Detect completed steps by looking at step number circles
        // Completed steps show ✓, pending steps show their number (1, 2, 3...)
        // The circles are inside the strategy steps list (.overflow-hidden.border)
        const stepContainer = page.locator('.overflow-hidden.border.border-gray-700.rounded-lg').first();
        const stepCircles = stepContainer.locator('button.rounded-full');
        const totalSteps = await stepCircles.count().catch(() => 0);

        let completedCount = 0;
        let firstPendingIndex = -1;
        for (let s = 0; s < totalSteps; s++) {
          const text = (await stepCircles.nth(s).textContent().catch(() => ''))?.trim() || '';
          if (text === '✓') {
            completedCount++;
          } else if (firstPendingIndex === -1) {
            firstPendingIndex = s;
          }
        }

        console.log(`→ Steps: ${completedCount}/${totalSteps} completed, first pending: ${firstPendingIndex === -1 ? 'none (all done)' : firstPendingIndex + 1}`);

        if (IS_AUTO_STEP) {
          if (firstPendingIndex === -1 && totalSteps > 0) {
            // All steps completed — skip this lead
            console.log('⏭️  All steps completed — skipping');
            await page.keyboard.press('Escape'); results.skipped++; continue;
          }
          if (totalSteps === 0) {
            // Fresh lead with no steps — treat as step 0 (first contact)
            console.log('→ No outreach steps yet — will send first DM');
            firstPendingIndex = 0;
          }
          targetStepIndex = firstPendingIndex;
        } else if (FIXED_STEP) {
          const fixedIndex = FIXED_STEP - 1; // convert to 0-indexed
          if (fixedIndex >= totalSteps) {
            console.log(`⏭️  Step ${FIXED_STEP} doesn't exist (only ${totalSteps} steps)`);
            await page.keyboard.press('Escape'); results.skipped++; continue;
          }
          // Check if the fixed step is already completed
          const circleText = (await stepCircles.nth(fixedIndex).textContent().catch(() => ''))?.trim() || '';
          if (circleText === '✓') {
            console.log(`⏭️  Step ${FIXED_STEP} already completed — skipping`);
            await page.keyboard.press('Escape'); results.skipped++; continue;
          }
          targetStepIndex = fixedIndex;
        }
      }

      // ── PRE-SEND DEDUP: verify step isn't already completed via API ──
      // Catches cases where previous run sent the DM but crashed before UI update.
      // Lead ID comes from the row's data-lead-id (rowAttrs already loaded above).
      if (rowAttrs.id) {
        try {
          const preSendSteps = await apiClient.getSteps(rowAttrs.id);
          const checkIdx = typeof targetStepIndex === 'number' ? targetStepIndex : 0;
          const checkStep = preSendSteps[checkIdx];
          if (checkStep && (checkStep.is_completed || checkStep.completed_at)) {
            console.log(`⏭️  Step ${checkIdx + 1} already completed via API — skipping (dedup)`);
            await page.keyboard.press('Escape'); results.skipped++; continue;
          }
        } catch {}
      }

      // ── RECENT DM DEDUP: skip if we've DM'd this lead in the last 3 days ──
      // Primary: OutreachMessage records (reliable, queryable)
      // Fallback: legacy [SOM DM] notes (for pre-existing data)
      if (rowAttrs.id) {
        try {
          const threeDaysAgo = Date.now() - (3 * 24 * 60 * 60 * 1000);
          let recentDmDate: string | null = null;

          // Primary: check OutreachMessage records
          const omResult = await apiClient.getOutreachMessages(rowAttrs.id, 'outbound');
          const messages = omResult?.data?.messages || [];
          const recentMsg = messages.find((m: any) => {
            if (m.type !== 'instagram_dm') return false;
            return new Date(m.sent_at || m.created_at).getTime() > threeDaysAgo;
          });
          if (recentMsg) {
            recentDmDate = recentMsg.sent_at || recentMsg.created_at;
          }

          // Fallback: legacy note scan (catches DMs sent before OutreachMessage tracking)
          if (!recentDmDate) {
            const leadData = await apiClient.getLead(rowAttrs.id);
            const notes = leadData?.data?.notes || leadData?.notes || [];
            const recentNote = notes.find((n: any) => {
              if (!n.content || !n.content.includes('[SOM DM]')) return false;
              return new Date(n.created_at).getTime() > threeDaysAgo;
            });
            if (recentNote) recentDmDate = recentNote.created_at;
          }

          if (recentDmDate) {
            const daysAgo = Math.round((Date.now() - new Date(recentDmDate).getTime()) / (24 * 60 * 60 * 1000) * 10) / 10;
            console.log(`⏭️  Already DM'd ${daysAgo}d ago — skipping (anti-spam)`);
            await page.keyboard.press('Escape'); results.skipped++; continue;
          }
        } catch {}
      }

      console.log(`→ Executing step ${targetStepIndex + 1}`);
      if (totalPlayButtons === 0) {
        console.log('⏭️  No play buttons found after 90s');
        await page.screenshot({ path: `test-results/screenshots/no-play-${idx + 1}.png` });
        await page.keyboard.press('Escape'); results.skipped++; continue;
      }
      if (targetStepIndex >= totalPlayButtons) {
        console.log(`⏭️  Step ${targetStepIndex + 1} has no play button (${totalPlayButtons} available)`);
        await page.keyboard.press('Escape'); results.skipped++; continue;
      }
      const playBtn = page.locator('button[title="Generate message"]').nth(targetStepIndex);
      console.log('→ Play (generate message)...');
      await playBtn.click({ force: true }); // force: true bypasses opacity:0
      // Poll for message or Vary button instead of fixed 5s wait
      for (let w = 0; w < 30; w++) {
        const hasMsg = await page.locator('p.whitespace-pre-wrap').first().isVisible().catch(() => false);
        const hasVary = await page.locator('button:has-text("Vary It")').first().isVisible().catch(() => false);
        const hasPersonalize = await page.locator('button:has-text("Personalize")').first().isVisible().catch(() => false);
        const hasOpenIg = await page.locator('button:has-text("Open Instagram")').first().isVisible().catch(() => false);
        if (hasMsg || hasVary || hasPersonalize || hasOpenIg) break;
        await page.waitForTimeout(500);
      }

      // ── 6. PERSONALIZE or VARY ──
      if (VARY) {
        if (PERSONALIZE) {
          const personalize = page.locator('button:has-text("Personalize")').first();
          if (await personalize.isVisible({ timeout: 8000 }).catch(() => false)) {
            console.log('→ Personalize...');
            await personalize.click();
            for (let w = 0; w < 30; w++) {
              if (await page.locator('text=Variation').isVisible().catch(() => false)) break;
              if (await page.locator('text=Personalized').isVisible().catch(() => false)) break;
              if (w % 10 === 0 && w > 0) console.log(`  ⏳ Waiting for personalized message... (${w}s)`);
              await page.waitForTimeout(500);
            }

            const use = page.locator('button[title="Use this variation"]').first();
            if (await use.isVisible({ timeout: 8000 }).catch(() => false)) {
              console.log('→ Use personalized message...');
              await use.click();
              await page.waitForTimeout(500);
            }
          }
        } else {
          const vary = page.locator('button:has-text("Vary It")').first();
          if (await vary.isVisible({ timeout: 8000 }).catch(() => false)) {
            console.log('→ Vary It...');
            await vary.click();
            for (let w = 0; w < 20; w++) {
              if (await page.locator('text=Variation').isVisible().catch(() => false)) break;
              await page.waitForTimeout(500);
            }

            const use = page.locator('button[title="Use this variation"]').first();
            if (await use.isVisible({ timeout: 8000 }).catch(() => false)) {
              console.log('→ Use variation...');
              await use.click();
              await page.waitForTimeout(500);
            }
          }
        }
      } else {
        console.log('→ Skipping variation (VARY=false)');
      }

      // ── 8. GET MESSAGE ──
      let msg = '';
      const msgEl = page.locator('p.whitespace-pre-wrap').first();
      if (await msgEl.isVisible({ timeout: 8000 }).catch(() => false)) {
        msg = (await msgEl.textContent().catch(() => ''))?.trim() || '';
        console.log(`→ Msg: "${msg.substring(0, 60)}..."`);
      }

      // ── 9. OPEN LINKEDIN or OPEN INSTAGRAM ──
      if (IS_LINKEDIN) {
        // ── LINKEDIN SEND PATH (via DM Provider Factory) ──
        const liBtn = page.locator('button:has-text("Open LinkedIn")').first();
        if (!(await liBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
          console.log('No Open LinkedIn btn');
          results.skipped++;
        } else {
          console.log('-> Open LinkedIn & Copy...');
          const [liPage] = await Promise.all([
            context.waitForEvent('page', { timeout: 15000 }).catch(() => null as any),
            liBtn.click()
          ]);

          if (liPage) {
            await liPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
            await liPage.waitForTimeout(2000);

            // Check if session is valid
            const liUrl = liPage.url();
            if (liUrl.includes('/login') || liUrl.includes('/authwall')) {
              console.log(`\x1b[31m  SESSION EXPIRED: LinkedIn -- re-save session\x1b[0m`);
              await sendDiscordAlert(
                `**SOM LinkedIn -- Session Expired**\nBoard: \`${BOARD_ID}\`\nLinkedIn redirected to login.`
              );
              await liPage.close().catch(() => {});
              results.failed++;
              break; // Abort batch -- all leads will fail
            }

            // Use the provider factory for DM sending
            const liProvider = getDmProvider('linkedin', { dryRun: DRY_RUN });
            const target: DmTarget = {
              name,
              profileUrl: liPage.url(),
              message: msg,
              leadId: rowAttrs.id ?? undefined,
            };

            const batchResult = await liProvider.sendBatch(liPage, context, [target]);
            const dmResult = batchResult.results[0];
            if (dmResult?.status === 'sent' || dmResult?.status === 'dry_run') {
              results.sent++;
              if (dmResult.status === 'sent') recordLinkedInDmSent(rowAttrs.id);
            } else {
              results.failed++;
            }

            // Record note via API
            if (msg && rowAttrs?.id) {
              try {
                await apiClient.addNote(rowAttrs.id, `[SOM LinkedIn] ${msg}`);
                console.log('  -> Note recorded');
              } catch (err: any) {
                console.log(`  Note failed: ${err.message?.substring(0, 40)}`);
              }
            }

            await liPage.close().catch(() => {});
          }

          // Click "I've sent the message" checkbox + Complete
          const sentCheckbox = page.locator('input[type="checkbox"]').first();
          if (await sentCheckbox.isVisible({ timeout: 2000 }).catch(() => false)) {
            await sentCheckbox.check();
            await page.waitForTimeout(300);
          }
          const completeBtn = page.locator('button:has-text("Complete")').first();
          if (await completeBtn.isEnabled({ timeout: 2000 }).catch(() => false)) {
            await completeBtn.click();
            await page.waitForTimeout(1500);
            console.log('  Step completed');
          }
        }

        // Human-like delay between LinkedIn leads
        if (idx < toProcess.length - 1) {
          const delay = 5000 + Math.random() * 10000;
          console.log(`  Waiting ${(delay / 1000).toFixed(1)}s before next lead...\n`);
          await page.waitForTimeout(delay);
        }
        const leadEnd = Date.now();
        leadTimings.push({ name, duration: leadEnd - leadStart, status: results.sent > 0 ? 'sent' : 'skip' });
        continue; // Skip the Instagram path below
      }

      // ── INSTAGRAM SEND PATH ──
      let inlineProfileStats: any = null; // Hoisted — populated when on IG profile page
      const igBtn = page.locator('button:has-text("Open Instagram")').first();
      if (!(await igBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
        console.log('⏭️  No Open Instagram btn');
        results.skipped++;
      } else {
        console.log('→ Open Instagram...');
        const [igPage] = await Promise.all([
          context.waitForEvent('page', { timeout: 15000 }).catch(() => null as any),
          igBtn.click()
        ]);

        if (igPage) {
          await igPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
          await igPage.waitForTimeout(1500);

          // ── SESSION CHECK — detect if Instagram session is dead ──
          const igUrl = igPage.url();
          const isLoginPage = igUrl.includes('/accounts/login') || igUrl.includes('/challenge/');
          const hasLoginForm = await igPage.locator('input[name="username"], input[aria-label="Phone number, username, or email"]').first().isVisible({ timeout: 2000 }).catch(() => false);
          const igSplashLogout = await igPage.locator('a:has-text("Log in"), button:has-text("Log in")').first().isVisible({ timeout: 1000 }).catch(() => false)
            && !(await igPage.locator('svg[aria-label="Home"]').isVisible({ timeout: 500 }).catch(() => false));
          if (isLoginPage || hasLoginForm || igSplashLogout) {
            const errMsg = `Instagram session expired for @${IG_ACCOUNT} — re-run: IG_ACCOUNT=${IG_ACCOUNT} npx playwright test tests/e2e/save-instagram-session.spec.ts --headed`;
            console.log(`\n\x1b[31m${'='.repeat(70)}\x1b[0m`);
            console.log(`\x1b[31m  SESSION EXPIRED: @${IG_ACCOUNT}\x1b[0m`);
            console.log(`\x1b[31m  Instagram redirected to login page: ${igUrl.substring(0, 80)}\x1b[0m`);
            console.log(`\x1b[31m  Fix: IG_ACCOUNT=${IG_ACCOUNT} npx playwright test tests/e2e/save-instagram-session.spec.ts --headed\x1b[0m`);
            console.log(`\x1b[31m${'='.repeat(70)}\x1b[0m\n`);
            await igPage.screenshot({ path: `test-results/screenshots/session-expired-${IG_ACCOUNT}.png` }).catch(() => {});
            await sendDiscordAlert(
              `\u{1F6A8} **SOM — Instagram Session Expired**\n` +
              `Account: \`@${IG_ACCOUNT}\` | Board: \`${BOARD_ID}\`\n` +
              `Instagram redirected to login. Re-save session to fix.`
            );
            await igPage.close().catch(() => {});
            results.failed++;
            // Close any other IG tabs and abort this lead
            for (const p of context.pages()) {
              if (p !== page && p.url().includes('instagram.com')) await p.close().catch(() => {});
            }
            // Abort the entire batch — every lead will fail with a dead session
            console.log('Aborting batch — all remaining leads will fail with expired session.\n');
            break;
          }

          // Dismiss "Turn on Notifications" or any IG popup
          const dismissIgPopup = async () => {
            for (const text of ['Not Now', 'Not now', 'Cancel', 'Dismiss']) {
              const btn = igPage.locator(`button:has-text("${text}")`).first();
              if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
                await btn.click();
                console.log(`  → Dismissed IG popup ("${text}")`);
                await igPage.waitForTimeout(1000);
                return true;
              }
            }
            return false;
          };
          await dismissIgPopup();

          // Check if account exists
          const notFound = await igPage.locator('text=Sorry, this page').isVisible().catch(() => false);
          if (notFound) {
            console.log('  ✗ Account not found');
            results.failed++;
          } else {
            // ── INLINE ENRICHMENT — scrape profile while we're on the page ──
            try {
              const currentUrl = igPage.url();
              // Only scrape if we're on a profile page (not DM view)
              if (!currentUrl.includes('/direct/')) {
                inlineProfileStats = await scrapeProfileStats(igPage);
              }
            } catch (err: any) {
              // Non-blocking — don't fail the DM send if scrape fails
            }

            // ── BIO SCREENSHOT — always capture profile screenshot when on their page ──
            try {
              const currentUrl = igPage.url();
              if (!currentUrl.includes('/direct/')) {
                const screenshotDir = path.join(__dirname, '../../test-results/screenshots/profiles');
                fs.mkdirSync(screenshotDir, { recursive: true });
                const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
                await igPage.screenshot({
                  path: path.join(screenshotDir, `${safeName}-profile.png`),
                  fullPage: false
                });
                if (inlineProfileStats?.bio) {
                  console.log(`  📸 Bio: "${inlineProfileStats.bio.substring(0, 80)}${inlineProfileStats.bio.length > 80 ? '...' : ''}"`);
                } else {
                  console.log('  📸 Profile screenshot saved');
                }
              }
            } catch {
              // Non-blocking
            }

            // ── WARMUP — like posts + follow before sending DM ──
            if (WARMUP) {
              try {
                // Ensure we're on their profile page (not DM view)
                let warmupUrl = igPage.url();
                console.log(`  → Warmup: current URL = ${warmupUrl.substring(0, 80)}`);

                // If we landed in DM view, navigate to their profile first
                if (warmupUrl.includes('/direct/')) {
                  const profileHandle = name.replace(/^@/, '').trim();
                  const profileUrl = `https://www.instagram.com/${profileHandle}/`;
                  console.log(`  → Warmup: navigating to profile ${profileUrl}`);
                  await igPage.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
                  await igPage.waitForTimeout(3000);
                  await dismissIgPopup();
                  warmupUrl = igPage.url();
                }

                if (!warmupUrl.includes('/direct/')) {
                  // Like posts — click into each post individually
                  let postsLiked = 0;
                  for (let likeIdx = 0; likeIdx < WARMUP_LIKES; likeIdx++) {
                    // Wait for the post grid to be visible
                    await igPage.waitForTimeout(1500);

                    const postLinks = igPage.locator('a[href*="/p/"], a[href*="/reel/"]');
                    const postCount = await postLinks.count().catch(() => 0);
                    console.log(`  → Warmup: found ${postCount} posts on grid (want post ${likeIdx + 1})`);

                    if (postCount <= likeIdx) {
                      console.log(`  → Warmup: not enough posts to like`);
                      break;
                    }

                    // Click the post
                    await postLinks.nth(likeIdx).click();
                    await igPage.waitForTimeout(3000);
                    await dismissIgPopup();

                    // Try to like it
                    const likeBtn = igPage.locator('svg[aria-label="Like"]').first();
                    const alreadyLiked = igPage.locator('svg[aria-label="Unlike"]').first();

                    if (await alreadyLiked.isVisible({ timeout: 2000 }).catch(() => false)) {
                      console.log(`  → Post ${likeIdx + 1} already liked ✓`);
                      postsLiked++;
                    } else if (await likeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                      if (DRY_RUN) {
                        console.log(`  [DRY RUN] Would like post ${likeIdx + 1}`);
                        postsLiked++;
                      } else {
                        await likeBtn.click();
                        await igPage.waitForTimeout(1500);
                        const confirmed = await igPage.locator('svg[aria-label="Unlike"]').isVisible({ timeout: 2000 }).catch(() => false);
                        if (confirmed) {
                          console.log(`  ❤️  Liked post ${likeIdx + 1}!`);
                          postsLiked++;
                        } else {
                          console.log(`  ⚠️  Like may not have registered on post ${likeIdx + 1}`);
                        }
                      }
                    } else {
                      console.log(`  ⚠️  No like button found on post ${likeIdx + 1}`);
                    }

                    // Go back to profile
                    await igPage.goBack();
                    await igPage.waitForTimeout(2000);
                    await dismissIgPopup();
                  }

                  // Follow
                  if (WARMUP_FOLLOW) {
                    await igPage.waitForTimeout(1000);
                    const followBtn = igPage.locator('button:text-is("Follow")').first();
                    if (await followBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                      if (DRY_RUN) {
                        console.log('  [DRY RUN] Would click Follow');
                      } else {
                        await followBtn.click();
                        await igPage.waitForTimeout(2000);
                        console.log('  ➕ Followed!');
                      }
                    } else {
                      const alreadyFollowing = igPage.locator('button:text-is("Following"), button:text-is("Requested")').first();
                      if (await alreadyFollowing.isVisible({ timeout: 1000 }).catch(() => false)) {
                        console.log('  → Already following');
                      }
                    }
                  }

                  console.log(`  → Warmup done: ${postsLiked} posts liked`);

                  // Human-like cooldown after warmup before DM
                  const cooldown = 3000 + Math.random() * 4000;
                  await igPage.waitForTimeout(cooldown);
                } else {
                  console.log('  ⚠️  Warmup: could not navigate to profile');
                }
              } catch (err: any) {
                console.log(`  ⚠️  Warmup error: ${err.message?.substring(0, 60)}`);
              }
            }

            let inDMView = false;

            // ── PATH A: Already in DM view (URL has /direct/ or message input visible) ──
            const url = igPage.url();
            const dmInputEarly = igPage.locator('div[aria-label*="Message"][contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea[placeholder*="Message"], p[data-lexical-text], p[placeholder*="Message"]').first();
            if (url.includes('/direct/') || await dmInputEarly.isVisible({ timeout: 2000 }).catch(() => false)) {
              console.log('  → Direct DM view detected');
              inDMView = true;
            }

            // ── PATH B: Profile has "Message" button (public account) — click it ──
            if (!inDMView) {
              // Instagram uses both <button> and <div role="button"> for the Message button
              const messageBtn = igPage.locator('button:text("Message"), div[role="button"]:text("Message"), a:text("Message")').first();
              if (await messageBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                console.log('  → Public account — clicking Message...');
                await messageBtn.click();
                // Wait for navigation to DM view
                const reachedDM = await igPage.waitForURL(/\/direct\//, { timeout: 8000 }).then(() => true).catch(() => false);
                await igPage.waitForTimeout(1500);
                // Aggressively dismiss notifications popup that blocks DM input
                for (let pa = 0; pa < 3; pa++) {
                  const nn = igPage.locator('button:has-text("Not Now"), button:has-text("Not now"), button:has-text("Cancel")').first();
                  if (await nn.isVisible({ timeout: 1500 }).catch(() => false)) {
                    await nn.click();
                    console.log('  → Dismissed popup after Message click');
                    await igPage.waitForTimeout(800);
                  } else { break; }
                }
                await dismissIgPopup();
                if (reachedDM || igPage.url().includes('/direct/')) {
                  inDMView = true;
                } else {
                  const hasError = await igPage.locator('text=Something went wrong').isVisible().catch(() => false);
                  console.log(`  ✗ Message button didn't open DM view${hasError ? ' (IG error)' : ''}`);
                }
              }
            }

            // ── PATH C: On profile page — click ... then "Send message" ──
            if (!inDMView) {
              console.log('  → Profile page — opening Options...');

              // Try multiple selectors for the ... button
              const dotsClicked = await (async () => {
                // Try svg with aria-label
                for (const label of ['Options', 'More options']) {
                  const svg = igPage.locator(`svg[aria-label="${label}"]`).first();
                  if (await svg.isVisible({ timeout: 2000 }).catch(() => false)) {
                    await svg.click();
                    return true;
                  }
                }
                // Try the ... button near the username (typically a div or button after Follow)
                const dotsBtn = igPage.locator('div[role="button"]:has(svg circle)').first();
                if (await dotsBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                  await dotsBtn.click();
                  return true;
                }
                return false;
              })();

              if (dotsClicked) {
                await igPage.waitForTimeout(1000);

                // Find "Send message" in the popup — could be button, div, or span
                const sendMsg = igPage.locator('text=Send message').first();
                if (await sendMsg.isVisible({ timeout: 5000 }).catch(() => false)) {
                  console.log('  → Send message...');
                  await sendMsg.click();
                  // Wait for DM view to load (navigation to /direct/)
                  const reachedDM = await igPage.waitForURL(/\/direct\//, { timeout: 8000 }).then(() => true).catch(() => false);
                  await igPage.waitForTimeout(1500);
                  await dismissIgPopup();
                  if (reachedDM || igPage.url().includes('/direct/')) {
                    inDMView = true;
                  } else {
                    console.log('  ✗ Send message didn\'t open DM view — trying Follow first...');
                  }
                }
                // If Send message failed or wasn't available, try following then retry
                if (!inDMView) {
                  console.log('  → Trying follow first (private account or DM restricted)...');
                  await igPage.locator('text=Cancel').first().click().catch(() => {});
                  await igPage.waitForTimeout(1000);

                  const followBtn = igPage.locator('button:text-is("Follow")').first();
                  if (await followBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await followBtn.click();
                    await igPage.waitForTimeout(1500);
                    console.log('  ➕ Followed! Re-checking for Send message...');

                    // Re-open Options menu
                    const retryDots = igPage.locator('button[aria-label="Options"], svg[aria-label="Options"]').first();
                    if (await retryDots.isVisible({ timeout: 3000 }).catch(() => false)) {
                      await retryDots.click();
                      await igPage.waitForTimeout(1000);
                      const retrySendMsg = igPage.locator('text=Send message').first();
                      if (await retrySendMsg.isVisible({ timeout: 5000 }).catch(() => false)) {
                        console.log('  → Send message (after follow)...');
                        await retrySendMsg.click();
                        const retryReachedDM = await igPage.waitForURL(/\/direct\//, { timeout: 8000 }).then(() => true).catch(() => false);
                        await igPage.waitForTimeout(1500);
                        await dismissIgPopup();
                        if (retryReachedDM || igPage.url().includes('/direct/')) {
                          inDMView = true;
                        } else {
                          console.log('  ✗ Still can\'t open DM after follow');
                        }
                      } else {
                        console.log('  ✗ Still no "Send message" after follow');
                        await igPage.locator('text=Cancel').first().click().catch(() => {});
                        results.failed++;
                      }
                    } else {
                      results.failed++;
                    }
                  } else {
                    console.log('  ✗ No Follow button either — cannot DM');
                    await igPage.screenshot({ path: `test-results/screenshots/no-send-msg-${idx + 1}.png` });
                    results.failed++;
                  }
                }
              } else {
                console.log('  ✗ No ... button found');
                await igPage.screenshot({ path: `test-results/screenshots/no-dots-${idx + 1}.png` });
                results.failed++;
              }
            }

            // ── TYPE & SEND DM ──
            if (inDMView) {
              await igPage.waitForTimeout(800);
              // Aggressively dismiss "Turn on Notifications" and any other overlay blocking DM input
              for (let popupAttempt = 0; popupAttempt < 3; popupAttempt++) {
                const notNow = igPage.locator('button:has-text("Not Now"), button:has-text("Not now"), button:has-text("Cancel")').first();
                if (await notNow.isVisible({ timeout: 2000 }).catch(() => false)) {
                  await notNow.click();
                  console.log('  → Dismissed notifications popup');
                  await igPage.waitForTimeout(1000);
                } else {
                  const dialog = igPage.locator('[role="dialog"]').first();
                  if (await dialog.isVisible({ timeout: 500 }).catch(() => false)) {
                    await igPage.keyboard.press('Escape');
                    console.log('  → Closed dialog via Escape');
                    await igPage.waitForTimeout(500);
                  } else {
                    break;
                  }
                }
              }
              await dismissIgPopup();
              const dmInput = igPage.locator('div[aria-label*="Message"][contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea[placeholder*="Message"], p[data-lexical-text], p[placeholder*="Message"]').first();

              if (await dmInput.isVisible({ timeout: 8000 }).catch(() => false)) {
                const dmText = msg || 'Hey! I saw you\'re into some cool stuff. Would love to connect!';
                await dmInput.click();
                await dmInput.fill(dmText).catch(async () => {
                  // fill() can fail on contenteditable — fallback to keyboard
                  await igPage.keyboard.type(dmText, { delay: 15 });
                });
                await igPage.waitForTimeout(1000);

                if (DRY_RUN) {
                  // Screenshot the typed message but DON'T send
                  await igPage.screenshot({ path: `test-results/screenshots/dry-run-dm-${idx + 1}.png` });
                  console.log(`  [DRY RUN] Message typed but NOT sent: "${dmText.substring(0, 50)}..."`);
                  results.sent++; // count as "would have sent"
                } else {
                  // Click Send button or press Enter
                  const sendBtn = igPage.locator('button:has-text("Send"):not([disabled])').first();
                  if (await sendBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await sendBtn.click();
                  } else {
                    await igPage.keyboard.press('Enter');
                  }

                  // ── DELIVERY CONFIRMATION: verify message appeared in chat ──
                  await igPage.waitForTimeout(2000);
                  const uiMsgSnippet = dmText.substring(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                  const uiDelivered = await igPage.locator(`div[dir="auto"]:text-matches("${uiMsgSnippet}", "i")`).first()
                    .isVisible({ timeout: 3000 }).catch(() => false);

                  if (uiDelivered) {
                    console.log('  ✓ DM sent!');
                    results.sent++;
                    dmSentThisLead = true;
                    recordDmSent(rowAttrs.id);

                    if (rowAttrs.id) {
                      // Record with retry (not fire-and-forget)
                      let uiRecOk = false;
                      for (let att = 0; att < 3; att++) {
                        try {
                          const rr = await apiClient.recordDmSent(rowAttrs.id, {
                            message: dmText,
                            channel_account: IG_ACCOUNT,
                            campaign_name: STRATEGY_NAME,
                            bloq_id: BOARD_ID,
                            ig_handle: rowAttrs.igHandle,
                            step_index: typeof targetStepIndex === 'number' ? targetStepIndex : 0,
                          });
                          if (rr.success) { uiRecOk = true; break; }
                        } catch {}
                        if (att < 2) await igPage.waitForTimeout(1000);
                      }

                      // Step completion only if note recorded
                      if (uiRecOk) {
                        try {
                          const steps = await apiClient.getSteps(rowAttrs.id);
                          const stepIdx = typeof targetStepIndex === 'number' ? targetStepIndex : 0;
                          const currentStep = steps[stepIdx];
                          if (currentStep?.id) {
                            const result = await apiClient.completeStep(rowAttrs.id, currentStep.id, process.env.STRATEGY);
                            if (result.success) {
                              console.log(`  ✓ Step ${stepIdx + 1} completed via API`);
                            } else {
                              console.log(`  ⚠ Step complete failed: ${result.message}`);
                            }
                          }
                        } catch (stepErr: any) {
                          console.log(`  ⚠ Step complete error: ${stepErr.message}`);
                        }
                      }
                    }
                  } else {
                    console.log('  ⛔ DM not confirmed in chat — skipping note + step');
                    results.failed++;
                    if (rowAttrs.id) {
                      apiClient.addNote(rowAttrs.id, `[SOM FAIL] DM to @${rowAttrs.igHandle} via @${IG_ACCOUNT} — message typed but not confirmed in chat`).catch(() => {});
                    }
                  }
                }
              } else {
                console.log('  ✗ No message input found');
                await igPage.screenshot({ path: `test-results/screenshots/no-dm-input-${idx + 1}.png` });
                results.failed++;
                if (rowAttrs.id) {
                  apiClient.addNote(rowAttrs.id, `[SOM FAIL] No DM input found for @${rowAttrs.igHandle} via @${IG_ACCOUNT} — account may be private or DM-restricted`).catch(() => {});
                }
              }
            }
          }

          await igPage.close().catch(() => {});
          await page.bringToFront();
          await page.waitForTimeout(500);

          // Check "I'm done" checkbox + click Complete on HeyIRIS step card
          // DRY RUN: skip marking done so the lead stays eligible for the next real run
          if (DRY_RUN) {
            console.log('→ [DRY RUN] Skipping "Mark done" — lead stays eligible');
          } else if (dmSentThisLead) {
            try {
              // Step 1: Check the "I'm done with this" checkbox
              const checkbox = page.locator('label:has-text("I\'m done with this") input[type="checkbox"]').first();
              if (await checkbox.isVisible({ timeout: 3000 }).catch(() => false)) {
                const isChecked = await checkbox.isChecked().catch(() => false);
                if (!isChecked) {
                  await checkbox.click({ force: true });
                  await page.waitForTimeout(500);
                  console.log('→ Checked "I\'m done with this" ✓');
                }

                // Step 2: Click the "Complete" button (should now be active)
                const completeBtn = page.locator('button:has-text("Complete")').filter({ has: page.locator('i.fa-check') }).first();
                if (await completeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                  const isDisabled = await completeBtn.isDisabled().catch(() => false);
                  if (!isDisabled) {
                    await completeBtn.click();
                    await page.waitForTimeout(1000);
                    console.log('→ Clicked Complete ✓');
                  } else {
                    console.log('→ Complete button still disabled after checkbox');
                  }
                } else {
                  console.log('→ Complete button not found — relying on API completion');
                }
              } else {
                console.log('→ "I\'m done" checkbox not visible — relying on API completion');
              }
            } catch (uiErr: any) {
              console.log(`→ UI completion error: ${uiErr.message} — relying on API completion`);
            }
          }
        } else {
          console.log('  ✗ IG tab failed');
          results.failed++;
        }
      }

      // ── AUTO-ENRICH (always-on — grab contacts for email follow-up) ──
      // Lead identity + email-presence come from the row's data-* attributes (rowAttrs).
      // No more API leadMap, no more handle-fuzzy-matching — the row IS the source.
      if (!rowAttrs.id) {
        console.log(`⚠️  Lead "${name}" has no data-lead-id on row — skipping enrichment`);
      }

      // Step completion happens via UI clicks (checkbox + Complete button) above.

      if (rowAttrs.id && !rowAttrs.hasEmail) {
        enrichStats.checked++;

        // Step 1: Save inline profile stats if we scraped them from the DOM
        if (inlineProfileStats && (inlineProfileStats.followers > 0 || inlineProfileStats.bio)) {
          try {
            const statsNote = [
              `[SOM Inline Enrich]`,
              inlineProfileStats.displayName ? `Name: ${inlineProfileStats.displayName}` : '',
              `Followers: ${inlineProfileStats.followers.toLocaleString()}`,
              `Following: ${inlineProfileStats.following.toLocaleString()}`,
              `Posts: ${inlineProfileStats.posts.toLocaleString()}`,
              inlineProfileStats.bio ? `Bio: ${inlineProfileStats.bio.substring(0, 200)}` : '',
              inlineProfileStats.externalUrl ? `URL: ${inlineProfileStats.externalUrl}` : '',
              inlineProfileStats.category ? `Category: ${inlineProfileStats.category}` : '',
              inlineProfileStats.isVerified ? 'Verified: ✓' : '',
              inlineProfileStats.isPrivate ? 'Private: ✓' : '',
            ].filter(Boolean).join(' | ');
            apiClient.addNote(rowAttrs.id, statsNote, 'enrichment').catch(() => {});

            // Update lead custom_fields with profile data
            apiClient.updateLead(rowAttrs.id, {
              custom_fields: {
                ig_followers: inlineProfileStats.followers,
                ig_following: inlineProfileStats.following,
                ig_posts: inlineProfileStats.posts,
                ig_bio: inlineProfileStats.bio?.substring(0, 500),
                ig_display_name: inlineProfileStats.displayName,
                ig_external_url: inlineProfileStats.externalUrl,
                ig_category: inlineProfileStats.category,
                ig_verified: inlineProfileStats.isVerified,
                ig_private: inlineProfileStats.isPrivate,
                ig_scraped_at: new Date().toISOString(),
              }
            }).catch(() => {});
          } catch { /* non-blocking */ }
        }

        // Step 2: API enrichment for email/contact extraction
        try {
          const enrichResp = await apiClient.quickEnrichInstagram(rowAttrs.id);
          if (enrichResp.success && enrichResp.contacts) {
            enrichStats.enriched++;
            const emails = enrichResp.contacts.emails || [];
            if (emails.length > 0) {
              enrichStats.emailsFound++;
              console.log(`📧 Enriched: ${emails[0]} (score: ${enrichResp.contacts.score || 0})`);
            } else {
              console.log(`📊 Enriched: no email found (score: ${enrichResp.contacts.score || 0})`);
            }
          } else {
            console.log(`⚠️  Enrich #${rowAttrs.id}: ${enrichResp.error || 'API returned no contacts'}`);
          }
        } catch (err: any) {
          console.log(`⚠️  Enrich failed: ${err.message?.substring(0, 60)}`);
        }
      } else if (rowAttrs.hasEmail) {
        enrichStats.alreadyHad++;
        console.log(`📧 Already enriched`);
      }

      const leadDuration = ((Date.now() - leadStart) / 1000).toFixed(1);
      console.log(`✅ ${name} (${leadDuration}s)`);
      leadTimings.push({ name, duration: parseFloat(leadDuration), status: 'sent' });

      // ── CLOSE MODALS & PANEL ──
      const xClose = page.locator('text=X Close').first();
      if (await xClose.isVisible({ timeout: 1000 }).catch(() => false)) {
        await xClose.click();
        await page.waitForTimeout(1000);
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

    } catch (err: any) {
      const leadDuration = ((Date.now() - leadStart) / 1000).toFixed(1);
      console.error(`❌ Error (${leadDuration}s): ${err.message?.substring(0, 150)}`);
      leadTimings.push({ name: `lead ${rowIndex + 1}`, duration: parseFloat(leadDuration), status: 'fail' });
      await page.screenshot({ path: `test-results/screenshots/error-${idx + 1}.png` }).catch(() => {});
      results.failed++;
      try {
        for (const p of context.pages()) {
          if (p !== page && p.url().includes('instagram.com')) await p.close().catch(() => {});
        }
        await page.bringToFront();
        const xc = page.locator('text=X Close').first();
        if (await xc.isVisible({ timeout: 500 }).catch(() => false)) await xc.click().catch(() => {});
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1000);
      } catch (_) { /* page may be closed from timeout — continue to summary */ }
    }
  }

  const totalDuration = ((Date.now() - batchStart) / 1000).toFixed(1);
  const avgDuration = leadTimings.length > 0
    ? (leadTimings.reduce((sum, t) => sum + t.duration, 0) / leadTimings.length).toFixed(1)
    : '0';

  console.log('\n');
  console.log('  ██╗██████╗ ██╗███████╗');
  console.log('  ██║██╔══██╗██║██╔════╝');
  console.log('  ██║██████╔╝██║███████╗');
  console.log('  ██║██╔══██╗██║╚════██║');
  console.log('  ██║██║  ██║██║███████║');
  console.log('  ╚═╝╚═╝  ╚═╝╚═╝╚══════╝');
  console.log('  O U T R E A C H   E N G I N E');
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(DRY_RUN ? '  DRY RUN COMPLETE' : '  BATCH COMPLETE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Board: ${BOARD_ID}  |  Strategy: ${STRATEGY_NAME}`);
  console.log(`  ${DRY_RUN ? 'Would send' : 'Sent'}: ${results.sent}  |  Skip: ${results.skipped}${results.repliedSkipped ? ` (${results.repliedSkipped} replied)` : ''}  |  Fail: ${results.failed}`);
  if (enrichStats.checked > 0) {
    console.log(`  Enriched: ${enrichStats.enriched}/${enrichStats.checked}  |  Emails: ${enrichStats.emailsFound}  |  Already had: ${enrichStats.alreadyHad}`);
  }
  console.log(`  Total: ${totalDuration}s  |  Avg: ${avgDuration}s/lead`);
  if (OUTREACH_FILTER !== 'all') console.log(`  Filter: ${OUTREACH_FILTER.toUpperCase()}`);
  if (PERSONALIZE) console.log('  Mode: PERSONALIZE');
  if (!VARY) console.log('  Mode: VARY DISABLED');
  if (DRY_RUN) console.log('  Mode: DRY RUN');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Merge inbox replies + in-batch replied leads for the Discord summary
  const allReplies = [...inboxReplies];
  for (const r of repliedLeads) {
    if (r.id && !allReplies.some(ir => ir.leadId === r.id)) {
      allReplies.push({ name: r.name, leadId: r.id!, contact: r.igHandle || '', lastMsg: '(replied during batch)' });
    }
  }

  // Discord batch summary with inbox replies
  await sendDiscordBatchSummary({
    sent: results.sent, skipped: results.skipped, failed: results.failed,
    duration: totalDuration, boardId: BOARD_ID, strategy: STRATEGY_NAME,
    igAccount: IG_ACCOUNT, replies: allReplies, leadTimings,
  });

  if (leadTimings.length > 0) {
    console.log('');
    console.log('  LEAD TIMINGS:');
    for (const t of leadTimings) {
      const bar = '█'.repeat(Math.min(Math.round(t.duration / 5), 20));
      const icon = t.status === 'sent' ? '✓' : t.status === 'skip' ? '⏭' : '✗';
      console.log(`  ${icon} ${t.name.padEnd(20)} ${String(t.duration + 's').padStart(7)}  ${bar}`);
    }
    const fastest = leadTimings.reduce((a, b) => a.duration < b.duration ? a : b);
    const slowest = leadTimings.reduce((a, b) => a.duration > b.duration ? a : b);
    if (leadTimings.length > 1) {
      console.log(`\n  Fastest: ${fastest.name} (${fastest.duration}s)  |  Slowest: ${slowest.name} (${slowest.duration}s)`);
    }
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});
