#!/usr/bin/env node
/**
 * SOM — Sales Outreach Machine
 *
 * Usage:
 *   node som.js <campaign> [key=value ...]
 *
 * Examples:
 *   node som.js courses limit=10
 *   node som.js creators limit=3 dry=1
 *   node som.js beatbox limit=5 personalize=1
 *   node som.js courses limit=2 strategy=creator-v1
 *   node som.js courses limit=20 repeat=3h
 *   node som.js courses limit=20 repeat=2h loop=5
 *
 * Modes:
 *   node som.js courses mode=outreach                    (default: DM outreach)
 *   node som.js lawfirms mode=email limit=5              (email outreach)
 *   node som.js lawfirms mode=email limit=10 dry=1       (email dry run)
 *   node som.js courses mode=engage platform=ig          (like + comment)
 *   node som.js courses mode=engage platform=twitter     (like + reply on X)
 *   node som.js courses mode=scrape platform=ig target=https://instagram.com/p/ABC limit=50
 */

const { execSync } = require('child_process');
const path = require('path');

// Import from shared config (single source of truth)
const somConfig = require('./som-config');
const campaigns = {
  // 'custom' is som.js-only (not in shared config)
  custom: { BOARD_ID: '38', STRATEGY: 'Custom Campaign', IG_ACCOUNT: 'heyiris.io', TW_ACCOUNT: 'freelabelnet' },
  // lawfirms is som.js-only (not in shared config)
  lawfirms: { BOARD_ID: '174', STRATEGY: 'SXSW — Law Firms in the Age of AI Event Invite', IG_ACCOUNT: 'heyiris.io', TW_ACCOUNT: 'freelabelnet' },
  // All standard campaigns from shared config
  ...somConfig.getSomCampaigns(),
};

// Mode → Playwright spec mapping (all specs are local to this directory)
const specs = {
  outreach: path.join(__dirname, 'batch-with-login.spec.ts'),
  email:    path.join(__dirname, 'email-batch-outreach.spec.ts'),
  engage:   path.join(__dirname, 'organic-engage.spec.ts'),
  scrape:   path.join(__dirname, 'leadgen-scraper.spec.ts'),
  followup: path.join(__dirname, 'inbox-followup.spec.ts'),
  venue:    path.join(__dirname, 'venue-outreach.spec.ts'),
  instagram_inbox_check: path.join(__dirname, 'instagram-inbox-check.spec.ts'),
  linkedin_inbox_check:  path.join(__dirname, 'linkedin-inbox-check.spec.ts'),
  instagram_follow_up:   path.join(__dirname, 'instagram-follow-up.spec.ts'),
  instagram_inbox:       path.join(__dirname, 'instagram-inbox.spec.ts'),
  whatsapp_inbox_check:  path.join(__dirname, 'whatsapp-inbox-check.spec.ts'),
};

// Short strategy aliases (from shared config + som.js-only extras)
const strategies = {
  ...somConfig.strategyAliases,
  // som.js-only aliases
  'lawfirm':      'SXSW — Law Firms in the Age of AI Event Invite',
  'lawfirms':     'SXSW — Law Firms in the Age of AI Event Invite',
  'lawfirm-cold': 'Law Firm AI Case Review — Cold Outreach',
  'sxsw':         'SXSW — Law Firms in the Age of AI Event Invite',
  'email-first':  'Email-First Strategy',
};

