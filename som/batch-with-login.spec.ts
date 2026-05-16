import { test, Page, Locator } from '@playwright/test';
import { AuthHelper } from './helpers/auth-helper';
import { LeadgenApiClient } from './helpers/leadgen-api-client';
import { scrapeProfileStats } from './helpers/providers/base-provider';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

// Token is injected by daemon via HEYIRIS_TOKEN env var (from SDK ~/.iris/sdk/.env)
// Fallback is Freelabel's internal token — clients must have HEYIRIS_TOKEN set
const TOKEN = process.env.HEYIRIS_TOKEN || (() => {
  try {
    const envPath = require('path').join(require('os').homedir(), '.iris', 'sdk', '.env');
    const content = require('fs').readFileSync(envPath, 'utf-8');
    const match = content.match(/IRIS_API_KEY=(.+)/);
    return match?.[1]?.trim() || '';
  } catch { return ''; }
})();
// Frontend auth needs a JWT (Passport OAuth token), not the simple API key.
// Use IRIS_FRONTEND_TOKEN env var (full repo .env won't exist on daemon machines).
const FRONTEND_TOKEN = process.env.IRIS_FRONTEND_TOKEN || TOKEN;
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
const OUTREACH_FILTER = (process.env.FILTER || 'new').toLowerCase() as 'all' | 'new' | 'followup';
const WAIT_DAYS = parseInt(process.env.WAIT_DAYS || '2', 10);

const DAILY_DM_CAP = parseInt(process.env.DAILY_DM_CAP || '40', 10);
const DM_SENT_FILE = path.join(__dirname, `.dm-sent-${IG_ACCOUNT}-${new Date().toISOString().slice(0, 10)}.json`);

const IG_AUTH_FILE = process.env.BROWSER_SESSION_FILE
  || path.join(__dirname, `instagram-auth-${IG_ACCOUNT}.json`);
const IG_AUTH_LEGACY = path.join(__dirname, 'instagram-auth.json');

const DISCORD_WEBHOOK = process.env.PLATFORM_UPDATES_DISCORD_CHANNEL_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1473938540139253834/XXWsRliRH7keLMEKrlnCcPPriR-iniyUhfCZU9MubNBBoZESBOLgvl8GqBAwYdajiEp7';

/**
 * Read per-lead state directly from the workspace UI's `<tr>` data attributes.
 * Replaces the API-sourced leadMap (which had a 200-lead cap). The workspace
 * already renders id / igHandle / hasEmail / hasPhone / hasDmNote / hasReply
 * on every row — see fl-elon-web-ui BloqLeadsTab.vue.
 */
