import { test } from '@playwright/test';
import { AuthHelper } from './helpers/auth-helper';
import { LeadgenApiClient } from './helpers/leadgen-api-client';
import { InstagramCommentsProvider } from './helpers/providers/instagram-comments-provider';
import { InstagramFollowersProvider } from './helpers/providers/instagram-followers-provider';
import { InstagramProfilesProvider } from './helpers/providers/instagram-profiles-provider';
import { InstagramInboxProvider } from './helpers/providers/instagram-inbox-provider';
import {
  BaseDiscoveryProvider,
  DiscoveredProfile,
  DiscoveryConfig,
  QualificationConfig,
  QualifiedProfile,
  dismissInstagramPopups,
  scrapeProfileStats,
} from './helpers/providers/base-provider';
import { ProgressManager } from './helpers/progress-manager';
import * as fs from 'fs';
import * as path from 'path';

// ── ENV CONFIG ─────────────────────────────────────────────────────
const TOKEN = process.env.HEYIRIS_TOKEN || (() => { throw new Error("HEYIRIS_TOKEN is not set. The hardcoded fallback here was a leaked admin token, rotated 2026-09-18 — set HEYIRIS_TOKEN to your own IRIS token.") })();
const BOARD_ID = parseInt(process.env.BOARD_ID || '38', 10);
const LIMIT = parseInt(process.env.LIMIT || '200', 10);
const IG_ACCOUNT = process.env.IG_ACCOUNT || 'heyiris.io';
const DISCOVERY_MODE = process.env.DISCOVERY_MODE || 'comments';
const TARGET_URL = process.env.TARGET_URL || '';
const AUTO_ENRICH = process.env.AUTO_ENRICH === '1';
const DRY_RUN = process.env.DRY_RUN === '1';
const CAMPAIGN_LABEL = process.env.CAMPAIGN_LABEL || 'Leadgen';
const USER_ID = parseInt(process.env.USER_ID || '193', 10);

// Scalability env vars
const SCROLL_DELAY = parseInt(process.env.SCROLL_DELAY || '3000', 10);
const API_BATCH_SIZE = parseInt(process.env.API_BATCH_SIZE || '5', 10);
const API_BATCH_DELAY = parseInt(process.env.API_BATCH_DELAY || '500', 10);
const RESUME = process.env.RESUME === '1';
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, '../../test-results/leadgen');

// Filter env vars
const FILTER_MIN_FOLLOWERS = parseInt(process.env.FILTER_MIN_FOLLOWERS || '0', 10);
const FILTER_MAX_FOLLOWERS = parseInt(process.env.FILTER_MAX_FOLLOWERS || '0', 10);
const FILTER_VERIFIED_ONLY = process.env.FILTER_VERIFIED_ONLY === '1';
const FILTER_BUSINESS_ONLY = process.env.FILTER_BUSINESS_ONLY === '1';

const HAS_QUALIFICATION_FILTERS = FILTER_MIN_FOLLOWERS > 0 || FILTER_MAX_FOLLOWERS > 0 ||
  FILTER_VERIFIED_ONLY || FILTER_BUSINESS_ONLY;

const IG_AUTH_FILE = process.env.BROWSER_SESSION_FILE
  || path.join(__dirname, `instagram-auth-${IG_ACCOUNT}.json`);
const IG_AUTH_LEGACY = path.join(__dirname, 'instagram-auth.json');

// ── HELPERS ────────────────────────────────────────────────────────

