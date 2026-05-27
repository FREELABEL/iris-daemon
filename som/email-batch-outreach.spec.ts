import { test } from '@playwright/test';
import { LeadgenApiClient } from './helpers/leadgen-api-client';
import * as https from 'https';

const TOKEN = process.env.HEYIRIS_TOKEN;
if (!TOKEN) throw new Error('HEYIRIS_TOKEN env var required. Set in ~/.iris/bridge/.env or export it.');
const BOARD_ID = parseInt(process.env.BOARD_ID || '174', 10);
const LEADS_TO_PROCESS = parseInt(process.env.LIMIT || '5', 10);
const STRATEGY_NAME = process.env.STRATEGY || 'Law Firm AI Case Review';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const API_URL = process.env.LEADGEN_API_URL || process.env.API_URL || 'https://raichu.heyiris.io/api/v1';
const AUTO_ENRICH = process.env.AUTO_ENRICH === '1';
const MIN_SCORE = parseInt(process.env.MIN_SCORE || '0', 10);
const STRATEGY_TEMPLATE_ID = parseInt(process.env.STRATEGY_TEMPLATE_ID || '0', 10) || undefined;

const DISCORD_WEBHOOK = process.env.PLATFORM_UPDATES_DISCORD_CHANNEL_WEBHOOK_URL || '';

// ── Helpers ──────────────────────────────────────────────────────────

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
    req.on('error', () => resolve());
    req.write(body);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Basic email validation — filters out garbage results from enrichment */
function isValidEmail(email: string): boolean {
  if (!email || !email.includes('@') || !email.includes('.')) return false;
  const parts = email.split('@');
  if (parts.length !== 2) return false;
  const domain = parts[1];
  if (/[^a-z0-9.-]/i.test(domain)) return false;
  const tld = domain.split('.').pop() || '';
  if (tld.length < 2 || tld.length > 6) return false;
  const domainBase = domain.split('.').slice(0, -1).join('.');
  if (domainBase.length > 3 && !/[aeiou]/i.test(domainBase)) return false;
  if (parts[0].includes('@') || parts[0].includes('.com') || parts[0].includes('.net')) return false;
  return true;
}

interface LeadRecord {
  id: number;
  name: string;
  nickname: string;
  email: string;
  score?: number;
}

/** Fetch leads from API */
function fetchLeads(boardId: number, token: string): Promise<LeadRecord[]> {
  const baseUrl = API_URL.replace('/api/v1', '');
  return new Promise((resolve) => {
    const apiUrl = new URL(`${baseUrl}/api/v1/leads`);
    apiUrl.searchParams.set('bloq_id', String(boardId));
    apiUrl.searchParams.set('per_page', '200');

    const req = https.request({
      hostname: apiUrl.hostname,
      path: `${apiUrl.pathname}?${apiUrl.searchParams.toString()}`,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          const data = json.data?.data || json.data || json || [];
          const leads: LeadRecord[] = [];

          for (const lead of (Array.isArray(data) ? data : [])) {
            const email = lead.email
              || lead.contact_info?.email
              || '';

            leads.push({
              id: lead.id,
              name: (lead.name || lead.nickname || '').trim(),
              nickname: (lead.nickname || lead.name || '').trim(),
              email: isValidEmail(email) ? email.trim() : '',
              score: lead.custom_fields?.ig_enrichment?.score,
            });
          }

          resolve(leads);
        } catch {
          resolve([]);
        }
      });
    });

    req.on('error', () => resolve([]));
    req.end();
  });
}

// ── Main Test (API-Direct Flow) ──────────────────────────────────────

