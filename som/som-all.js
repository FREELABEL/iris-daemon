#!/usr/bin/env node
/**
 * SOM — Run outreach campaigns sequentially (one browser at a time)
 *
 * Usage:
 *   node som-all.js                                  # courses + creators (default)
 *   node som-all.js limit=15                         # set lead limit
 *   node som-all.js limit=10 dry=1                   # dry run
 *   node som-all.js limit=10 warmup=1                # with warmup (like + follow)
 *   node som-all.js all=1 limit=15                   # run ALL campaigns
 *   node som-all.js only=courses,beatbox limit=10    # pick specific campaigns
 *   node som-all.js repeat=3h                        # repeat every 3 hours
 *   node som-all.js repeat=2h loop=5                 # repeat 5 times
 *
 * Hive task type: som_batch
 *   prompt: "limit=15"
 *   prompt: "all=1 limit=10 dry=1"
 */

const { spawn } = require('child_process');
const path = require('path');

// Campaign registry — imported from shared config (single source of truth)
const somConfig = require('./som-config');
const campaignRegistry = somConfig.getCampaignRegistry();
const { preflightCheck } = somConfig;

const API_BASE = process.env.IRIS_FL_API_URL || 'https://raichu.heyiris.io';
const API_TOKEN = process.env.HEYIRIS_TOKEN || (() => {
  try {
    const envPath = require('path').join(require('os').homedir(), '.iris', 'sdk', '.env');
    const content = require('fs').readFileSync(envPath, 'utf-8');
    const match = content.match(/IRIS_API_KEY=(.+)/);
    return match?.[1]?.trim() || '';
  } catch { return ''; }
})();
const reset = '\x1b[0m';

const somScript = path.join(__dirname, 'som.js');
const rawArgs = process.argv.slice(2);

// ── Parse flags ──────────────────────────────────────────────────
let useAll = false;
let onlyCampaigns = null;
let parallel = false; // SEQUENTIAL by default — parallel causes race conditions on shared IG accounts
let enrich = null; // null = auto (true for email mode), true/false = explicit
let enrichGoal = 'email'; // email, phone, all
let outreachMode = 'outreach'; // outreach (DM) or email
let leadFilter = 'new'; // new (first contact) or followup (continue sequences)
let waitDays = 2; // min days between steps for followup mode
let repeatMs = 0;
let maxLoops = 0;
const args = []; // pass-through to each campaign

for (const arg of rawArgs) {
  const eq = arg.indexOf('=');
  if (eq > 0) {
    const key = arg.slice(0, eq).toUpperCase();
    const val = arg.slice(eq + 1);

    if (key === 'ALL') { useAll = val === '1' || val === 'true'; continue; }
    if (key === 'SYNC' || key === 'SEQUENTIAL') { parallel = false; continue; }
    if (key === 'PARALLEL') { parallel = true; continue; }
    if (key === 'ENRICH') { enrich = val === '1' || val === 'true'; continue; }
    if (key === 'ENRICH_GOAL' || key === 'GOAL') { enrichGoal = val.toLowerCase(); continue; }
    if (key === 'MODE') { outreachMode = val.toLowerCase(); continue; }
    if (key === 'FILTER') { leadFilter = val.toLowerCase(); } // new | followup (don't continue — pass through to campaigns too)
    if (key === 'WAIT_DAYS' || key === 'WAITDAYS') { waitDays = parseInt(val, 10); continue; }
    if (key === 'ONLY') { onlyCampaigns = val.split(',').map(s => s.trim().toLowerCase()); continue; }
    if (key === 'REPEAT') {
      const match = val.match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)$/i);
      if (!match) { console.error('  Invalid repeat format. Use e.g. repeat=3h, repeat=90m'); process.exit(1); }
      const num = parseFloat(match[1]);
      const unit = match[2].toLowerCase();
      repeatMs = unit.startsWith('h') ? num * 3600000 : num * 60000;
      continue;
    }
    if (key === 'LOOP') { maxLoops = parseInt(val, 10); continue; }
  }
  if (arg === '--all') { useAll = true; continue; }
  args.push(arg);
}

// ── Default warmup: like + follow before Step 1 DMs (#67773) ────
// Enabled by default. Disable with warmup=0
if (!args.some(a => a.toLowerCase().startsWith('warmup=') || a.toLowerCase().startsWith('engage='))) {
  args.push('warmup=1');
  console.log('  [default] warmup=1 (like + follow before DM). Disable with warmup=0');
}

// ── Resolve campaign list ────────────────────────────────────────
let campaigns;
if (onlyCampaigns) {
  campaigns = onlyCampaigns.filter(c => campaignRegistry[c]);
  if (campaigns.length === 0) {
    console.error(`  No valid campaigns in: ${onlyCampaigns.join(', ')}`);
    console.error(`  Available: ${Object.keys(campaignRegistry).join(', ')}`);
    process.exit(1);
  }
} else if (useAll) {
  campaigns = Object.keys(campaignRegistry);
} else {
  campaigns = Object.entries(campaignRegistry).filter(([, v]) => v.active).map(([k]) => k);
}