function formatCount(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// ── MAIN TEST ──────────────────────────────────────────────────────

test(`Leadgen — ${CAMPAIGN_LABEL} (${DISCOVERY_MODE})`, async ({ page, context }) => {

  // ── 1. AUTH (HeyIRIS) ──
  await AuthHelper.loginWithToken(page, TOKEN);
  const apiClient = new LeadgenApiClient(TOKEN, BOARD_ID);

  // ── 2. AUTH (Instagram) ──
  const igFile = fs.existsSync(IG_AUTH_FILE) ? IG_AUTH_FILE
    : fs.existsSync(IG_AUTH_LEGACY) ? IG_AUTH_LEGACY : null;
  if (igFile) {
    const state = JSON.parse(fs.readFileSync(igFile, 'utf-8'));
    if (state.cookies?.length > 0) {
      await context.addCookies(state.cookies);
      console.log(`  Instagram session loaded for @${IG_ACCOUNT} (${state.cookies.length} cookies)`);
    }
  } else {
    console.log(`  No instagram-auth-${IG_ACCOUNT}.json — log it in first: iris som login ${IG_ACCOUNT} --node <this machine>`);
    console.log(`  iris som login ${IG_ACCOUNT}  (or on this Mac: node som/login.js ${IG_ACCOUNT})\n`);
    return;
  }

  // ── 3. BANNER ──
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │  L E A D G E N   D I S C O V E R Y          │');
  console.log('  └──────────────────────────────────────────────┘');
  console.log(`  Campaign:  ${CAMPAIGN_LABEL}`);
  console.log(`  Board:     ${BOARD_ID}`);
  console.log(`  Mode:      ${DISCOVERY_MODE}`);
  console.log(`  Target:    ${TARGET_URL || `(latest from @${IG_ACCOUNT})`}`);
  console.log(`  Limit:     ${LIMIT} qualified leads`);
  if (FILTER_MIN_FOLLOWERS) console.log(`  Filter:    min ${formatCount(FILTER_MIN_FOLLOWERS)} followers`);
  if (FILTER_MAX_FOLLOWERS) console.log(`  Filter:    max ${formatCount(FILTER_MAX_FOLLOWERS)} followers`);
  if (FILTER_VERIFIED_ONLY) console.log(`  Filter:    verified only`);
  if (AUTO_ENRICH) console.log(`  Enrich:    YES`);
  if (DRY_RUN) console.log(`  DRY RUN:   discover only — no API calls`);
  console.log('');

  // ── 4. SELECT PROVIDER ──
  let provider: BaseDiscoveryProvider;
  if (DISCOVERY_MODE === 'inbox') {
    provider = new InstagramInboxProvider();
  } else if (DISCOVERY_MODE === 'followers') {
    provider = new InstagramFollowersProvider();
  } else if (DISCOVERY_MODE === 'profiles') {
    provider = new InstagramProfilesProvider();
  } else {
    provider = new InstagramCommentsProvider();
  }

  // ── 5. BUILD CONFIG ──
  let targetUrl = TARGET_URL;
  if (DISCOVERY_MODE === 'inbox') {
    targetUrl = `https://www.instagram.com/direct/inbox/`;
  } else if (!targetUrl) {
    targetUrl = `https://www.instagram.com/${IG_ACCOUNT}/`;
  }
  // Normalize IG URL: /reels/ → /reel/, strip ?igsh= tracking params
  if (targetUrl) {
    targetUrl = targetUrl.replace('/reels/', '/reel/').split('?')[0];
    // Only a URL gets a trailing slash. In profiles mode the target is "@a,@b", and appending "/"
    // made the LAST handle "@b/" — which is what got stored as the lead.
    if (/^https?:\/\//.test(targetUrl) && !targetUrl.endsWith('/')) targetUrl += '/';
  }

  // For comments/followers, overshoot the scrape limit when qualification is needed
  const scrapeLimit = HAS_QUALIFICATION_FILTERS && DISCOVERY_MODE !== 'profiles'
    ? LIMIT * 5  // Scrape 5x the target to account for filtering
    : LIMIT;

  // Pre-fetch existing handles so we skip them during scraping (limit = NEW leads only)
  console.log(`  Checking for existing leads on board ${BOARD_ID}...`);
  const existingHandles = await apiClient.getExistingHandles();
  console.log(`  Found ${existingHandles.size} existing handles (will skip during scrape)`);

  const config: DiscoveryConfig = {
    targetUrl,
    limit: scrapeLimit,
    scrollAttempts: Math.ceil(scrapeLimit / 8) + 15,
    scrollDelay: SCROLL_DELAY,
    existingHandles,
  };

  // ── 6. DISCOVER ──
  console.log(`  Discovering profiles (${DISCOVERY_MODE})...`);
  let result: Awaited<ReturnType<typeof provider.discover>>;
  try {
    result = await provider.discover(page, context, config);
  } catch (discoverErr: any) {
    // If browser was closed early (user cancelled), the provider may have partial results
    // Return whatever was collected so far
    console.log(`  ⚠️  Discovery interrupted: ${discoverErr.message?.substring(0, 80)}`);
    console.log(`  Proceeding with any profiles collected before interruption...`);
    result = { profiles: [], totalScraped: 0, totalAfterFilter: 0, durationMs: 0, errors: [discoverErr.message] };
  }
  console.log(`  Scraped: ${result.totalScraped} unique usernames`);
  if (result.errors.length > 0) {
    result.errors.forEach(e => console.log(`  Error: ${e}`));
  }

  // ── 7. SELF-FILTER ──
  let cleaned = result.profiles.filter(p => {
    const handle = p.username.toLowerCase().replace(/^@/, '');
    if (handle === IG_ACCOUNT.toLowerCase()) return false;
    if (handle === 'instagram') return false;
    return true;
  });
  console.log(`  After self-filter: ${cleaned.length}`);

  // ── 8. QUALIFY (if filters set) ──
  let qualified: (DiscoveredProfile | QualifiedProfile)[] = cleaned;
  let qualifyStats = { checked: 0, passed: 0, failed: 0, errors: 0 };

  if (HAS_QUALIFICATION_FILTERS && DISCOVERY_MODE !== 'profiles') {
    // For comments/followers, we need to visit each profile to check follower count
    console.log(`\n  Qualifying ${cleaned.length} profiles (min: ${formatCount(FILTER_MIN_FOLLOWERS || 0)})...`);
    qualified = [];

    for (let i = 0; i < cleaned.length && qualified.length < LIMIT; i++) {
      const p = cleaned[i];
      qualifyStats.checked++;

      try {
        await page.goto(`https://www.instagram.com/${p.username}/`);
        await page.waitForTimeout(2000);
        if (i === 0) await dismissInstagramPopups(page);

        const stats = await scrapeProfileStats(page);

        const meetsMinFollowers = !FILTER_MIN_FOLLOWERS || stats.followers >= FILTER_MIN_FOLLOWERS;
        const meetsMaxFollowers = !FILTER_MAX_FOLLOWERS || stats.followers <= FILTER_MAX_FOLLOWERS;
        const meetsVerified = !FILTER_VERIFIED_ONLY || stats.isVerified;
        const meetsBusiness = !FILTER_BUSINESS_ONLY || !!stats.category;

        const pass = meetsMinFollowers && meetsMaxFollowers && meetsVerified && meetsBusiness;

        const icon = pass ? '✓' : '✗';
        console.log(`    [${qualifyStats.checked}/${cleaned.length}] @${p.username} — ${formatCount(stats.followers)} followers ${icon}`);

        if (pass) {
          qualifyStats.passed++;
          qualified.push({
            ...p,
            rawMetadata: {
              ...p.rawMetadata,
              followers: stats.followers,
              following: stats.following,
              posts: stats.posts,
              bio: stats.bio,
              isVerified: stats.isVerified,
              isPrivate: stats.isPrivate,
              externalUrl: stats.externalUrl,
            },
          } as QualifiedProfile);
        } else {
          qualifyStats.failed++;
        }
      } catch (err: any) {
        qualifyStats.errors++;
        console.log(`    [${qualifyStats.checked}/${cleaned.length}] @${p.username} — error: ${err.message?.substring(0, 60)}`);
      }
    }

    console.log(`  Qualification: ${qualifyStats.passed} passed, ${qualifyStats.failed} failed, ${qualifyStats.errors} errors`);
  }

  // Limit to requested count
  const finalProfiles = qualified.slice(0, LIMIT);

  // ── 9. DRY RUN EXIT ──
  if (DRY_RUN) {
    // Machine-readable result for callers (`iris reachr scrape --instagram`), only when asked for:
    // the console summary is for people, and parsing it is how a caller breaks on a wording change.
    if (process.env.RESULT_FILE) {
      fs.writeFileSync(process.env.RESULT_FILE, JSON.stringify({
        mode: DISCOVERY_MODE,
        target: targetUrl,
        ig_account: IG_ACCOUNT,
        scraped: result.totalScraped,
        existing_skipped: existingHandles.size,
        profiles: finalProfiles,
        errors: result.errors,
        // Follower-filter outcome for `iris reachr scrape --min/--max-followers` (#186254). Only when
        // filters ran, so "no qualification" still means "not asked", never "zero kept".
        ...(qualifyStats.checked > 0 ? { qualification: qualifyStats } : {}),
      }));
    }
    printSummary({
      label: 'DRY RUN',
      scraped: result.totalScraped,
      qualified: qualifyStats.checked > 0 ? qualifyStats.passed : finalProfiles.length,
      created: 0, duplicates: 0, enriched: 0, errors: 0,
      duration: Date.now(),
      profiles: finalProfiles,
    });
    return;
  }

  // ── 10. PROGRESS MANAGER (handles resume from interrupted runs) ──
  const progress = ProgressManager.loadOrCreate(OUTPUT_DIR, {
    targetUrl: TARGET_URL || targetUrl,
    boardId: BOARD_ID,
    limit: LIMIT,
    discoveryMode: DISCOVERY_MODE,
  });

  // If resuming, use profiles from the saved progress file instead of re-scraping
  let profilesToCreate = finalProfiles;
  if (RESUME && progress.state.profiles.length > 0 && finalProfiles.length === 0) {
    console.log(`\n  Resuming: using ${progress.state.profiles.length} profiles from previous session`);
    profilesToCreate = progress.state.profiles;
  } else {
    progress.addDiscoveredProfiles(finalProfiles);
  }

  // Skip profiles already created in a previous attempt (resume-safe)
  const alreadyCreated = new Set(
    progress.state.creation.results
      .filter(r => r.status === 'created' || r.status === 'duplicate')
      .map(r => r.username.toLowerCase().replace(/^@/, ''))
  );
  if (alreadyCreated.size > 0) {
    console.log(`  Skipping ${alreadyCreated.size} profiles already created in previous attempt`);
  }

  progress.setPhase('creating');

  // ── 11. PRE-FLIGHT DEDUP (second pass — catches any missed by scraper-level skip) ──
  const newProfiles = profilesToCreate.filter(p => {
    const handle = p.username.toLowerCase().replace(/^@/, '');
    if (alreadyCreated.has(handle)) return false;
    return !existingHandles.has(handle);
  });
  const localDupes = finalProfiles.length - newProfiles.length;
  if (localDupes > 0) console.log(`\n  Skipping ${localDupes} duplicates (already on board)`);

  // ── 12. RESOLVE TAGS ──
  const tagDefs = [
    { name: 'Leadgen Import', color: '#3B82F6' },
    { name: `IG ${DISCOVERY_MODE.charAt(0).toUpperCase() + DISCOVERY_MODE.slice(1)}`, color: '#E1306C' },
    { name: CAMPAIGN_LABEL, color: '#8B5CF6' },
    ...(FILTER_MIN_FOLLOWERS ? [{ name: `${Math.round(FILTER_MIN_FOLLOWERS / 1000)}K+ Followers`, color: '#10B981' }] : []),
  ];
  console.log(`\n  Resolving ${tagDefs.length} tags...`);
  const tagIds = await apiClient.resolveTags(USER_ID, tagDefs);
  if (tagIds.length > 0) {
    console.log(`  Tags: ${tagDefs.map((t, i) => `${t.name} (#${tagIds[i] || '?'})`).join(', ')}`);
  }

  // ── 13. BUILD PAYLOADS ──
  const importMeta = {
    campaign: CAMPAIGN_LABEL,
    discovery_mode: DISCOVERY_MODE,
    ig_account: IG_ACCOUNT,
    board_id: BOARD_ID,
    source_post_url: TARGET_URL || targetUrl,
    import_date: new Date().toISOString(),
    ...(FILTER_MIN_FOLLOWERS ? { min_followers_filter: FILTER_MIN_FOLLOWERS } : {}),
    ...(FILTER_MAX_FOLLOWERS ? { max_followers_filter: FILTER_MAX_FOLLOWERS } : {}),
    ...(FILTER_VERIFIED_ONLY ? { verified_only_filter: true } : {}),
    ...(FILTER_BUSINESS_ONLY ? { business_only_filter: true } : {}),
    ...(AUTO_ENRICH ? { auto_enriched: true } : {}),
  };

  const payloads = newProfiles.map(profile => {
    // Use display name if available (from profile scrape or comments), fall back to @handle
    const displayName = profile.displayName && profile.displayName !== profile.username
      ? profile.displayName
      : null;
    return {
    name: displayName || `@${profile.username}`,
    nickname: `@${profile.username}`,
    source: `leadgen:${provider.platform}:${provider.discoveryType}`,
    contact_info: {
      instagram: profile.username,
      instagram_url: `https://www.instagram.com/${profile.username}/`,
    },
    ...(tagIds.length > 0 ? { tags: tagIds } : {}),
    custom_fields: {
      comment: profile.rawMetadata?.commentText || '',
      time_posted: profile.rawMetadata?.timestamp || '',
      discovery_source: profile.sourceContext,
      source_post_url: TARGET_URL || targetUrl,
      ...(profile.rawMetadata?.followers ? { ig_followers: profile.rawMetadata.followers } : {}),
      ...(profile.rawMetadata?.bio ? { ig_bio: profile.rawMetadata.bio } : {}),
      ...importMeta,
    },
  }}); // close return + map

  // ── 14. CREATE LEADS (BATCHED) ──
  const createStart = Date.now();
  const createdLeadIds: number[] = [];

  console.log(`\n  Creating ${payloads.length} leads (batch size: ${API_BATCH_SIZE})...`);
  const batchResult = await apiClient.createLeadsBatch(payloads, {
    concurrency: API_BATCH_SIZE,
    delayBetweenBatches: API_BATCH_DELAY,
    onProgress: (entry, index, total) => {
      const elapsed = Date.now() - createStart;
      const rate = elapsed > 0 ? Math.round((index + 1) / (elapsed / 60000)) : 0;
      const remaining = total - index - 1;
      const eta = rate > 0 ? `~${Math.ceil(remaining / rate)}m` : '...';

      if (entry.status === 'created') {
        createdLeadIds.push(entry.leadId!);
        console.log(`  [${index + 1}/${total}] @${entry.username} — created #${entry.leadId} | ${rate}/min | ETA: ${eta}`);
      } else if (entry.status === 'duplicate') {
        console.log(`  [${index + 1}/${total}] @${entry.username} — duplicate`);
      } else {
        console.log(`  [${index + 1}/${total}] @${entry.username} — error: ${entry.error?.substring(0, 60)}`);
      }

      progress.recordCreationResult(entry);
    },
  });
  const createDuration = Date.now() - createStart;

  const stats = {
    created: batchResult.created,
    duplicates: localDupes + batchResult.duplicates,
    enriched: 0,
    emailsFound: 0,
    errors: batchResult.errors,
  };

  // ── 14. AUTO-ENRICH (opt-in via AUTO_ENRICH=1) ──
  if (AUTO_ENRICH && createdLeadIds.length > 0) {
    const enrichStart = Date.now();
    console.log(`\n  Quick-enriching ${createdLeadIds.length} leads from Instagram...`);
    let totalScore = 0;
    let consecutiveFailures = 0;

    for (let i = 0; i < createdLeadIds.length; i++) {
      const leadId = createdLeadIds[i];
      const resp = await apiClient.quickEnrichInstagram(leadId);

      if (resp.success && resp.contacts) {
        stats.enriched++;
        consecutiveFailures = 0;
        const emails = resp.contacts.emails || [];
        const phones = resp.contacts.phones || [];
        const score = resp.contacts.score || 0;
        totalScore += score;
        if (emails.length > 0) stats.emailsFound++;

        const parts = [];
        if (emails.length > 0) parts.push(`email=${emails[0]}`);
        if (phones.length > 0) parts.push(`phone=${phones[0]}`);
        parts.push(`score=${score}`);
        console.log(`    [${i + 1}/${createdLeadIds.length}] #${leadId} — ${parts.join(', ')}`);
      } else {
        consecutiveFailures++;
        console.log(`    [${i + 1}/${createdLeadIds.length}] #${leadId} — ${resp.error || 'no contacts found'}`);

        // If IG is rate-limiting us, stop wasting API calls
        if (consecutiveFailures >= 5) {
          console.log(`    ⚠️  ${consecutiveFailures} consecutive failures — Instagram likely rate-limiting. Stopping enrichment.`);
          console.log(`    Remaining ${createdLeadIds.length - i - 1} leads can be enriched later via the UI.`);
          break;
        }
      }

      // Delay between calls to avoid IG rate limits — 4s base, longer after failures
      if (i < createdLeadIds.length - 1) {
        const enrichDelay = consecutiveFailures > 0 ? 6000 : 4000;
        await new Promise(r => setTimeout(r, enrichDelay));
      }
    }

    const enrichDuration = Date.now() - enrichStart;
    const avgScore = stats.enriched > 0 ? Math.round(totalScore / stats.enriched) : 0;
    console.log(`  Enrichment: ${stats.enriched}/${createdLeadIds.length} profiles fetched, ${stats.emailsFound} emails found, avg score ${avgScore} (${formatDuration(enrichDuration)})`);
  }

  // ── 15. COMPLETE ──
  progress.setPhase('complete');

  // ── 16. SUMMARY ──
  printSummary({
    label: 'BATCH COMPLETE',
    scraped: result.totalScraped,
    qualified: qualifyStats.checked > 0 ? qualifyStats.passed : finalProfiles.length,
    created: stats.created,
    duplicates: stats.duplicates,
    enriched: stats.enriched,
    emailsFound: stats.emailsFound,
    errors: stats.errors,
    duration: Date.now(),
    profiles: finalProfiles,
    createDuration,
    progressFile: progress.filePath,
  });
});

// ── SUMMARY PRINTER ────────────────────────────────────────────────

function printSummary(opts: {
  label: string;
  scraped: number;
  qualified: number;
  created: number;
  duplicates: number;
  enriched: number;
  emailsFound?: number;
  errors: number;
  duration: number;
  profiles: DiscoveredProfile[];
  createDuration?: number;
  progressFile?: string;
}) {
  console.log('\n');
  console.log('  ██╗     ███████╗ █████╗ ██████╗  ██████╗ ███████╗███╗   ██╗');
  console.log('  ██║     ██╔════╝██╔══██╗██╔══██╗██╔════╝ ██╔════╝████╗  ██║');
  console.log('  ██║     █████╗  ███████║██║  ██║██║  ███╗█████╗  ██╔██╗ ██║');
  console.log('  ██║     ██╔══╝  ██╔══██║██║  ██║██║   ██║██╔══╝  ██║╚██╗██║');
  console.log('  ███████╗███████╗██║  ██║██████╔╝╚██████╔╝███████╗██║ ╚████║');
  console.log('  ╚══════╝╚══════╝╚═╝  ╚═╝╚═════╝  ╚═════╝ ╚══════╝╚═╝  ╚═══╝');
  console.log('  L E A D   D I S C O V E R Y   E N G I N E');
  console.log('');
  console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ${opts.label}`);
  console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Board:     ${BOARD_ID}  |  Mode: ${DISCOVERY_MODE}`);
  console.log(`  Scraped:   ${opts.scraped}`);
  if (HAS_QUALIFICATION_FILTERS) console.log(`  Qualified: ${opts.qualified}`);
  if (opts.label !== 'DRY RUN') {
    console.log(`  Created:   ${opts.created}  |  Dupes: ${opts.duplicates}  |  Errors: ${opts.errors}`);
    if (opts.enriched > 0) {
      const emailStr = opts.emailsFound ? `  |  Emails: ${opts.emailsFound}` : '';
      console.log(`  Enriched:  ${opts.enriched}${emailStr}`);
    }
    if (opts.createDuration) console.log(`  API time:  ${formatDuration(opts.createDuration)}`);
  }
  console.log(`  Profiles:  ${opts.profiles.length}`);
  if (opts.progressFile) console.log(`  Progress:  ${opts.progressFile}`);
  console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Print top profiles table (up to 20) with comment preview
  if (opts.profiles.length > 0) {
    console.log('\n  Top Profiles:');
    const top = opts.profiles.slice(0, 20);
    for (const p of top) {
      const followers = p.rawMetadata?.followers;
      const fStr = followers ? ` (${formatCount(followers)})` : '';
      const verified = p.rawMetadata?.isVerified ? ' ✓' : '';
      const comment = p.rawMetadata?.commentText
        ? ` "${p.rawMetadata.commentText.substring(0, 40)}${p.rawMetadata.commentText.length > 40 ? '...' : ''}"`
        : '';
      console.log(`    @${p.username.padEnd(20)} ${fStr}${verified}${comment}`);
    }
    if (opts.profiles.length > 20) {
      console.log(`    ... and ${opts.profiles.length - 20} more`);
    }
  }
  console.log('');
}