type RowAttrs = {
  id: number | null;
  igHandle: string | null;
  hasEmail: boolean;
  hasPhone: boolean;
  hasDmNote: boolean;
  hasReply: boolean;
  outreachCount: number;
};
async function readRowAttrs(row: Locator): Promise<RowAttrs> {
  const [id, ig, hasEmail, hasPhone, hasDm, hasReply, outreach] = await Promise.all([
    row.getAttribute('data-lead-id'),
    row.getAttribute('data-ig-handle'),
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

/** Track DMs sent today per IG account — file-based counter (resets daily via filename) */
function getDmsSentToday(): number {
  try {
    if (fs.existsSync(DM_SENT_FILE)) {
      const data = JSON.parse(fs.readFileSync(DM_SENT_FILE, 'utf-8'));
      return data.count || 0;
    }
  } catch {}
  return 0;
}
function recordDmSent(): void {
  const current = getDmsSentToday();
  fs.mkdirSync(path.dirname(DM_SENT_FILE), { recursive: true });
  fs.writeFileSync(DM_SENT_FILE, JSON.stringify({ count: current + 1, updated: new Date().toISOString() }));
}

test(`Batch Outreach — Board ${BOARD_ID} / ${STRATEGY_NAME}`, async ({ page, context }) => {
  // ── AUTH (HeyIRIS) ──
  await AuthHelper.loginWithToken(page, FRONTEND_TOKEN);

  // ── AUTH (Instagram) ── load saved session cookies into this context
  const igFile = fs.existsSync(IG_AUTH_FILE) ? IG_AUTH_FILE
    : fs.existsSync(IG_AUTH_LEGACY) ? IG_AUTH_LEGACY : null;
  if (igFile) {
    const state = JSON.parse(fs.readFileSync(igFile, 'utf-8'));
    if (state.cookies && state.cookies.length > 0) {
      await context.addCookies(state.cookies);
      console.log(`✓ Instagram session loaded for @${IG_ACCOUNT} (${state.cookies.length} cookies)`);
    }
  } else {
    console.log(`⚠️  No instagram-auth-${IG_ACCOUNT}.json found — run save-instagram-session first`);
    console.log(`   IG_ACCOUNT=${IG_ACCOUNT} iris hive credentials save-session --platform instagram --bloq YOUR_BLOQ_ID\n`);
  }

  // ── PREFLIGHT: validate IG session before wasting time loading workspace ──
  if (igFile) {
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
        console.log(`  Fix: IG_ACCOUNT=${IG_ACCOUNT} iris hive credentials save-session --platform instagram --bloq YOUR_BLOQ_ID`);
        console.log(`${'='.repeat(70)}\n`);
        const screenshotDir = path.join(__dirname, 'test-results/screenshots');
        fs.mkdirSync(screenshotDir, { recursive: true });
        await checkPage.screenshot({ path: path.join(screenshotDir, `session-expired-preflight-${IG_ACCOUNT}.png`) }).catch(() => {});
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

  console.log(`\n📋 Campaign: Board ${BOARD_ID} / Strategy: ${STRATEGY_NAME}`);
  console.log(`   Instagram: @${IG_ACCOUNT}`);
  console.log(`   Limit: ${LEADS_TO_PROCESS} leads`);
  console.log(`   Step: ${FIXED_STEP ? `Fixed step ${FIXED_STEP}` : 'AUTO (next uncompleted)'}`);
  console.log(`   Filter: ${OUTREACH_FILTER === 'new' ? 'NEW ONLY (first contact)' : OUTREACH_FILTER === 'followup' ? 'FOLLOW-UP ONLY (continue sequences)' : 'ALL (new + follow-ups)'}`);
  if (DRY_RUN) console.log('   Mode: DRY RUN (will NOT send DMs)');
  if (PERSONALIZE) console.log('   Mode: PERSONALIZE (fetch bio)');
  if (!VARY) console.log('   Mode: VARY DISABLED (skip variation)');
  if (WARMUP) console.log(`   Mode: WARMUP (like ${WARMUP_LIKES} posts${WARMUP_FOLLOW ? ' + follow' : ''} before DM)`);

  // ── DAILY DM CAP CHECK ──
  const dmsSentToday = getDmsSentToday();
  const dmsRemaining = Math.max(0, DAILY_DM_CAP - dmsSentToday);
  console.log(`   Daily DM cap: ${dmsSentToday}/${DAILY_DM_CAP} sent today (${dmsRemaining} remaining)`);

  if (!DRY_RUN && dmsRemaining <= 0) {
    console.log('\n🚫 Daily DM limit reached — aborting batch');
    await sendDiscordAlert(
      `🚫 **SOM DM — Daily Limit Reached**\n` +
      `📋 Board: \`${BOARD_ID}\` | Account: \`@${IG_ACCOUNT}\`\n` +
      `Sent ${dmsSentToday}/${DAILY_DM_CAP} DMs today. Try again tomorrow.`
    );
    return;
  }
  console.log('');

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
  if (rowCount === 0) { console.log('⚠️  No leads.'); return; }

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
      const freshRes = await fetch(
        `${apiBase}/api/v1/leads?bloq_id=${BOARD_ID}&outreach_status=no_outreach&per_page=500`,
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
              `${apiBase}/api/v1/leads?bloq_id=${BOARD_ID}&outreach_status=not_contacted&per_page=500`,
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

  // ── FILTER leads based on step mode — auto-paginate if needed ──
  // step=1 or unset: only leads WITHOUT outreach badge (need first contact)
  // step=N (N>1):    only leads WITH outreach badge (already started, need step N)
  // step=auto:       ALL leads — eligibility determined after opening panel
  const eligibleRows: number[] = [];
  let scannedUpTo = 0;
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
  // Pre-filter: remove rows where the lead has no usable IG handle.
  // Reads each row's data-ig-handle directly from the rendered DOM (no API call,
  // no 200-cap). Falls back to the displayed name if the attribute is empty but
  // the name itself looks like a username.
  const dmableRows: number[] = [];
  for (const rowIdx of eligibleRows) {
    if (dmableRows.length >= effectiveLimit) break;
    const row = page.locator('table tbody tr').nth(rowIdx);
    const btn = row.locator('button.text-gray-300, button.text-white').first();
    const rowName = (await btn.textContent().catch(() => ''))?.trim() || '';
    if (!rowName) { dmableRows.push(rowIdx); continue; } // can't determine — let it through
    const rowAttrs = await readRowAttrs(row);
    const rowNameIsHandle = !rowName.includes(' ') && /^[a-z0-9._]+$/i.test(rowName);
    if (rowNameIsHandle || rowAttrs.igHandle) {
      dmableRows.push(rowIdx);
    } else {
      console.log(`⏭️  Pre-filter: "${rowName}" — no IG handle, skipping`);
    }
  }
  if (dmableRows.length < effectiveLimit && eligibleRows.length > dmableRows.length) {
    console.log(`⚠️  Only ${dmableRows.length}/${effectiveLimit} leads have IG handles on this page`);
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

      // ── PRE-CHECK: Skip if already DM'd (UI-rendered [SOM DM] note flag) ──
      if (rowAttrs.hasDmNote) {
        console.log(`⏭️  Already DM'd (UI badge) — skipping`);
        leadTimings.push({ name, duration: 0, status: 'skip' });
        results.skipped++; continue;
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
        const screenshotDir = path.join(__dirname, 'test-results/screenshots');
        fs.mkdirSync(screenshotDir, { recursive: true });
        await page.screenshot({ path: path.join(screenshotDir, `outreach-timeout-${idx + 1}.png`) });
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
          const screenshotDir = path.join(__dirname, 'test-results/screenshots');
          fs.mkdirSync(screenshotDir, { recursive: true });
          await page.screenshot({ path: path.join(screenshotDir, `no-apply-btn-${idx + 1}.png`) });
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
      // Prevents spamming leads who have multiple incomplete steps across strategies
      if (rowAttrs.id) {
        try {
          const leadData = await apiClient.getLead(rowAttrs.id);
          const notes = leadData?.data?.notes || leadData?.notes || [];
          const threeDaysAgo = Date.now() - (3 * 24 * 60 * 60 * 1000);
          const recentDm = notes.find((n: any) => {
            if (!n.content || !n.content.includes('[SOM DM]')) return false;
            const noteDate = new Date(n.created_at).getTime();
            return noteDate > threeDaysAgo;
          });
          if (recentDm) {
            const daysAgo = Math.round((Date.now() - new Date(recentDm.created_at).getTime()) / (24 * 60 * 60 * 1000) * 10) / 10;
            console.log(`⏭️  Already DM'd ${daysAgo}d ago — skipping (anti-spam)`);
            await page.keyboard.press('Escape'); results.skipped++; continue;
          }
        } catch {}
      }

      console.log(`→ Executing step ${targetStepIndex + 1}`);
      if (totalPlayButtons === 0) {
        console.log('⏭️  No play buttons found after 90s');
        const screenshotDir = path.join(__dirname, 'test-results/screenshots');
        fs.mkdirSync(screenshotDir, { recursive: true });
        await page.screenshot({ path: path.join(screenshotDir, `no-play-${idx + 1}.png`) });
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

      // ── 9. OPEN INSTAGRAM ──
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
            const errMsg = `Instagram session expired for @${IG_ACCOUNT} — re-run: IG_ACCOUNT=${IG_ACCOUNT} iris hive credentials save-session --platform instagram --bloq YOUR_BLOQ_ID`;
            console.log(`\n\x1b[31m${'='.repeat(70)}\x1b[0m`);
            console.log(`\x1b[31m  SESSION EXPIRED: @${IG_ACCOUNT}\x1b[0m`);
            console.log(`\x1b[31m  Instagram redirected to login page: ${igUrl.substring(0, 80)}\x1b[0m`);
            console.log(`\x1b[31m  Fix: IG_ACCOUNT=${IG_ACCOUNT} iris hive credentials save-session --platform instagram --bloq YOUR_BLOQ_ID\x1b[0m`);
            console.log(`\x1b[31m${'='.repeat(70)}\x1b[0m\n`);
            const screenshotDir = path.join(__dirname, 'test-results/screenshots');
            fs.mkdirSync(screenshotDir, { recursive: true });
            await igPage.screenshot({ path: path.join(screenshotDir, `session-expired-${IG_ACCOUNT}.png`) }).catch(() => {});
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
                const screenshotDir = path.join(__dirname, 'test-results/screenshots/profiles');
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
            const dmInputEarly = igPage.locator('textarea[placeholder*="Message"], div[contenteditable="true"][role="textbox"], p[placeholder*="Message"]').first();
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
                await igPage.waitForTimeout(1500);
                await dismissIgPopup(); // notifications popup may appear here
                inDMView = true;
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
                  await igPage.waitForTimeout(1500);
                  inDMView = true;
                } else {
                  // No "Send message" — try following first (IG restricts DMs for non-followers)
                  console.log('  ✗ No "Send message" in menu — trying follow first...');
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
                        await igPage.waitForTimeout(1500);
                        inDMView = true;
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
                    const screenshotDir = path.join(__dirname, 'test-results/screenshots');
                    fs.mkdirSync(screenshotDir, { recursive: true });
                    await igPage.screenshot({ path: path.join(screenshotDir, `no-send-msg-${idx + 1}.png`) });
                    results.failed++;
                  }
                }
              } else {
                console.log('  ✗ No ... button found');
                const screenshotDir = path.join(__dirname, 'test-results/screenshots');
                fs.mkdirSync(screenshotDir, { recursive: true });
                await igPage.screenshot({ path: path.join(screenshotDir, `no-dots-${idx + 1}.png`) });
                results.failed++;
              }
            }

            // ── TYPE & SEND DM ──
            if (inDMView) {
              await igPage.waitForTimeout(800);
              // Dismiss any popup that appeared after navigating to DM view
              await dismissIgPopup();
              const dmInput = igPage.locator('textarea[placeholder*="Message"], div[contenteditable="true"][role="textbox"], div[contenteditable="true"], p[placeholder*="Message"]').first();

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
                  const screenshotDir = path.join(__dirname, 'test-results/screenshots');
                  fs.mkdirSync(screenshotDir, { recursive: true });
                  await igPage.screenshot({ path: path.join(screenshotDir, `dry-run-dm-${idx + 1}.png`) });
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
                  await igPage.waitForTimeout(800);
                  console.log('  ✓ DM sent!');
                  results.sent++;
                  dmSentThisLead = true;
                  recordDmSent();

                  // Record DM note (fire-and-forget). Lead ID comes from the row's
                  // data-lead-id, which we already read into rowAttrs at the top of this iteration.
                  if (rowAttrs.id) {
                    apiClient.addNote(
                      rowAttrs.id,
                      `[SOM DM] Sent via @${IG_ACCOUNT}: "${dmText.substring(0, 100)}..."`,
                      'outreach'
                    ).catch(() => {});

                    // ── STEP COMPLETION (immediately after DM send) ──
                    // Must happen HERE, not later — if the browser crashes after this point,
                    // the step is already marked done and the lead won't get re-messaged.
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
                console.log('  ✗ No message input found');
                const screenshotDir = path.join(__dirname, 'test-results/screenshots');
                fs.mkdirSync(screenshotDir, { recursive: true });
                await igPage.screenshot({ path: path.join(screenshotDir, `no-dm-input-${idx + 1}.png`) });
                results.failed++;
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
      const screenshotDir = path.join(__dirname, 'test-results/screenshots');
      fs.mkdirSync(screenshotDir, { recursive: true });
      await page.screenshot({ path: path.join(screenshotDir, `error-${idx + 1}.png`) }).catch(() => {});
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

  // Discord alert for replied leads (#67772) — so you can follow up manually
  if (repliedLeads.length > 0) {
    const leadLines = repliedLeads.map(l => {
      const ig = l.igHandle ? `@${l.igHandle}` : '';
      const link = l.id ? `https://web.freelabel.net/iris?boardId=${BOARD_ID}&tab=leads&lead=${l.id}` : '';
      return `  • **${l.name}** ${ig}${link ? ` — [View](${link})` : ''}`;
    }).join('\n');
    await sendDiscordAlert(
      `🔥 **SOM — ${repliedLeads.length} Lead${repliedLeads.length > 1 ? 's' : ''} Replied!**\n` +
      `📋 Board: \`${BOARD_ID}\` | Account: \`@${IG_ACCOUNT}\`\n` +
      `These leads responded — follow up manually:\n${leadLines}`
    );
  }
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