const campaign = process.argv[2];
if (!campaign || !campaigns[campaign]) {
  console.log('\n  SOM — Sales Outreach Machine\n');
  console.log('  Campaigns:');
  for (const [name, cfg] of Object.entries(campaigns)) {
    console.log(`    ${name.padEnd(10)} Board ${cfg.BOARD_ID} / ${cfg.STRATEGY} / IG:@${cfg.IG_ACCOUNT}${cfg.TW_ACCOUNT ? ' / TW:@' + cfg.TW_ACCOUNT : ''}`);
  }
  console.log('\n  Usage: node som.js <campaign> [key=value ...]\n');
  console.log('  Modes:');
  console.log('    mode=outreach      DM outreach (default)');
  console.log('    mode=email         Email outreach (for leads with emails)');
  console.log('    mode=engage        Like + comment on posts');
  console.log('    mode=scrape        Scrape leads from a post URL');
  console.log('    mode=followup      Scan DM inbox for replies from board leads');
  console.log('\n  Platforms:');
  console.log('    platform=ig        Instagram (default)');
  console.log('    platform=twitter   Twitter/X');
  console.log('\n  General options:');
  console.log('    limit=N            Number of leads (default: 5)');
  console.log('    board=<id>         Override board/bloq ID');
  console.log('    bloq=<id>          Override board/bloq ID (alias)');
  console.log('    dry=1              Screenshot but don\'t act');
  console.log('    pace=N             Seconds to wait between leads (default: 0)');
  console.log('    enrich=1           Auto-enrich leads without email before outreach');
  console.log('    repeat=Nh|Nm       Sleep N hours/minutes between runs');
  console.log('    loop=N             Max number of runs (default: infinite with repeat)');
  console.log('\n  Outreach options:');
  console.log('    ig=<account>       Override Instagram account');
  console.log('    strategy=<name>    Override strategy (see aliases below)');
  console.log('    step=<auto|1|2|3|4> Strategy step: auto=next uncompleted, N=fixed step');
  console.log('    filter=<all|new|followup>  Lead filter: new (default, first contact only), all=new+follow-ups, followup=continue sequences only');
  console.log('    personalize=1      Fetch IG bio for AI personalization');
  console.log('    warmup=1           Like posts + follow before sending DM');
  console.log('    engage=1           Alias for warmup=1');
  console.log('    warmup_likes=N     Number of posts to like (default: 2)');
  console.log('    warmup_follow=0    Disable follow during warmup');
  console.log('\n  Engage options:');
  console.log('    comment=1          Enable commenting (default: off)');
  console.log('    comment_text=<txt> Override comment text');
  console.log('    like=0             Disable likes');
  console.log('\n  Scrape options:');
  console.log('    target=<url>       Post/tweet URL to scrape commenters from');
  console.log('    scrape_limit=50    Max handles to collect');
  console.log('    source=<label>     Lead source label');
  console.log('\n  Ledger & debug options:');
  console.log('    retry=1            Re-run only retryable failures from today\'s ledger');
  console.log('    debug_lead=<id>    Debug one lead with screenshots + Playwright tracing');
  console.log('\n  Follow-up options:');
  console.log('    since=24h          Check replies from last N hours/days (default: 24h)');
  console.log('    wb=1               Write-back: add notes + tags to leads');
  console.log('\n  Strategy aliases:');
  for (const [alias, full] of Object.entries(strategies)) {
    console.log(`    ${alias.padEnd(16)} → ${full}`);
  }
  console.log('');
  process.exit(campaign ? 1 : 0);
}

const env = { ...campaigns[campaign], SOM_CAMPAIGN_NAME: campaign };

// Campaign-level default mode overrides (some campaigns are email-first)
const campaignDefaultMode = {
  lawfirms: 'email',
  venues: 'venue',
};

// Shorthand aliases → real env var names
const aliases = { IG: 'IG_ACCOUNT', DRY: 'DRY_RUN', TW: 'TW_ACCOUNT', ENRICH: 'AUTO_ENRICH', BOARD: 'BOARD_ID', BLOQ: 'BOARD_ID', BLOQID: 'BOARD_ID', BLOQ_ID: 'BOARD_ID', WB: 'WRITE_BACK', WRITEBACK: 'WRITE_BACK', ENGAGE: 'WARMUP' };

// Parse key=value args → ENV vars
// Pull out repeat/loop/mode/platform before passing to playwright
let repeatMs = 0;
let maxLoops = 0; // 0 = infinite
let paceMs = 0; // pace between leads in ms
let retryMode = false;
let debugLeadId = null;
let mode = process.env.SOM_MODE || campaignDefaultMode[campaign] || 'outreach';
let platform = mode === 'email' ? 'email' : 'ig';