// ── Helpers ──────────────────────────────────────────────────────

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(sec).padStart(2, '0')}s`;
}

function formatTime(date) {
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ── Pre-Flight Enrichment ────────────────────────────────────────

async function apiFetch(endpoint, options = {}) {
  const url = `${API_BASE}/api/v1${endpoint}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  });
  return res.json();
}

// ── Quality scoring helpers ──────────────────────────────────────
const SMALL_BOARD_THRESHOLD = 200;   // boards below this: enrich all, no filter
const MIN_FOLLOWERS = 300;           // minimum followers to be "enrich-worthy"
const ENRICH_CAP_PER_BOARD = 15;     // max enrichments per board per run
const SAMPLE_QUALITY_THRESHOLD = 25; // % of sample that must have ig_enrichment to proceed

// Bot-like username detector (purely numeric suffixes, random char soup)
function looksLikeBot(username) {
  if (!username) return true;
  const clean = username.replace(/[._]/g, '');
  // All digits or single char + digits
  if (/^\d+$/.test(clean)) return true;
  if (/^[a-z]\d{4,}$/i.test(clean)) return true;
  // Very short random-looking (< 4 alpha chars total)
  const alphaOnly = clean.replace(/\d/g, '');
  if (alphaOnly.length < 3) return true;
  return false;
}

const ENRICH_COOLDOWN_DAYS = 7; // don't re-attempt enrichment within this window

function wasRecentlyAttempted(lead) {
  const attempted = lead.custom_fields?.enrichment_attempted_at;
  if (!attempted) return false;
  const daysSince = (Date.now() - new Date(attempted).getTime()) / (1000 * 60 * 60 * 24);
  return daysSince < ENRICH_COOLDOWN_DAYS;
}

// Full lead score (0-100) — persisted on the lead record for prioritization
function computeLeadScore(lead) {
  const ig = lead.custom_fields?.ig_enrichment || {};
  const ci = lead.contact_info || {};
  const name = lead.name || lead.nickname || '';
  let score = 0;

  // Reach (0-35)
  const f = ig.followers || 0;
  if (f >= 50000) score += 35;
  else if (f >= 10000) score += 30;
  else if (f >= 5000) score += 25;
  else if (f >= 1000) score += 18;
  else if (f >= MIN_FOLLOWERS) score += 10;
  else if (f > 0) score += 3;

  // Profile quality (0-25)
  if (ig.is_business) score += 10;
  if (ig.bio && ig.bio.length > 20) score += 8;
  else if (ig.bio && ig.bio.length > 5) score += 4;
  if (ig.full_name && ig.full_name.length > 3) score += 4;
  if (ig.bio && /\b(http|\.com|\.io|\.net|linktr)/i.test(ig.bio)) score += 3; // has URL in bio

  // Contact availability (0-25)
  if (ci.email || lead.email) score += 15;
  if (lead.website) score += 5;
  if (ci.phone || lead.phone) score += 5;

  // Penalties
  if (looksLikeBot(name)) score -= 15;
  if (!ig.followers && !ig.bio) score -= 10; // no IG data at all

  return Math.max(0, Math.min(100, score));
}

// Enrichment filter score — used to decide whether to attempt enrichment
function leadQualityScore(lead) {
  if (wasRecentlyAttempted(lead)) return -1;

  const ig = lead.custom_fields?.ig_enrichment || {};
  let score = 0;
  if (ig.followers >= 10000) score += 40;
  else if (ig.followers >= 1000) score += 25;
  else if (ig.followers >= MIN_FOLLOWERS) score += 10;
  else return 0; // below threshold = not worth enriching
  if (ig.is_business) score += 20;
  if (ig.bio && ig.bio.length > 5) score += 15;
  if (ig.full_name && ig.full_name.length > 3) score += 5;
  const name = lead.name || lead.nickname || '';
  if (looksLikeBot(name)) score = Math.max(0, score - 30);
  return score;
}

// Stamp enrichment result, follower count, and lead score on the record
async function stampEnrichmentResult(leadId, result, lead) {
  const ig = lead.custom_fields?.ig_enrichment || {};
  const followers = ig.followers || null;
  const score = computeLeadScore(lead);

  const update = {
    custom_fields: {
      enrichment_attempted_at: new Date().toISOString(),
      enrichment_result: result, // 'found', 'no_email', 'error'
      lead_score: score,
      lead_score_updated_at: new Date().toISOString(),
    },
  };
  if (followers != null) {
    update.custom_fields.ig_followers = followers;
  }
  return apiFetch(`/leads/${leadId}`, {
    method: 'PUT',
    body: JSON.stringify(update),
  });
}