test(`Email Outreach — Board ${BOARD_ID} / ${STRATEGY_NAME}`, async () => {
  // No browser needed — this is entirely API-driven
  const apiClient = new LeadgenApiClient(TOKEN, BOARD_ID);

  console.log(`\n📧 Email Outreach Campaign (API-Direct)`);
  console.log(`   Board: ${BOARD_ID} / Strategy: ${STRATEGY_NAME}`);
  console.log(`   Limit: ${LEADS_TO_PROCESS} leads`);
  if (DRY_RUN) console.log('   Mode: DRY RUN (will NOT send emails)');
  if (AUTO_ENRICH) console.log('   Mode: AUTO ENRICH (quick IG extraction)');
  if (MIN_SCORE > 0) console.log(`   Min Score: ${MIN_SCORE}`);
  if (STRATEGY_TEMPLATE_ID) console.log(`   Strategy Template: #${STRATEGY_TEMPLATE_ID}`);
  console.log('');

  // ── 1. FETCH ALL LEADS ──
  console.log('🔍 Fetching leads from API...');
  const allLeads = await fetchLeads(BOARD_ID, TOKEN);
  const withEmail = allLeads.filter(l => l.email);
  const needsEnrich = allLeads.filter(l => !l.email);
  console.log(`✓ ${allLeads.length} total leads — ${withEmail.length} have email, ${needsEnrich.length} need enrichment`);

  let leadsWithEmail: LeadRecord[] = [...withEmail];

  // ── 2. AUTO-ENRICH (quick IG extraction — <5s per lead) ──
  if (AUTO_ENRICH && needsEnrich.length > 0) {
    const enrichLimit = Math.min(needsEnrich.length, LEADS_TO_PROCESS * 3);
    const toEnrich = needsEnrich.slice(0, enrichLimit);
    let enrichSuccess = 0;
    let enrichFail = 0;

    console.log(`\n🔬 Quick IG enrichment for ${toEnrich.length} leads...\n`);

    for (let i = 0; i < toEnrich.length; i++) {
      const lead = toEnrich[i];
      const label = lead.name || lead.nickname || `#${lead.id}`;
      process.stdout.write(`  [${i + 1}/${toEnrich.length}] ${label.padEnd(30)} `);

      const result = await apiClient.quickEnrichInstagram(lead.id);

      if (result.success && result.contacts?.emails?.length) {
        enrichSuccess++;
        const foundEmail = result.contacts.emails[0];
        const score = result.contacts.score || 0;
        console.log(`✓ ${foundEmail} (score: ${score})`);
        leadsWithEmail.push({ ...lead, email: foundEmail, score });
      } else {
        enrichFail++;
        console.log(`✗ ${result.error || 'no email found'}`);
      }

      // Stop early if we have enough
      if (leadsWithEmail.length >= LEADS_TO_PROCESS) {
        console.log(`\n  ✓ Reached ${LEADS_TO_PROCESS} leads with email — stopping enrichment`);
        break;
      }

      // IG rate limit delay
      if (i < toEnrich.length - 1) await sleep(2000);
    }

    console.log(`\n✓ Enrichment: ${enrichSuccess} found email, ${enrichFail} no email`);
  }

  console.log(`✓ Total leads with email: ${leadsWithEmail.length}\n`);

  // ── 3. FILTER BY SCORE (if min_score set) ──
  if (MIN_SCORE > 0) {
    const before = leadsWithEmail.length;
    leadsWithEmail = leadsWithEmail.filter(l => (l.score || 0) >= MIN_SCORE);
    console.log(`✓ Score filter (>=${MIN_SCORE}): ${before} → ${leadsWithEmail.length} leads`);
  }

  if (leadsWithEmail.length === 0) {
    console.log('⚠️  No leads with email found.');
    if (!AUTO_ENRICH) {
      console.log('   Tip: Run with enrich=1 to auto-enrich leads first');
    }
    await sendDiscordAlert(
      `🚨 **SOM Email — No Leads With Email**\n` +
      `📋 Board: \`${BOARD_ID}\` | Strategy: \`${STRATEGY_NAME}\`\n` +
      `No leads have email addresses.${AUTO_ENRICH ? ' Enrichment ran but found no emails.' : ' Run with enrich=1.'}`
    );
    return;
  }

  // ── 3b. BOUNCE FILTER — skip leads whose email previously bounced ──
  const preFilterCount = leadsWithEmail.length;
  const bouncedEmails: string[] = [];
  for (const lead of leadsWithEmail) {
    const bounce = await apiClient.checkBounceStatus(lead.email);
    if (bounce.bounced && ['hard', 'undetermined', 'unknown'].includes(bounce.type || '')) {
      bouncedEmails.push(lead.email);
    }
  }
  if (bouncedEmails.length > 0) {
    leadsWithEmail = leadsWithEmail.filter(l => !bouncedEmails.includes(l.email));
    console.log(`⚠️  Bounce filter: removed ${bouncedEmails.length} hard-bounced emails`);
    for (const e of bouncedEmails) console.log(`   ✗ ${e}`);
  }

  // ── 3c. DAILY QUOTA CHECK ──
  const quota = await apiClient.checkSendQuota();
  console.log(`📊 Daily quota: ${quota.sent_today}/${quota.daily_cap} sent today (${quota.remaining} remaining)`);
  if (quota.remaining <= 0) {
    console.log('🚫 Daily send limit reached — aborting batch');
    await sendDiscordAlert(
      `🚫 **SOM Email — Daily Limit Reached**\n` +
      `📋 Board: \`${BOARD_ID}\` | Strategy: \`${STRATEGY_NAME}\`\n` +
      `Sent ${quota.sent_today}/${quota.daily_cap} today. Try again tomorrow.`
    );
    return;
  }
  // Cap leads to remaining quota
  if (leadsWithEmail.length > quota.remaining) {
    console.log(`⚠️  Capping batch from ${leadsWithEmail.length} to ${quota.remaining} (quota limit)`);
    leadsWithEmail = leadsWithEmail.slice(0, quota.remaining);
  }

  // Show preview
  console.log('📧 Leads with email:');
  for (const lead of leadsWithEmail.slice(0, 15)) {
    const scoreTag = lead.score ? ` [${lead.score}]` : '';
    console.log(`   ${lead.name || lead.nickname} → ${lead.email}${scoreTag}`);
  }
  if (leadsWithEmail.length > 15) console.log(`   ... and ${leadsWithEmail.length - 15} more`);
  console.log('');

  // ── 4. PROCESS LEADS (API-DIRECT: generate draft → send email) ──
  const toProcess = leadsWithEmail.slice(0, LEADS_TO_PROCESS);
  console.log(`✓ ${toProcess.length} leads queued for email outreach\n`);

  const results = { sent: 0, skipped: 0, failed: 0, enriched: 0 };
  const leadTimings: { name: string; email: string; duration: number; status: string }[] = [];
  const batchStart = Date.now();

  // Build prompt from strategy name for AI generation
  const emailPrompt = `You are sending an outreach email for the "${STRATEGY_NAME}" campaign. ` +
    `Write a professional, personalized email that introduces our offering and invites the recipient to learn more. ` +
    `Keep it concise (3-4 paragraphs), friendly, and action-oriented with a clear CTA.`;

  for (let idx = 0; idx < toProcess.length; idx++) {
    const lead = toProcess[idx];
    const name = lead.name || lead.nickname;
    const leadEmail = lead.email;
    const leadStart = Date.now();
    console.log(`━━━ Lead ${idx + 1}/${toProcess.length} ━━━`);
    console.log(`→ ${name} (${leadEmail})`);

    try {
      // ── GENERATE EMAIL DRAFT VIA API ──
      console.log('→ Generating email draft...');
      const draft = await apiClient.generateEmailDraft(lead.id, emailPrompt, {
        tone: 'professional',
        strategy_template_id: STRATEGY_TEMPLATE_ID,
      });

      if (draft.data?.signature_warning) {
        console.log(`  ⚠️  Signature: ${draft.data.signature_warning}`);
      }

      if (!draft.success) {
        console.log(`⚠️  Draft generation failed: ${draft.message || draft.data?.error || 'unknown error'}`);
        results.failed++;
        leadTimings.push({ name, email: leadEmail, duration: parseFloat(((Date.now() - leadStart) / 1000).toFixed(1)), status: 'fail' });
        continue;
      }

      const subject = draft.data?.subject || draft.data?.draft?.subject || `Introduction — ${STRATEGY_NAME}`;
      const bodyHtml = draft.data?.body_html || draft.data?.draft?.body_html || draft.data?.message || '';
      console.log(`→ Subject: "${subject.substring(0, 60)}..."`);
      console.log(`→ Body: ${bodyHtml.substring(0, 80)}...`);

      // ── SEND OR DRY RUN ──
      if (DRY_RUN) {
        console.log(`  [DRY RUN] Would send to ${leadEmail}: "${subject}"`);
        results.sent++;
      } else {
        console.log('→ Sending email...');
        const sent = await apiClient.sendEmail(lead.id, {
          to_email: leadEmail,
          subject,
          body_html: bodyHtml,
          to_name: name,
          plain_text_only: true,
        });

        if (sent.success) {
          console.log(`  ✓ Email sent to ${leadEmail}!`);
          results.sent++;
        } else {
          console.log(`  ✗ Send failed: ${sent.message || 'unknown error'}`);
          results.failed++;
          leadTimings.push({ name, email: leadEmail, duration: parseFloat(((Date.now() - leadStart) / 1000).toFixed(1)), status: 'fail' });
          continue;
        }
      }

      const leadDuration = ((Date.now() - leadStart) / 1000).toFixed(1);
      console.log(`✅ ${name} → ${leadEmail} (${leadDuration}s)`);
      leadTimings.push({ name, email: leadEmail, duration: parseFloat(leadDuration), status: 'sent' });

      // Rate limit between sends (3s)
      if (idx < toProcess.length - 1) await sleep(3000);

    } catch (err: any) {
      const leadDuration = ((Date.now() - leadStart) / 1000).toFixed(1);
      console.error(`❌ Error (${leadDuration}s): ${err.message?.substring(0, 150)}`);
      leadTimings.push({ name, email: leadEmail, duration: parseFloat(leadDuration), status: 'fail' });
      results.failed++;
    }
  }

  // ── SUMMARY ──
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
  console.log('  E M A I L   O U T R E A C H');
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(DRY_RUN ? '  DRY RUN COMPLETE' : '  BATCH COMPLETE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Board: ${BOARD_ID}  |  Strategy: ${STRATEGY_NAME}`);
  console.log(`  ${DRY_RUN ? 'Would send' : 'Sent'}: ${results.sent}  |  Skip: ${results.skipped}  |  Fail: ${results.failed}`);
  if (results.enriched > 0) console.log(`  Enriched: ${results.enriched}`);
  console.log(`  Leads with email: ${leadsWithEmail.length}  |  Processed: ${toProcess.length}`);
  console.log(`  Total: ${totalDuration}s  |  Avg: ${avgDuration}s/lead`);
  if (DRY_RUN) console.log('  Mode: DRY RUN');
  if (AUTO_ENRICH) console.log('  Mode: AUTO ENRICH (quick IG)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (leadTimings.length > 0) {
    console.log('');
    console.log('  LEAD TIMINGS:');
    for (const t of leadTimings) {
      const bar = '█'.repeat(Math.min(Math.round(t.duration / 5), 20));
      const icon = t.status === 'sent' ? '✓' : t.status === 'skip' ? '⏭' : '✗';
      console.log(`  ${icon} ${t.name.padEnd(25)} ${t.email.padEnd(30)} ${String(t.duration + 's').padStart(7)}  ${bar}`);
    }
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Discord notification
  const summary = DRY_RUN ? 'DRY RUN' : 'COMPLETE';
  const emailList = leadTimings
    .filter(t => t.status === 'sent')
    .map(t => `  ${t.name} → ${t.email}`)
    .join('\n');
  await sendDiscordAlert(
    `📧 **SOM Email — ${summary}**\n` +
    `📋 Board: \`${BOARD_ID}\` | Strategy: \`${STRATEGY_NAME}\`\n` +
    `✅ ${DRY_RUN ? 'Would send' : 'Sent'}: ${results.sent} | ⏭ Skip: ${results.skipped} | ❌ Fail: ${results.failed}\n` +
    `📧 Leads with email: ${leadsWithEmail.length}\n` +
    (emailList ? `\`\`\`\n${emailList}\n\`\`\`\n` : '') +
    `⏱ ${totalDuration}s total (${avgDuration}s avg/lead)`
  );
});