for (const arg of process.argv.slice(3)) {
  const eq = arg.indexOf('=');
  if (eq > 0) {
    const key = arg.slice(0, eq).toUpperCase();
    let val = arg.slice(eq + 1);

    // Handle repeat flag (don't pass to playwright)
    if (key === 'REPEAT') {
      const match = val.match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)$/i);
      if (!match) {
        console.error('  Invalid repeat format. Use e.g. repeat=3h, repeat=3hrs, repeat=90m, repeat=90min');
        process.exit(1);
      }
      const num = parseFloat(match[1]);
      const unit = match[2].toLowerCase();
      repeatMs = unit.startsWith('h') ? num * 3600000 : num * 60000;
      continue;
    }
    if (key === 'LOOP') {
      maxLoops = parseInt(val, 10);
      continue;
    }
    if (key === 'PACE') {
      const seconds = parseFloat(val);
      paceMs = (!isNaN(seconds) && seconds > 0) ? Math.round(seconds * 1000) : 0;
      continue;
    }
    if (key === 'RETRY') {
      retryMode = val === '1' || val === 'true';
      continue;
    }
    if (key === 'DEBUG_LEAD') {
      debugLeadId = val;
      continue;
    }

    // Handle mode + platform (routing flags, not env vars)
    if (key === 'MODE') {
      mode = val.toLowerCase();
      if (!specs[mode]) {
        console.error(`  Unknown mode: ${val}. Available: ${Object.keys(specs).join(', ')}`);
        process.exit(1);
      }
      continue;
    }
    if (key === 'PLATFORM') {
      platform = val.toLowerCase();
      if (!['ig', 'twitter', 'tw', 'x', 'email'].includes(platform)) {
        console.error(`  Unknown platform: ${val}. Available: ig, twitter, email`);
        process.exit(1);
      }
      if (platform === 'tw' || platform === 'x') platform = 'twitter';
      // platform=email auto-sets mode=email
      if (platform === 'email') mode = 'email';
      continue;
    }

    // Resolve strategy aliases
    if (key === 'STRATEGY' && strategies[val.toLowerCase()]) {
      val = strategies[val.toLowerCase()];
    }

    env[aliases[key] || key] = val;
  }
}

// Pass PLATFORM to the spec so it knows which selectors/cookies to use
env.PLATFORM = platform;

// Venue mode: capture first positional arg as CITIES, set default phases
if (mode === 'venue') {
  // First non-key=value arg after campaign name is the city list
  if (!env.CITIES) {
    const cityArg = process.argv.slice(3).find(a => !a.includes('='));
    env.CITIES = cityArg || 'dallas';
  }
  // Venue spec uses ENRICH/DISCOVER/EMAIL (not AUTO_ENRICH from the alias map)
  // Fix alias remap: AUTO_ENRICH → ENRICH for venue mode
  if (env.AUTO_ENRICH) { env.ENRICH = env.AUTO_ENRICH; delete env.AUTO_ENRICH; }
  if (!env.DISCOVER && !env.ENRICH && !env.EMAIL) {
    env.DISCOVER = '1';
    env.ENRICH = '1';
  }
}

// Validate scrape mode has target
if (mode === 'scrape' && !env.TARGET_URL && !env.TARGET) {
  console.error('  Scrape mode requires target=<url>');
  console.error('  Example: node som.js courses mode=scrape target=https://instagram.com/p/ABC123');
  process.exit(1);
}
if (env.TARGET) {
  env.TARGET_URL = env.TARGET;
  delete env.TARGET;
}

// Pass pace to the Playwright spec as env var
if (paceMs > 0) env.PACE_MS = String(paceMs);

// Scale timeout: 90s per lead, minimum 10 min (scrape/venue get extra time)
const limit = parseInt(env.LIMIT || env.SCRAPE_LIMIT || '5', 10);
const baseTimeout = (mode === 'scrape' || mode === 'venue') ? 900000 : 600000;
const perLeadMs = mode === 'venue' ? 120000 : 90000; // venue: 2min/lead (browser scraping)
const timeout = Math.max(baseTimeout, limit * perLeadMs + limit * paceMs);

const spec = specs[mode];
const cmd = `npx playwright test ${spec} --headed --timeout ${timeout}`;