async function enrichCampaignLeads(campaignName, boardId, goal = 'email') {
  const prefix = `\x1b[33m[enrich]\x1b[0m`;
  console.log(`${prefix} Checking board ${boardId} (${campaignName})...`);

  // Step 1: Fetch page 1 to get total count + sample quality
  const fetchStart = Date.now();
  const page1 = await apiFetch(`/leads?bloq_id=${boardId}&per_page=100&page=1`);
  const sample = page1?.data || [];
  const totalLeads = page1?.total || sample.length;

  if (sample.length === 0) {
    console.log(`${prefix} Board ${boardId}: no leads found`);
    return { total: 0, missing: 0, enriched: 0, failed: 0, skipped_reason: null };
  }

  // Step 2: Quality assessment on sample
  const sampleEnriched = sample.filter(l => l.custom_fields?.ig_enrichment?.followers != null);
  const sampleQualityPct = Math.round((sampleEnriched.length / sample.length) * 100);
  const sampleWithEmail = sample.filter(l => (l.contact_info?.email) || l.email);
  const coveragePct = Math.round((sampleWithEmail.length / sample.length) * 100);

  console.log(`${prefix} Board ${boardId}: ${totalLeads} total leads | sample quality: ${sampleQualityPct}% IG-enriched, ${coveragePct}% have email`);

  // Step 3: Decide strategy based on board size + quality
  const isSmallBoard = totalLeads <= SMALL_BOARD_THRESHOLD;
  let leads = [];

  if (isSmallBoard) {
    // Small board — fetch everything, no quality gate
    console.log(`${prefix} Small board (${totalLeads} leads) — fetching all`);
    leads = [...sample];
    let page = 2;
    while (page1.next_page_url) {
      const data = await apiFetch(`/leads?bloq_id=${boardId}&per_page=100&page=${page}`);
      const batch = data?.data || [];
      if (batch.length === 0) break;
      leads.push(...batch);
      if (!data.next_page_url) break;
      page++;
    }
  } else {
    // Large board — check sample quality before committing to full fetch
    if (sampleQualityPct < SAMPLE_QUALITY_THRESHOLD) {
      console.log(`${prefix} SKIP: Large board with low quality (${sampleQualityPct}% < ${SAMPLE_QUALITY_THRESHOLD}% threshold)`);
      console.log(`${prefix} Only ${sampleEnriched.length}/${sample.length} leads on page 1 have IG data — not worth full fetch`);
      const sampleQualified = sampleEnriched
        .filter(l => leadQualityScore(l) > 0)
        .filter(l => {
          const ci = l.contact_info || {};
          if (goal === 'email') return !(l.email || ci.email);
          return true;
        })
        .sort((a, b) => (b.custom_fields?.ig_enrichment?.followers || 0) - (a.custom_fields?.ig_enrichment?.followers || 0))
        .slice(0, Math.min(10, ENRICH_CAP_PER_BOARD));

      if (sampleQualified.length > 0) {
        console.log(`${prefix} Found ${sampleQualified.length} quality leads in sample — enriching those only`);
        leads = sample;
      } else {
        console.log(`${prefix} No quality leads in sample either — skipping board entirely`);
        return { total: totalLeads, missing: 0, enriched: 0, failed: 0, skipped_reason: 'low_quality' };
      }
    } else {
      // Quality is decent — fetch all pages
      console.log(`${prefix} Quality OK — fetching all ${totalLeads} leads...`);
      leads = [...sample];
      let page = 2;
      while (true) {
        const data = await apiFetch(`/leads?bloq_id=${boardId}&per_page=100&page=${page}`);
        const batch = data?.data || [];
        if (batch.length === 0) break;
        leads.push(...batch);
        process.stdout.write(`\r${prefix} Fetching... ${leads.length}/${totalLeads} (page ${page})  `);
        if (!data.next_page_url) break;
        page++;
      }
      process.stdout.write(`\r${' '.repeat(80)}\r`);
    }
  }

  const fetchSec = ((Date.now() - fetchStart) / 1000).toFixed(1);

  // Step 4: Find missing leads + apply quality filter
  const hasVal = (v) => v && v !== 'NULL' && v !== '';
  const missing = leads.filter(l => {
    const ci = l.contact_info || {};
    if (goal === 'email') return !hasVal(l.email) && !hasVal(ci.email);
    if (goal === 'phone') return !hasVal(l.phone) && !hasVal(ci.phone);
    return (!hasVal(l.email) && !hasVal(ci.email)) && (!hasVal(l.phone) && !hasVal(ci.phone));
  });

  // Quality filter: score + sort by followers desc (best prospects first)
  let candidates;
  const scored = missing.map(l => ({
    lead: l,
    score: leadQualityScore(l),
    followers: l.custom_fields?.ig_enrichment?.followers || 0,
  }));
  const cooldownSkipped = scored.filter(x => x.score === -1).length;

  if (isSmallBoard) {
    candidates = scored
      .filter(x => x.score >= 0)
      .sort((a, b) => b.followers - a.followers || b.score - a.score)
      .map(x => x.lead);
  } else {
    candidates = scored
      .filter(x => x.score > 0)
      .sort((a, b) => b.followers - a.followers || b.score - a.score)
      .map(x => x.lead);
  }

  const totalMissing = missing.length;
  const totalFiltered = missing.length - candidates.length;
  const emailCoverage = Math.round(100 * (leads.length - totalMissing) / leads.length);

  console.log(`${prefix} ${leads.length} leads, ${totalMissing} missing ${goal} (${emailCoverage}% coverage) [${fetchSec}s]`);
  if (totalFiltered > 0 || cooldownSkipped > 0) {
    const parts = [`${candidates.length} enrich-worthy`];
    if (cooldownSkipped > 0) parts.push(`${cooldownSkipped} on cooldown`);
    parts.push(`${totalFiltered - cooldownSkipped} low quality`);
    console.log(`${prefix} Filter: ${parts.join(', ')}`);
  }

  if (candidates.length === 0) {
    console.log(`${prefix} No enrich-worthy leads — skipping`);
    return { total: leads.length, missing: totalMissing, enriched: 0, failed: 0, skipped_reason: 'no_candidates' };
  }

  // Step 5: Enrich (capped)
  let enriched = 0;
  let failed = 0;
  const enrichLimit = Math.min(candidates.length, ENRICH_CAP_PER_BOARD);
  const enrichStart = Date.now();

  console.log(`${prefix} Enriching top ${enrichLimit} leads (${goal} goal, sorted by followers)...`);

  for (let i = 0; i < enrichLimit; i++) {
    const lead = candidates[i];
    const ig = lead.custom_fields?.ig_enrichment || {};
    const leadName = lead.name || lead.nickname || `#${lead.id}`;
    const followLabel = ig.followers ? ` (${ig.followers} followers)` : '';

    // Progress bar
    const pct = Math.round(((i + 1) / enrichLimit) * 100);
    const elapsed = Date.now() - enrichStart;
    const avgMs = i > 0 ? elapsed / i : 0;
    const remaining = Math.round(avgMs * (enrichLimit - i) / 1000);
    const eta = remaining > 0 ? ` ~${Math.floor(remaining / 60)}m ${remaining % 60}s left` : '';
    const barW = 20;
    const filled = Math.round((i / enrichLimit) * barW);
    const bar = '▓'.repeat(filled) + '░'.repeat(barW - filled);
    process.stdout.write(`\r${prefix} ${bar} ${pct}% (${enriched}✓ ${failed}✗)${eta}   `);

    try {
      // Step 1: Quick Instagram enrichment (<5s)
      const igResult = await apiFetch(`/leads/${lead.id}/quick-enrich-ig`, { method: 'POST' });

      if (igResult.success && igResult.contacts) {
        const emails = igResult.contacts.emails || [];
        if (emails.length > 0) {
          lead.contact_info = lead.contact_info || {};
          lead.contact_info.email = emails[0];
          const score = computeLeadScore(lead);
          await stampEnrichmentResult(lead.id, 'found', lead).catch(() => {});
          enriched++;
          console.log(`\n${prefix}   [${i + 1}/${enrichLimit}] ${leadName}${followLabel} → ${emails[0]} ✓ (score: ${score})`);
          await sleep(2000); // rate limit
          continue;
        }
      }

      // Step 2: If IG didn't find email, try standard enrichment (Tavily + FireCrawl + AI)
      if (goal === 'email') {
        console.log(`\n${prefix}   [${i + 1}/${enrichLimit}] ${leadName}${followLabel} — deep search...`);
        const enrichResult = await apiFetch(`/leads/${lead.id}/enrich`, {
          method: 'POST',
          body: JSON.stringify({ bloq_id: boardId }),
        });

        const foundEmails = enrichResult?.data?.found_contacts?.emails || [];
        const rejectedEmails = enrichResult?.data?.found_contacts?.rejected_emails || [];
        if (enrichResult.success && foundEmails.length > 0) {
          await apiFetch(`/leads/${lead.id}/apply-enrichment`, {
            method: 'POST',
            body: JSON.stringify({ email: foundEmails[0] }),
          }).catch(() => {});
          lead.contact_info = lead.contact_info || {};
          lead.contact_info.email = foundEmails[0];
          const deepScore = computeLeadScore(lead);
          await stampEnrichmentResult(lead.id, 'found', lead).catch(() => {});
          enriched++;
          const rejectNote = rejectedEmails.length > 0 ? ` (${rejectedEmails.length} irrelevant filtered)` : '';
          console.log(`${prefix}   [${i + 1}/${enrichLimit}] ${leadName} → ${foundEmails[0]} ✓ (deep, score: ${deepScore})${rejectNote}`);
        } else {
          const failScore = computeLeadScore(lead);
          await stampEnrichmentResult(lead.id, 'no_email', lead).catch(() => {});
          failed++;
          const rejectNote = rejectedEmails.length > 0
            ? ` (found ${rejectedEmails.map(r => r.email || r).join(', ')} but rejected as irrelevant)`
            : '';
          console.log(`${prefix}   [${i + 1}/${enrichLimit}] ${leadName} — no email found (score: ${failScore}, retry in ${ENRICH_COOLDOWN_DAYS}d)${rejectNote}`);
        }
      } else {
        failed++;
        console.log(`${prefix}   [${i + 1}/${enrichLimit}] ${leadName} — no data found`);
      }

      await sleep(3000); // rate limit between deep enrichments
    } catch (err) {
      await stampEnrichmentResult(lead.id, 'error', lead).catch(() => {});
      failed++;
      console.log(`${prefix}   [${i + 1}/${enrichLimit}] ${leadName} — error: ${err.message?.substring(0, 60)}`);
      await sleep(2000);
    }
  }

  process.stdout.write(`\r${' '.repeat(100)}\r`); // clear progress bar
  const enrichElapsed = ((Date.now() - enrichStart) / 1000).toFixed(0);
  const afterCoverage = Math.round(100 * (leads.length - missing.length + enriched) / leads.length);
  console.log(`${prefix} Done: ${enriched} enriched, ${failed} failed. Coverage: ${afterCoverage}% [${enrichElapsed}s]`);
  return { total: leads.length, missing: missing.length, enriched, failed };
}

