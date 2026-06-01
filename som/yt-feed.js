#!/usr/bin/env node
/**
 * YT Feed — YouTube Home Feed Scraper → n8n Marketing Pipeline
 *
 * Usage:
 *   npm run yt:feed                         # Scrape 50 videos from home feed
 *   npm run yt:feed -- source=watchlater    # Scrape Watch Later playlist
 *   npm run yt:feed -- source=PLxxxxxxx     # Scrape any playlist by ID
 *   npm run yt:feed -- limit=30             # Scrape 30 videos
 *   npm run yt:feed -- dry=1                # Scrape only, print JSON (no n8n)
 *   npm run yt:feed -- output=file          # Also save to test-results/yt-feed.json
 *
 * Source options:
 *   feed          Home feed (default)
 *   watchlater    Watch Later playlist
 *   wl            Alias for watchlater
 *   PLxxxxxxx     Any playlist ID
 *   https://...   Full YouTube URL
 *
 * First-time setup:
 *   npm run yt:save-session                 # Save Google/YouTube auth cookies
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Resolve spec relative to this file (works from bridge OR monorepo)
const localSpec = path.join(__dirname, 'youtube-feed-scraper.spec.ts');
const monorepoSpec = 'tests/e2e/youtube-feed-scraper.spec.ts';
const spec = fs.existsSync(localSpec) ? localSpec : monorepoSpec;

// ── Load n8n credentials from fl-docker-dev/.env or ~/.iris/bridge/.env
const dotenvPaths = [
  path.join(__dirname, '..', '.env'),                    // bridge .env
  path.join(__dirname, '..', '..', '.env'),                      // monorepo fl-docker-dev/.env
  path.join(require('os').homedir(), '.iris', 'bridge', '.env'), // installed .env
];
const dotenvPath = dotenvPaths.find(p => fs.existsSync(p));
if (fs.existsSync(dotenvPath)) {
  const lines = fs.readFileSync(dotenvPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const key = trimmed.slice(0, eq);
      const val = trimmed.slice(eq + 1);
      // Only set if not already in env (CLI overrides .env)
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

// ── Parse CLI args ───────────────────────────────────────────────────
const env = {};
const aliases = { DRY: 'DRY_RUN', EMAIL: 'N8N_EMAIL', PASS: 'N8N_PASSWORD' };

for (const arg of process.argv.slice(2)) {
  const eq = arg.indexOf('=');
  if (eq > 0) {
    const key = arg.slice(0, eq).toUpperCase();
    const val = arg.slice(eq + 1);
    env[aliases[key] || key] = val;
  }
}

// Scale timeout: base 3 min + 3s per video + 1 min for n8n interaction
const limit = parseInt(env.LIMIT || '50', 10);
const timeout = Math.max(180000, limit * 3000 + 120000);
const isDry = env.DRY_RUN === '1';
const source = env.SOURCE || 'feed';
const sourceLabel = { feed: 'Home Feed', watchlater: 'Watch Later', wl: 'Watch Later' }[source.toLowerCase()] || source;

// ── Banner ───────────────────────────────────────────────────────────
console.log('');
console.log('  ╔══════════════════════════════════════════════════╗');
console.log('  ║  YT FEED — YouTube → n8n Marketing Pipeline      ║');
console.log(`  ║  Source: ${sourceLabel.padEnd(41)}║`);
console.log(`  ║  Videos: ${String(limit).padEnd(41)}║`);
console.log(`  ║  Mode:   ${(isDry ? 'DRY RUN' : 'LIVE → n8n chat').padEnd(41)}║`);
console.log('  ╚══════════════════════════════════════════════════╝');
console.log('');

// ── Run Playwright ───────────────────────────────────────────────────
const cmd = `npx playwright test ${spec} --headed --timeout ${timeout}`;

try {
  execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } });
} catch (e) {
  // Don't hard-exit with error code — the scrape likely succeeded even if
  // Playwright reports non-zero (e.g. n8n chat interaction issues).
  // The daemon chain logic checks task completion, not exit code.
  console.error(`\n  Playwright exited with code ${e.status || 1} (scrape may have succeeded)\n`);
  process.exit(e.status || 1);
}