// ── Mode labels ─────────────────────────────────────────────────────
const modeLabels = { outreach: 'DM OUTREACH', email: 'EMAIL OUTREACH', engage: 'ORGANIC ENGAGE', scrape: 'LEAD SCRAPE', followup: 'INBOX FOLLOW-UP', venue: 'VENUE OUTREACH', instagram_inbox_check: 'IG INBOX CHECK', linkedin_inbox_check: 'LINKEDIN INBOX CHECK', instagram_inbox: 'IG INBOX READ', whatsapp_inbox_check: 'WA INBOX CHECK' };
const platformLabels = { ig: 'Instagram', twitter: 'Twitter/X', email: 'Email' };

// ── Helpers ──────────────────────────────────────────────────────────

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function formatTime(date) {
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function countdown(totalMs) {
  const barWidth = 40;
  const startTime = Date.now();
  const resumeAt = new Date(startTime + totalMs);

  console.log('');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log(`  ║  NEXT RUN AT ${formatTime(resumeAt).padEnd(37)}║`);
  console.log('  ╚══════════════════════════════════════════════════╝');
  console.log('');

  while (true) {
    const elapsed = Date.now() - startTime;
    const remaining = totalMs - elapsed;
    if (remaining <= 0) break;

    const pct = elapsed / totalMs;
    const filled = Math.round(pct * barWidth);
    const empty = barWidth - filled;
    const bar = '\u2593'.repeat(filled) + '\u2591'.repeat(empty);

    process.stdout.write(`\r  ${bar}  ${formatDuration(remaining)} remaining  `);
    await sleep(1000);
  }

  process.stdout.write('\r' + ' '.repeat(80) + '\r');
  console.log('  Resuming...\n');
}

function runBatch(runNum, totalRuns) {
  const label = totalRuns > 0 ? `${runNum}/${totalRuns}` : `${runNum}`;
  console.log(`\n  ── RUN ${label} ─────────────────────────────────────────\n`);

  try {
    execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } });
    return true;
  } catch (e) {
    console.error(`\n  Run ${label} exited with code ${e.status || 1}\n`);
    return false;
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  // Print banner
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log(`  ║  SOM — ${(modeLabels[mode] || mode.toUpperCase()).padEnd(42)}║`);
  console.log(`  ║  Campaign: ${campaign.padEnd(39)}║`);
  console.log(`  ║  Platform: ${(platformLabels[platform] || platform).padEnd(39)}║`);
  if (paceMs > 0) {
    const paceStr = `${(paceMs / 1000).toFixed(1)}s between leads`;
    console.log(`  ║  Pacing: ${paceStr.padEnd(41)}║`);
  }
  if (mode === 'scrape' && env.TARGET_URL) {
    const truncUrl = env.TARGET_URL.length > 37 ? env.TARGET_URL.slice(0, 34) + '...' : env.TARGET_URL;
    console.log(`  ║  Target: ${truncUrl.padEnd(41)}║`);
  }
  console.log('  ╚══════════════════════════════════════════════════╝');

  // ── DEBUG MODE — single lead with tracing ──
  if (debugLeadId) {
    env.LIMIT = '1';
    env.SOM_RETRY_LEAD_IDS = debugLeadId;
    env.SOM_DEBUG = '1';
    console.log(`\n  DEBUG MODE: lead ${debugLeadId} with screenshots + tracing\n`);
    const debugCmd = `npx playwright test ${spec} --headed --timeout ${timeout} --trace on`;
    try {
      execSync(debugCmd, { stdio: 'inherit', env: { ...process.env, ...env } });
    } catch (e) {
      process.exit(e.status || 1);
    }
    return;
  }

  // ── RETRY MODE — re-run only retryable failures from today's ledger ──
  if (retryMode) {
    const fs = require('fs');
    const os = require('os');
    const ledgerDate = new Date().toISOString().slice(0, 10);
    const ledgerFile = require('path').join(os.homedir(), '.iris', 'som-ledger', `${campaign}-${ledgerDate}.jsonl`);

    if (!fs.existsSync(ledgerFile)) {
      console.log(`\n  No ledger file for today: ${ledgerFile}\n`);
      process.exit(0);
    }

    const lines = fs.readFileSync(ledgerFile, 'utf-8').trim().split('\n').filter(Boolean);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    // Find retryable leads that don't have a subsequent dm_sent
    const sentIds = new Set(entries.filter(e => e.result === 'dm_sent').map(e => e.lead_id));
    const retryable = entries.filter(e => e.retryable && e.lead_id && !sentIds.has(e.lead_id));
    const uniqueIds = [...new Set(retryable.map(e => e.lead_id))];

    if (uniqueIds.length === 0) {
      console.log('\n  No retryable failures in today\'s ledger.\n');
      process.exit(0);
    }

    console.log(`\n  RETRY MODE: ${uniqueIds.length} retryable leads from today's ledger`);
    for (const id of uniqueIds.slice(0, 20)) {
      const entry = retryable.find(e => e.lead_id === id);
      console.log(`    #${id} ${entry.lead_name} — ${entry.result}`);
    }
    if (uniqueIds.length > 20) console.log(`    ... and ${uniqueIds.length - 20} more`);
    console.log('');

    env.SOM_RETRY_LEAD_IDS = uniqueIds.join(',');
    env.LIMIT = String(uniqueIds.length);
  }

  // ── PRE-FLIGHT CHECK — skip Chromium launch if no eligible leads ──
  // Only applies to outreach + followup modes (scrape/engage don't need leads)
  // Skip in retry mode — we already have specific lead IDs from the ledger
  if (!retryMode && (mode === 'outreach' || mode === 'followup' || mode === 'email')) {
    const { preflightCheck } = require('./som-config');
    const boardId = env.BOARD_ID;
    const strategy = env.STRATEGY;
    const pfMode = mode === 'followup' ? 'followup' : 'new';
    console.log(`\n  Pre-flight: checking board ${boardId} for eligible leads...`);
    const pf = await preflightCheck(boardId, strategy, { mode: pfMode });
    console.log(`  Pre-flight: ${pf.reason}`);
    if (pf.skip) {
      console.log(`\n  No eligible leads — skipping Chromium launch.`);
      console.log(`  Board ${boardId}: ${pf.reason}\n`);
      process.exit(0);
    }
    console.log(`  Pre-flight: ${pf.eligible} eligible leads — launching browser.\n`);
  }

  // Single run (no repeat)
  if (!repeatMs) {
    try {
      execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } });
    } catch (e) {
      process.exit(e.status || 1);
    }
    return;
  }

  // Repeat mode
  const totalRuns = maxLoops || 0;
  let run = 0;

  console.log('');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log('  ║        SOM — REPEAT MODE ACTIVE                 ║');
  console.log(`  ║  Mode: ${(modeLabels[mode] || mode).padEnd(43)}║`);
  console.log(`  ║  Platform: ${(platformLabels[platform] || platform).padEnd(39)}║`);
  console.log(`  ║  Interval: ${formatDuration(repeatMs).padEnd(39)}║`);
  console.log(`  ║  Max runs: ${(totalRuns || 'unlimited').toString().padEnd(39)}║`);
  console.log('  ║  Press Ctrl+C to stop                           ║');
  console.log('  ╚══════════════════════════════════════════════════╝');

  while (true) {
    run++;
    if (totalRuns > 0 && run > totalRuns) break;

    // Re-check leads before each repeat iteration (skip browser if exhausted)
    if (run > 1 && (mode === 'outreach' || mode === 'followup' || mode === 'email')) {
      const { preflightCheck } = require('./som-config');
      const pfMode = mode === 'followup' ? 'followup' : 'new';
      const pf = await preflightCheck(env.BOARD_ID, env.STRATEGY, { mode: pfMode });
      if (pf.skip) {
        console.log(`\n  Pre-flight (run ${run}): ${pf.reason} — skipping this iteration.\n`);
        if (totalRuns > 0 && run >= totalRuns) break;
        await countdown(repeatMs);
        continue;
      }
    }

    runBatch(run, totalRuns);

    // Don't sleep after the last run
    if (totalRuns > 0 && run >= totalRuns) break;

    await countdown(repeatMs);
  }

  console.log(`\n  All ${run} runs complete.\n`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