async function runPreFlightEnrichment(campaignList) {
  const shouldEnrich = enrich !== null ? enrich : (outreachMode === 'email');
  if (!shouldEnrich) return;

  console.log('');
  console.log('  ┌──────────────────────────────────────────────────┐');
  console.log('  │  PRE-FLIGHT ENRICHMENT                           │');
  console.log(`  │  Goal: ${enrichGoal.padEnd(43)}│`);
  console.log(`  │  Campaigns: ${campaignList.length.toString().padEnd(38)}│`);
  console.log('  └──────────────────────────────────────────────────┘');
  console.log('');

  const results = [];
  for (const campaign of campaignList) {
    const reg = campaignRegistry[campaign];
    if (!reg?.boardId) continue;
    const result = await enrichCampaignLeads(campaign, reg.boardId, enrichGoal);
    results.push({ campaign, ...result });
  }

  // ── IG HANDLE RESOLUTION (for venue-type leads with websites but no IG handle) ──
  for (const campaign of campaignList) {
    const reg = campaignRegistry[campaign];
    if (!reg?.boardId) continue;
    await resolveInstagramHandles(campaign, reg.boardId);
  }

  // Summary
  const totalEnriched = results.reduce((s, r) => s + r.enriched, 0);
  const totalMissing = results.reduce((s, r) => s + r.missing, 0);
  console.log('');
  console.log(`  Enrichment complete: ${totalEnriched}/${totalMissing} leads enriched`);
  console.log('');

  return results;
}

/**
 * Resolve Instagram handles from website URLs for leads that have
 * a website but no IG handle. Typically venue/business leads.
 */
async function resolveInstagramHandles(campaignName, boardId) {
  const prefix = `\x1b[33m[enrich]\x1b[0m`;

  // Fetch all leads for this board
  const page1 = await apiFetch(`/leads?bloq_id=${boardId}&per_page=100&page=1`);
  const leads = page1?.data || [];
  if (leads.length === 0) return;

  // Filter: has website, no IG handle, not a social-handle-looking nickname
  const needsIg = leads.filter(l => {
    const ci = l.contact_info || {};
    const hasWebsite = !!l.website;
    const hasIg = !!(ci.instagram || ci.social_handle || l.twitter || l.social_handle);
    // Skip leads whose nickname already looks like an IG handle (no spaces, no uppercase-heavy)
    const nicknameIsHandle = l.nickname && !l.nickname.includes(' ') && /^[a-z0-9._]+$/.test(l.nickname);
    return hasWebsite && !hasIg && !nicknameIsHandle;
  });

  if (needsIg.length === 0) return;

  console.log(`${prefix} Resolving Instagram handles for ${needsIg.length} ${campaignName} leads with websites...`);

  let resolved = 0, failed = 0;
  const resolveLimit = Math.min(needsIg.length, 15);

  for (let i = 0; i < resolveLimit; i++) {
    const lead = needsIg[i];
    const name = lead.nickname || lead.name || `lead ${lead.id}`;
    try {
      const result = await apiFetch(`/leads/${lead.id}/resolve-instagram`, { method: 'POST' });
      if (result?.success && result?.instagram) {
        resolved++;
        console.log(`${prefix}   [${i + 1}/${resolveLimit}] ${name} → @${result.instagram} ✓ (from website)`);
      } else {
        failed++;
        console.log(`${prefix}   [${i + 1}/${resolveLimit}] ${name} — no IG found on website`);
      }
    } catch (err) {
      failed++;
      console.log(`${prefix}   [${i + 1}/${resolveLimit}] ${name} — error: ${err.message?.substring(0, 60)}`);
    }
    await sleep(2000); // rate limit FireCrawl calls
  }

  if (resolved > 0 || failed > 0) {
    console.log(`${prefix} IG resolution: ${resolved} found, ${failed} failed`);
  }
}

async function countdown(totalMs) {
  const barWidth = 40;
  const start = Date.now();
  const resumeAt = new Date(start + totalMs);
  console.log(`\n  ⏳ Next batch at ${formatTime(resumeAt)} (${formatDuration(totalMs)})\n`);
  while (true) {
    const elapsed = Date.now() - start;
    if (elapsed >= totalMs) break;
    const pct = elapsed / totalMs;
    const filled = Math.round(pct * barWidth);
    const bar = '▓'.repeat(filled) + '░'.repeat(barWidth - filled);
    process.stdout.write(`\r  ${bar}  ${formatDuration(totalMs - elapsed)} remaining  `);
    await sleep(1000);
  }
  process.stdout.write('\r' + ' '.repeat(80) + '\r');
}

// ── Run one campaign ─────────────────────────────────────────────

function runCampaign(campaign, index, total) {
  const reg = campaignRegistry[campaign] || { color: '', label: campaign };
  const prefix = `${reg.color}[${campaign.padEnd(10)}]${reset}`;

  return new Promise((resolve) => {
    console.log(`${prefix} ── Campaign ${index + 1}/${total}: ${reg.label} ──\n`);

    const startTime = Date.now();
    const child = spawn('node', [somScript, campaign, ...args], {
      cwd: __dirname,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n')) {
        if (line.trim()) process.stdout.write(`${prefix} ${line}\n`);
      }
    });

    child.stderr.on('data', (data) => {
      for (const line of data.toString().split('\n')) {
        if (line.trim()) process.stderr.write(`${prefix} ${line}\n`);
      }
    });

    child.on('exit', (code) => {
      const elapsed = formatDuration(Date.now() - startTime);
      const status = code === 0 ? '✓' : '✗';
      console.log(`\n${prefix} ${status} ${reg.label} finished in ${elapsed} (code ${code})\n`);
      resolve(code);
    });
  });
}

// ── Main ─────────────────────────────────────────────────────────

// ── Run campaigns in parallel ────────────────────────────────────

function runAllParallel(campaignList) {
  const maxParallel = parseInt(process.env.SOM_MAX_PARALLEL || '3', 10);

  // If throttled, run in batches instead of all-at-once
  if (maxParallel < campaignList.length) {
    return new Promise(async (resolve) => {
      const results = [];
      for (let batch = 0; batch < campaignList.length; batch += maxParallel) {
        const chunk = campaignList.slice(batch, batch + maxParallel);
        console.log(`  ── Batch ${Math.floor(batch/maxParallel)+1}/${Math.ceil(campaignList.length/maxParallel)}: ${chunk.join(', ')} ──`);
        const batchResults = await runAllParallel.__raw(chunk);
        results.push(...batchResults);
        if (batch + maxParallel < campaignList.length) {
          console.log('  Waiting 10s before next batch...\n');
          await sleep(10000);
        }
      }
      resolve(results);
    });
  }

  return runAllParallel.__raw(campaignList);
}

runAllParallel.__raw = function(campaignList) {
  return new Promise((resolve) => {
    const results = [];
    let exited = 0;
    const STAGGER_MS = 5000; // 5s between each browser launch to avoid OOM

    for (let i = 0; i < campaignList.length; i++) {
      const campaign = campaignList[i];
      const reg = campaignRegistry[campaign] || { color: '', label: campaign };
      const prefix = `${reg.color}[${campaign.padEnd(10)}]${reset}`;

      // Stagger launches — each campaign starts 5s after the previous one
      setTimeout(() => {
        const startTime = Date.now();
        const child = spawn('node', [somScript, campaign, ...args], {
          cwd: __dirname,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        child.stdout.on('data', (data) => {
          for (const line of data.toString().split('\n')) {
            if (line.trim()) process.stdout.write(`${prefix} ${line}\n`);
          }
        });

        child.stderr.on('data', (data) => {
          for (const line of data.toString().split('\n')) {
            if (line.trim()) process.stderr.write(`${prefix} ${line}\n`);
          }
        });

        child.on('exit', (code) => {
          const elapsed = formatDuration(Date.now() - startTime);
          const status = code === 0 ? '✓' : '✗';
          console.log(`\n${prefix} ${status} ${reg.label} finished in ${elapsed} (code ${code})\n`);
          results.push({ campaign, code, elapsed });
          exited++;
          if (exited === campaignList.length) resolve(results);
        });
      }, i * STAGGER_MS); // stagger each launch
    }

    // Forward Ctrl+C to all children
    process.on('SIGINT', () => {
      console.log('\n  Stopping all campaigns...\n');
      process.exit(0);
    });
  });
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  // ── LOCK FILE — prevent duplicate SOM runs ──────────────────────
  const fs = require('fs');
  const LOCK_FILE = '/tmp/som_batch.lock';

  if (fs.existsSync(LOCK_FILE)) {
    try {
      const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
      const age = Date.now() - lock.started;
      const maxAge = 30 * 60 * 1000; // 30 min stale threshold

      if (age < maxAge) {
        console.log('');
        console.log('  ╔══════════════════════════════════════════════════╗');
        console.log('  ║  ⏭  SOM BATCH ALREADY RUNNING — EXITING        ║');
        console.log(`  ║  PID: ${String(lock.pid).padEnd(10)} Started: ${new Date(lock.started).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }).padEnd(22)}║`);
        console.log(`  ║  Age: ${formatDuration(age).padEnd(44)}║`);
        console.log('  ╚══════════════════════════════════════════════════╝');
        console.log('');
        process.exit(0);
      } else {
        console.log(`  ⚠️  Stale lock (${formatDuration(age)} old, PID ${lock.pid}) — removing`);
        fs.unlinkSync(LOCK_FILE);
      }
    } catch {
      // Corrupt lock file — remove it
      try { fs.unlinkSync(LOCK_FILE); } catch {}
    }
  }

  // Write lock
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, started: Date.now() }));

  // Remove lock on ANY exit (clean, error, SIGINT, SIGTERM)
  const removeLock = () => { try { fs.unlinkSync(LOCK_FILE); } catch {} };
  process.on('exit', removeLock);
  process.on('SIGINT', () => { removeLock(); process.exit(130); });
  process.on('SIGTERM', () => { removeLock(); process.exit(143); });
  process.on('uncaughtException', (err) => { console.error(err); removeLock(); process.exit(1); });

  const totalStart = Date.now();
  let runNum = 0;

  // ── PRE-FLIGHT: kill orphaned SOM processes from previous runs ──
  try {
    const { execSync } = require('child_process');
    const myPid = process.pid;
    const myPpid = process.ppid;
    const psOut = execSync("ps aux | grep '[s]om-all.js' || true", { encoding: 'utf-8' });
    const otherPids = psOut.split('\n')
      .filter(l => l.trim())
      .map(l => parseInt(l.trim().split(/\s+/)[1]))
      .filter(pid => pid !== myPid && pid !== myPpid && !isNaN(pid));
    if (otherPids.length > 0) {
      console.log(`  ⚠️  PRE-FLIGHT: Killing ${otherPids.length} orphaned som-all process(es): ${otherPids.join(', ')}`);
      for (const pid of otherPids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    }

    const pwOrphans = parseInt(execSync("ps aux | grep '[m]s-playwright.*chromium' | grep -v grep | wc -l || echo 0", { encoding: 'utf-8' }).trim(), 10) || 0;
    if (pwOrphans > 6) {
      console.log(`  ⚠️  PRE-FLIGHT: ${pwOrphans} orphaned Playwright browsers — killing`);
      execSync("pkill -f 'ms-playwright.*chromium' || true", { timeout: 5000 });
    }
  } catch {}

  const modeLabel = parallel ? 'PARALLEL' : 'SEQUENTIAL';
  const loopLabel = maxLoops > 0 ? ` x${maxLoops}` : repeatMs ? ' (∞)' : '';
  const repeatLabel = repeatMs ? ` every ${formatDuration(repeatMs)}` : '';

  console.log('');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log(`  ║  SOM — OUTREACH BATCH (${modeLabel.padEnd(11)})            ║`);
  console.log(`  ║  Campaigns: ${campaigns.join(', ').padEnd(38)}║`);
  console.log(`  ║  Args: ${(args.join(' ') || 'limit=15').padEnd(43)}║`);
  if (repeatMs) {
    console.log(`  ║  Schedule: ${(repeatLabel + loopLabel).padEnd(39)}║`);
  }
  console.log(`  ║  Started: ${formatTime(new Date()).padEnd(39)}║`);
  console.log('  ╚══════════════════════════════════════════════════╝');
  console.log('');

  // ── Resource check — auto-throttle if system is stressed ──
  if (parallel && campaigns.length > 2) {
    try {
      const os = require('os');
      const cpus = os.cpus().length;
      const freeMem = Math.round(os.freemem() / 1024 / 1024 / 1024 * 10) / 10; // GB
      const totalMem = Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10;
      const loadAvg = os.loadavg()[0]; // 1-min load average
      const loadPct = Math.round((loadAvg / cpus) * 100);

      // Battery check (macOS)
      let battery = null;
      let isCharging = true;
      try {
        const { execSync } = require('child_process');
        const pmset = execSync('pmset -g batt 2>/dev/null', { timeout: 3000 }).toString();
        const pctMatch = pmset.match(/(\d+)%/);
        if (pctMatch) battery = parseInt(pctMatch[1]);
        isCharging = pmset.includes('AC Power') || pmset.includes('charging');
      } catch {}

      console.log('  ── Resource Check ──');
      console.log(`  CPU: ${cpus} cores, load: ${loadPct}%`);
      console.log(`  Memory: ${freeMem}GB free / ${totalMem}GB total`);
      if (battery !== null) {
        console.log(`  Battery: ${battery}% ${isCharging ? '(charging)' : '(battery)'}`);
      }

      const maxParallel = (freeMem < 2 || loadPct > 80 || (battery !== null && battery < 30 && !isCharging))
        ? 2
        : (freeMem < 4 || loadPct > 50)
          ? 3
          : campaigns.length;

      if (maxParallel < campaigns.length) {
        console.log(`  ⚠️  Throttling: ${maxParallel} campaigns at a time (was ${campaigns.length})`);
        console.log(`     Reason: ${freeMem < 2 ? 'low memory' : loadPct > 80 ? 'high CPU' : 'low battery'}`);
        process.env.SOM_MAX_PARALLEL = String(maxParallel);
      } else {
        console.log(`  ✅ Resources OK — running ${campaigns.length} campaigns in parallel`);
      }
      console.log('');
    } catch (e) {
      // Resource check is best-effort, don't block on errors
    }
  }

  // ── Pre-flight enrichment (runs once before first batch) ──
  await runPreFlightEnrichment(campaigns);

  // ── Pre-flight lead check — skip campaigns with 0 eligible leads ──
  const eligibleCampaigns = [];
  const skippedCampaigns = [];
  const filterLabel = leadFilter === 'followup' ? 'FOLLOW-UP' : 'NEW LEADS';
  console.log('  ┌──────────────────────────────────────────────────┐');
  console.log(`  │  LEAD ELIGIBILITY CHECK (${filterLabel.padEnd(24)})│`);
  console.log('  └──────────────────────────────────────────────────┘');
  for (const c of campaigns) {
    const reg = campaignRegistry[c];
    if (!reg || !reg.boardId) {
      eligibleCampaigns.push(c);
      continue;
    }
    const pf = await preflightCheck(reg.boardId, reg.strategy, { mode: leadFilter, waitDays });
    if (pf.skip) {
      console.log(`  ⏭  ${c} (board ${reg.boardId}): ${pf.reason} — SKIPPING`);
      skippedCampaigns.push(c);
    } else {
      console.log(`  ✓  ${c} (board ${reg.boardId}): ${pf.reason}`);
      eligibleCampaigns.push(c);
    }
  }

  if (skippedCampaigns.length > 0) {
    console.log(`\n  Skipped ${skippedCampaigns.length} exhausted campaign(s): ${skippedCampaigns.join(', ')}`);
  }
  if (eligibleCampaigns.length === 0) {
    console.log('\n  All campaigns exhausted — nothing to run. Exiting.');
    process.exit(0);
  }
  console.log(`\n  Running ${eligibleCampaigns.length} campaign(s): ${eligibleCampaigns.join(', ')}\n`);

  // Replace campaigns list with only eligible ones
  campaigns = eligibleCampaigns;

  while (true) {
    runNum++;
    if (repeatMs) {
      console.log(`  ── BATCH ${runNum}${maxLoops ? '/' + maxLoops : ''} ── ${formatTime(new Date())} ──\n`);
    }

    let results;
    if (parallel) {
      results = await runAllParallel(campaigns);
    } else {
      results = [];
      for (let i = 0; i < campaigns.length; i++) {
        const code = await runCampaign(campaigns[i], i, campaigns.length);
        results.push({ campaign: campaigns[i], code });
      }
    }

    // Summary
    const batchElapsed = formatDuration(Date.now() - totalStart);
    console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  BATCH COMPLETE — ${formatTime(new Date())} (total: ${batchElapsed})`);
    for (const r of results) {
      const reg = campaignRegistry[r.campaign] || {};
      const icon = r.code === 0 ? '✓' : '✗';
      console.log(`    ${icon} ${(reg.label || r.campaign).padEnd(25)} ${r.elapsed || ''}`);
    }
    console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // Repeat?
    if (!repeatMs) break;
    if (maxLoops > 0 && runNum >= maxLoops) {
      console.log(`\n  Completed ${maxLoops} batches. Done.\n`);
      break;
    }

    await countdown(repeatMs);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
