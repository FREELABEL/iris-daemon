/**
 * YouTube Home Feed Scraper → n8n Marketing Pipeline
 *
 * Opens YouTube (with saved auth cookies), scrolls the home feed,
 * scrapes video metadata, then opens n8n and pastes it into the
 * marketing workflow chat to trigger the pipeline.
 *
 * Usage:
 *   npm run yt:feed                    # Scrape 50 videos, paste into n8n
 *   npm run yt:feed -- limit=30        # Scrape 30 videos
 *   npm run yt:feed -- dry=1           # Scrape only, print JSON
 *   npm run yt:feed -- output=file     # Also save JSON to test-results/yt-feed.json
 *
 * Requires: npm run yt:save-session (one-time Google auth)
 *
 * Environment:
 *   LIMIT           Max videos to scrape (default: 50)
 *   DRY_RUN         If "1", skip n8n paste
 *   N8N_EMAIL       n8n login email
 *   N8N_PASSWORD    n8n login password
 *   N8N_URL         n8n base URL (default: http://localhost:5678)
 *   OUTPUT          "file" to save JSON to disk
 */

import { test } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

const YT_AUTH_FILE = process.env.BROWSER_SESSION_FILE || path.join(__dirname, 'youtube-auth.json');
const LIMIT = parseInt(process.env.LIMIT || '50', 10);
const DRY_RUN = process.env.DRY_RUN === '1';
const OUTPUT = process.env.OUTPUT || '';
const SOURCE = (process.env.SOURCE || 'feed').trim();
const SORT = (process.env.SORT || '').trim(); // e.g. 'newest', 'oldest', 'popular', 'published_newest', 'published_oldest', 'manual'
// Load n8n credentials from fl-docker-dev/.env if not in env
const dotenvPath = require('path').join(__dirname, '../../fl-docker-dev/.env');
try { require('fs').readFileSync(dotenvPath, 'utf-8').split('\n').forEach(line => {
  const [k, ...v] = line.split('='); if (k && !process.env[k.trim()]) process.env[k.trim()] = v.join('=').trim();
}); } catch {}
// Docker internal URL won't work from host — fallback to localhost
const rawN8nUrl = process.env.N8N_URL || 'http://localhost:5678';
const N8N_URL = rawN8nUrl.includes('.orb.local') || rawN8nUrl.includes('fl-docker-dev') ? 'http://localhost:5678' : rawN8nUrl;
const N8N_EMAIL = process.env.N8N_EMAIL || '';
const N8N_PASSWORD = process.env.N8N_PASSWORD || '';
const WORKFLOW_NAME = 'YouTube Upload Analysis FIXED';
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || 'IeiQIvPwcMMEYjVr';

// Resolve the YouTube URL based on SOURCE parameter
function resolveYouTubeUrl(): { url: string; label: string; isPlaylist: boolean } {
  const s = SOURCE.toLowerCase();
  if (s === 'feed' || s === '') {
    return { url: 'https://www.youtube.com', label: 'Home Feed', isPlaylist: false };
  }
  if (s === 'watchlater' || s === 'wl' || s === 'watch-later') {
    return { url: 'https://www.youtube.com/playlist?list=WL', label: 'Watch Later', isPlaylist: true };
  }
  if (s.startsWith('http')) {
    // Full playlist or channel URL
    const isPlaylist = s.includes('/playlist') || s.includes('list=');
    return { url: s, label: isPlaylist ? 'Playlist' : 'Custom URL', isPlaylist };
  }
  // Assume it's a playlist ID (e.g., "PLxxxxxx")
  return { url: `https://www.youtube.com/playlist?list=${SOURCE}`, label: `Playlist ${SOURCE}`, isPlaylist: true };
}

test('Scrape YouTube home feed and send to n8n', async ({ browser }) => {
  // n8n workflow can take 10+ minutes to process all videos
  test.setTimeout(15 * 60 * 1000); // 15 minutes (scrape + n8n processing)
  // ── 1. Check for saved session ──────────────────────────────────────
  if (!fs.existsSync(YT_AUTH_FILE)) {
    console.error('\n  [LOGIN_EXPIRED] No YouTube session found!');
    console.error('  Run first: npm run yt:save-session\n');
    test.skip();
    return;
  }

  const storageState = JSON.parse(fs.readFileSync(YT_AUTH_FILE, 'utf-8'));
  const ytSource = resolveYouTubeUrl();

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  YT FEED SCRAPER → n8n');
  console.log(`  Source: ${ytSource.label} (${ytSource.url})`);
  console.log(`  Limit: ${LIMIT} videos`);
  console.log(`  Mode:  ${DRY_RUN ? 'DRY RUN (scrape only)' : 'LIVE → n8n chat'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // ── 2. Launch browser with saved YouTube cookies ────────────────────
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  if (storageState.cookies) {
    await context.addCookies(storageState.cookies);
  }

  const page = await context.newPage();

  // ── 3. Navigate to YouTube source ───────────────────────────────────
  await page.goto(ytSource.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  // Handle cookie consent
  const consentBtn = page.locator('button:has-text("Accept all"), button:has-text("Accept"), button:has-text("I agree")').first();
  if (await consentBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await consentBtn.click();
    await page.waitForTimeout(1000);
  }

  // Verify we're logged in
  const isLoggedIn = await page.locator('button#avatar-btn, img.yt-spec-avatar-shape__avatar').first().isVisible({ timeout: 10000 }).catch(() => false);
  if (!isLoggedIn) {
    console.error('  [LOGIN_EXPIRED] YouTube session expired!');
    console.error('  Run: npm run yt:save-session\n');
    await page.screenshot({ path: 'test-results/screenshots/yt-not-logged-in.png' });
    await context.close();
    test.skip();
    return;
  }

  console.log(`  Logged in to YouTube. Scraping ${ytSource.label}...\n`);

  // ── DEBUG: which account are we ACTUALLY logged in as? ──────────────
  // The "wrong account" failure (a stale/other session got pulled from the cloud)
  // is invisible until we surface it. Log the active account + session size before
  // scraping so we can tell at a glance whether the right account is in play.
  try {
    const cookieCount = (storageState.cookies || []).length;
    console.log(`  [DEBUG] Session: ${cookieCount} cookies | file: ${YT_AUTH_FILE}`);
    await page.locator('button#avatar-btn, img.yt-spec-avatar-shape__avatar').first().click({ timeout: 5000 });
    await page.waitForTimeout(1500);
    const acct = await page.evaluate(() => {
      const t = (sel: string) => (document.querySelector(sel)?.textContent || '').trim();
      const name = t('#account-name') || t('ytd-active-account-header-renderer #channel-title') || t('#channel-title');
      const handle = t('#channel-handle') || t('#email') || t('ytd-active-account-header-renderer #email');
      return { name, handle };
    });
    console.log(`  [DEBUG] Logged-in account: ${acct.name || '(unknown)'}${acct.handle ? ' · ' + acct.handle : ''}`);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
  } catch (e: any) {
    console.log(`  [DEBUG] Could not read account: ${e?.message}`);
  }

  // ── 3b. Apply sort order for playlists ──────────────────────────────
  if (ytSource.isPlaylist && SORT) {
    const sortMap: Record<string, string> = {
      newest: 'Date added (newest)',
      oldest: 'Date added (oldest)',
      popular: 'Most popular',
      published_newest: 'Date published (newest)',
      published_oldest: 'Date published (oldest)',
      manual: 'Manual',
    };
    const sortLabel = sortMap[SORT.toLowerCase()] || SORT;
    console.log(`  Setting sort order: ${sortLabel}\n`);

    // Click the Sort button to open dropdown
    const sortBtn = page.locator('button:has-text("Sort"), yt-sort-filter-sub-menu-renderer button, [aria-label="Sort"]').first();
    if (await sortBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await sortBtn.click();
      await page.waitForTimeout(1000);

      // Click the desired sort option
      const sortOption = page.locator(`tp-yt-paper-listbox a:has-text("${sortLabel}"), yt-dropdown-menu a:has-text("${sortLabel}"), [role="option"]:has-text("${sortLabel}"), [role="menuitem"]:has-text("${sortLabel}")`).first();
      if (await sortOption.isVisible({ timeout: 3000 }).catch(() => false)) {
        await sortOption.click();
        await page.waitForTimeout(2000); // Wait for playlist to re-sort
        console.log(`  Sorted by: ${sortLabel}\n`);
      } else {
        console.log(`  Sort option "${sortLabel}" not found, using default order\n`);
      }
    } else {
      console.log('  Sort button not found on this playlist\n');
    }
  }

  // ── 4. Scroll and scrape ────────────────────────────────────────────
  const videos = await page.evaluate(async ({ maxVideos, isPlaylist }: { maxVideos: number; isPlaylist: boolean }) => {
    const pause = (ms = 800) => new Promise(r => setTimeout(r, ms));

    // Playlist pages use ytd-playlist-video-renderer; feed uses different selectors
    const videoSelector = isPlaylist
      ? 'ytd-playlist-video-renderer, ytd-playlist-video-list-renderer ytd-playlist-panel-video-renderer'
      : 'yt-lockup-view-model, ytd-rich-item-renderer, ytd-video-renderer';

    const countVideosInDOM = () => document.querySelectorAll(videoSelector).length;

    // YouTube's home feed is VIRTUALIZED — cards that scroll off-screen are
    // removed from the DOM and recycled. Harvesting only once at the end would
    // capture just the small window of currently-rendered cards (~5-15), not the
    // 50 we scrolled past. So we harvest incrementally on every scroll pass into
    // a Map keyed by video id, capturing cards before they're recycled away.
    const collected = new Map<string, any>();
    const harvest = () => {
      const results: any[] = [];
      collectInto(results);
      for (const v of results) {
        if (v && v.id && !collected.has(v.id)) collected.set(v.id, v);
      }
    };

    let lastHeight = 0, sameHeight = 0;
    // Keep scrolling until we've collected enough unique videos, or the page
    // truly stops growing for many cycles. Threshold raised from 8 → 15 because
    // YouTube's lazy-load is bursty and momentary stalls are common.
    while (collected.size < maxVideos && sameHeight < 15) {
      harvest(); // capture what's visible NOW, before it scrolls out and gets recycled
      window.scrollBy(0, 1500);
      await pause(1200);
      // Trigger lazy load by scrolling back up slightly then down again
      if (sameHeight > 2) {
        window.scrollBy(0, -400);
        await pause(300);
        window.scrollBy(0, 2000);
        await pause(1500);
      }
      const newHeight = document.documentElement.scrollHeight;
      if (newHeight === lastHeight) {
        sameHeight++;
      } else {
        sameHeight = 0;
        lastHeight = newHeight;
      }
    }
    harvest(); // final pass to grab anything loaded after the last scroll

    function collectInto(results: any[]) {
    if (isPlaylist) {
      // ── Playlist scraping (Watch Later, custom playlists) ──
      const items = document.querySelectorAll('ytd-playlist-video-renderer');
      items.forEach((item, index) => {
        const linkEl = item.querySelector('a#video-title, a[href*="/watch"]') as HTMLAnchorElement;
        if (!linkEl) return;

        const href = linkEl.getAttribute('href') || '';
        const url = href.startsWith('http') ? href : 'https://www.youtube.com' + href;
        const idMatch = url.match(/v=([^&]+)/);
        const videoId = idMatch ? idMatch[1] : null;

        const title = linkEl.textContent?.trim() || null;

        const durationEl = item.querySelector(
          '.ytBadgeShapeText, .yt-badge-shape__text, .badge-shape-wiz__text, span.ytd-thumbnail-overlay-time-status-renderer'
        );
        const duration = durationEl ? durationEl.textContent!.trim() : null;

        const channelEl = item.querySelector(
          '.ytd-channel-name a, #channel-name .yt-formatted-string a, #text.ytd-channel-name'
        ) as HTMLElement;
        const channel = channelEl ? channelEl.textContent!.trim() : null;

        // Playlist items show index number
        const indexEl = item.querySelector('#index');
        const position = indexEl ? parseInt(indexEl.textContent!.trim(), 10) : index + 1;

        results.push({ id: videoId, url, title, channel, views: null, uploaded: null, duration, position });
      });
    } else {
      // ── Feed scraping (home page) ──
      // YouTube uses multiple component types — try all known variants
      // Prefer yt-lockup-view-model (new YouTube) over ytd-rich-item-renderer (old)
      // to ensure metadata selectors work correctly
      let cards = document.querySelectorAll('yt-lockup-view-model');
      if (cards.length === 0) {
        cards = document.querySelectorAll('ytd-rich-item-renderer, ytd-rich-grid-media, ytd-video-renderer, ytd-grid-video-renderer');
      }

      cards.forEach(item => {
        // Find the video link — try multiple selectors
        const linkEl = item.querySelector(
          'a.ytLockupViewModelTitle, a.ytLockupViewModelContentImage, a#video-title-link, a#video-title, h3 a[href*="/watch"], a[href*="/watch"]'
        ) as HTMLAnchorElement;
        if (!linkEl) return;

        const href = linkEl.getAttribute('href') || '';
        if (!href.includes('/watch')) return;
        const idMatch = href.match(/v=([^&]+)/);
        const videoId = idMatch ? idMatch[1] : null;
        // Clean URL — strip radio/playlist/tracking params, keep only video ID
        const url = videoId ? `https://www.youtube.com/watch?v=${videoId}` : 'https://www.youtube.com' + href;

        // Title: try element text, then aria-label on the link
        let title: string | null = null;
        const titleEl = item.querySelector(
          '#video-title, .ytLockupMetadataViewModelTitle, h3 a[href*="/watch"]'
        );
        if (titleEl) {
          title = titleEl.textContent!.trim();
        }
        if (!title && linkEl.getAttribute('aria-label')) {
          // aria-label often has "Title by Channel X views Y ago Duration"
          title = linkEl.getAttribute('aria-label')!.split(' by ')[0]?.trim() || null;
        }
        if (!title) {
          title = linkEl.textContent?.trim() || null;
        }

        const durationEl = item.querySelector(
          '.ytBadgeShapeText, .yt-badge-shape__text, .badge-shape-wiz__text, span.ytd-thumbnail-overlay-time-status-renderer'
        );
        const duration = durationEl ? durationEl.textContent!.trim() : null;

        let channel: string | null = null;
        let views: string | null = null;
        let uploaded: string | null = null;

        // Channel: the channel link always uses /@ChannelName href
        const channelEl = item.querySelector(
          'a[href^="/@"], ytd-channel-name a, ytd-channel-name #text, .ytd-channel-name a'
        ) as HTMLElement;
        if (channelEl) {
          channel = channelEl.textContent!.trim();
        }

        // Metadata: all spans in ytContentMetadataViewModelMetadataText contain
        // channel, views, and upload time (YouTube flattened to single row)
        const metaSpans = item.querySelectorAll('.ytContentMetadataViewModelMetadataText');
        metaSpans.forEach(span => {
          const text = span.textContent!.trim();
          if (!text) return;
          // Views: "193K views", "2.5K watching", or just "27K" / "376K" / "1.2M"
          if (text.match(/[\d.]+[KMB]?\s*(views|watching)/i) || text.match(/^[\d.]+[KMB]$/)) {
            views = text;
          // Upload time: "2 months ago", "11d ago", "1mo ago", "Streamed 3d ago"
          } else if (text.match(/\d+\s*(second|minute|hour|day|week|month|year|[dhwmy])/i) || text.includes('ago') || text.includes('Streamed')) {
            uploaded = text;
          // Channel name: not views, not time, has letters
          } else if (!channel && text.length > 1 && !text.match(/^[\d:]+$/)) {
            channel = text.replace(/\s+/g, ' ').trim();
          }
        });
        // Fallback: old YouTube selectors
        if (!views && !uploaded) {
          const oldMetaSpans = item.querySelectorAll('.inline-metadata-item, ytd-video-meta-block span');
          oldMetaSpans.forEach(span => {
            const text = span.textContent!.trim();
            if (!text) return;
            if (text.match(/[\d.]+[KMB]?\s*(views|watching)/i)) views = text;
            else if (text.match(/\d+\s*(second|minute|hour|day|week|month|year)/i) || text.includes('ago')) uploaded = text;
            else if (!channel && text.length > 2 && !text.includes(':')) channel = text;
          });
        }

        results.push({ id: videoId, url, title, channel, views, uploaded, duration });
      });
    }
    } // end collectInto

    return Array.from(collected.values()).slice(0, maxVideos);
  }, { maxVideos: LIMIT, isPlaylist: ytSource.isPlaylist });

  // Filter out entries without a title and live streams (can't clip a live stream)
  const cleanVideos = videos.filter(v => v.title && v.duration !== 'LIVE');
  const liveCount = videos.filter(v => v.duration === 'LIVE').length;
  const adCount = videos.length - cleanVideos.length - liveCount;

  console.log(`  [DEBUG] DOM cards seen: ${videos.length} | clean: ${cleanVideos.length} | ads: ${adCount} | live: ${liveCount}`);
  console.log(`  Scraped ${cleanVideos.length} videos (${adCount > 0 ? adCount + ' ads, ' : ''}${liveCount > 0 ? liveCount + ' live streams ' : ''}filtered)\n`);

  // Loud signal when a playlist (e.g. Watch Later) comes back empty — usually means
  // the WRONG account's session is in play (its Watch Later is empty/different), or
  // the playlist genuinely has nothing. Either way, surface it instead of silently
  // delivering 0 videos to n8n.
  if (cleanVideos.length === 0) {
    console.log(`  [DEBUG] ⚠️  0 videos scraped from ${ytSource.label}. If this is Watch Later, the logged-in account (above) likely isn't the one with the videos — re-capture the session on the correct account.`);
  }

  // Print summary table
  console.log('  ┌─────┬────────────────────────────────────────────────────┬──────────────────────────┐');
  console.log('  │  #  │ Title                                              │ Channel                  │');
  console.log('  ├─────┼────────────────────────────────────────────────────┼──────────────────────────┤');
  cleanVideos.slice(0, 15).forEach((v, i) => {
    const title = (v.title || '').slice(0, 50).padEnd(50);
    const ch = (v.channel || '').slice(0, 24).padEnd(24);
    console.log(`  │ ${String(i + 1).padStart(3)} │ ${title} │ ${ch} │`);
  });
  if (cleanVideos.length > 15) {
    console.log(`  │ ... │ ... and ${cleanVideos.length - 15} more`.padEnd(84) + '│');
  }
  console.log('  └─────┴────────────────────────────────────────────────────┴──────────────────────────┘\n');

  // ── 5. Save to file (optional) ──────────────────────────────────────
  if (OUTPUT === 'file') {
    const outDir = path.join(process.cwd(), 'test-results');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'yt-feed.json');
    fs.writeFileSync(outPath, JSON.stringify(cleanVideos, null, 2));
    console.log(`  Saved to: ${outPath}\n`);
  }

  // ── 6. Paste into n8n chat UI ───────────────────────────────────────
  if (DRY_RUN) {
    console.log('  DRY RUN — skipping n8n\n');
    console.log(JSON.stringify(cleanVideos, null, 2));
    await context.close();
    return;
  }

  if (!N8N_EMAIL || !N8N_PASSWORD) {
    console.error('  Missing N8N_EMAIL or N8N_PASSWORD env vars.');
    console.error('  Set them in fl-docker-dev/.env or pass via CLI.\n');
    console.log(JSON.stringify(cleanVideos, null, 2));
    await context.close();
    return;
  }

  console.log('  Opening n8n...\n');

  // ── 6a. Login to n8n if needed ──────────────────────────────────────
  // Go STRAIGHT to /signin (deterministic). The old approach loaded the base URL
  // and waited for a client-side redirect to /signin — on a cold-loading hosted
  // n8n that took longer than the detection window, so login was SKIPPED and the
  // run proceeded UNAUTHENTICATED → "no chat input" red herring (#133858). n8n's
  // real field name is `emailOrLdapLoginId` (verified against the live form), NOT
  // `email` — the old selector never matched. If already authenticated, n8n
  // bounces /signin → home and the form never appears, so login is skipped.
  // n8n's signin is a websocket-heavy SPA that never reliably fires `domcontentloaded`
  // or `networkidle` — a 30s domcontentloaded wait timed out even though the server
  // responds in <1s (the page just keeps streaming). `commit` resolves the instant the
  // server response is received; the form-visibility check below is what actually gates
  // login readiness. Longer timeout is belt-and-suspenders for a Railway cold start.
  // Robust login: n8n's signin SPA renders the form slowly on a cold start.
  // The OLD check "email not visible within 20s → assume authenticated" produced a
  // FALSE POSITIVE — the form simply hadn't painted yet, so login was skipped and the
  // run proceeded UNAUTHENTICATED, then the workflow page bounced straight back to the
  // sign-in wall ("no chat input" red herring). This helper POLLS for the form, treats
  // a real redirect-away-from-/signin as the only "already authed" signal, broadens the
  // email selector across n8n versions, and is re-callable if we get bounced later.
  const emailSel = 'input[name="emailOrLdapLoginId"], input[type="email"], input[name="email"]';
  const pwdSel = 'input[name="password"], input[type="password"]';
  const ensureN8nLogin = async (reason: string): Promise<void> => {
    const emailInput = page.locator(emailSel).first();
    const passwordInput = page.locator(pwdSel).first();

    // Poll up to 40s: either the login form appears, or we're clearly inside the app.
    let formVisible = false;
    for (let i = 0; i < 40; i++) {
      formVisible = await emailInput.isVisible().catch(() => false);
      if (formVisible) break;
      // Redirected away from /signin with no form → already authenticated.
      if (!/\/signin|\/login/.test(page.url())) {
        const inApp = await page.locator('.vue-flow__node, [data-test-id="main-sidebar"], #sidebar, [data-test-id="canvas"]')
          .first().isVisible().catch(() => false);
        if (inApp) { console.log(`  Already authenticated to n8n (${reason}).\n`); return; }
      }
      await page.waitForTimeout(1000);
    }
    if (!formVisible) { console.log(`  No n8n login form detected (${reason}); assuming authenticated.\n`); return; }

    console.log(`  Logging into n8n (${reason})...`);
    await emailInput.fill(N8N_EMAIL);
    await passwordInput.fill(N8N_PASSWORD);
    await page.waitForTimeout(400);
    await page.locator('button:has-text("Sign in"), button[type="submit"]').first().click();
    // Auth completes when we leave /signin — wait on that, not a fixed sleep.
    await page.waitForURL((u) => !/\/signin/.test(u.toString()), { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const stillSignedOut = /\/signin/.test(page.url())
      || await page.locator(emailSel).first().isVisible({ timeout: 2000 }).catch(() => false);
    if (stillSignedOut) {
      throw new Error('n8n login failed — still on the sign-in page. Check N8N_EMAIL / N8N_PASSWORD / N8N_URL.');
    }
    console.log('  Logged in to n8n.\n');
  };

  await page.goto(`${N8N_URL}/signin`, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await ensureN8nLogin('initial');

  // ── 6b. Open the workflow directly by ID ────────────────────────────
  console.log(`  Opening workflow "${WORKFLOW_NAME}" (${WORKFLOW_ID})...`);

  // The n8n editor is a heavy SPA with persistent websockets, so it NEVER reaches
  // `networkidle` — using that as the wait condition timed out at 15s (#133858).
  // Wait for domcontentloaded (generous timeout), then for the canvas to render.
  await page.goto(`${N8N_URL}/workflow/${WORKFLOW_ID}`, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // SAFETY NET: if n8n bounced us back to the auth wall (session not actually valid),
  // log in for real and re-open the workflow. This is what was silently failing before.
  const bouncedToLogin = /\/signin|\/login/.test(page.url())
    || await page.locator(pwdSel).first().isVisible({ timeout: 3000 }).catch(() => false);
  if (bouncedToLogin) {
    console.log('  n8n bounced to sign-in — authenticating, then reopening workflow...');
    await ensureN8nLogin('post-workflow bounce');
    await page.goto(`${N8N_URL}/workflow/${WORKFLOW_ID}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }

  await page.locator('.vue-flow__node, [data-test-id="canvas-node"], #node-view, .node-view')
    .first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  console.log('  Workflow opened.\n');

  // ── 6c. Open the chat panel ─────────────────────────────────────────
  console.log('  Opening chat panel...');

  // n8n has a "Chat" button in the workflow editor toolbar for chatTrigger workflows
  // The canvas overlay intercepts pointer events, so we use force:true or JS click

  // Strategy 1: Look for the dedicated chat button in the toolbar (outside canvas)
  let chatOpened = false;
  const toolbarChatBtn = page.locator('[data-test-id="workflow-chat-button"]').first();
  if (await toolbarChatBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await toolbarChatBtn.click({ force: true });
    chatOpened = true;
  }

  // Strategy 2: Click the chatTrigger node's execute button via JS (bypasses canvas overlay)
  if (!chatOpened) {
    console.log('  Clicking chat trigger via JS...');
    chatOpened = await page.evaluate(() => {
      const allBtns = Array.from(document.querySelectorAll('button'));
      const chatBtn = allBtns.find(b => b.textContent?.includes('Chat') && !b.closest('.vue-flow__node'));
      if (chatBtn) { chatBtn.click(); return true; }
      return false;
    });
  }

  // Strategy 3: Try the "Test workflow" button which opens the chat for chatTrigger workflows
  if (!chatOpened) {
    console.log('  Trying test workflow button...');
    const testBtn = page.locator('[data-test-id="workflow-run-button"], button:has-text("Test workflow")').first();
    if (await testBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await testBtn.click({ force: true });
      chatOpened = true;
    }
  }

  await page.waitForTimeout(2000);

  // ── 6d. Paste the JSON into the chat ────────────────────────────────
  console.log('  Pasting video data into chat...');

  const jsonPayload = JSON.stringify(cleanVideos, null, 2);

  // Find the chat input (textarea or contenteditable)
  const chatInput = page.locator(
    '[data-test-id="chat-input"] textarea, [data-test-id="chat-input"] [contenteditable], .chat-input textarea, .chat-inputs-container textarea, [placeholder*="Type your"], [placeholder*="message"]'
  ).first();

  const inputVisible = await chatInput.isVisible({ timeout: 5000 }).catch(() => false);
  if (inputVisible) {
    await chatInput.fill(jsonPayload);
    await page.waitForTimeout(500);

    // Click send
    const sendBtn = page.locator(
      '[data-test-id="chat-send-button"], button[aria-label="Send"], .chat-input button, button:has(svg):near(textarea)'
    ).first();

    if (await sendBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await sendBtn.click();
      console.log('  Sent! Marketing pipeline triggered.\n');
    } else {
      // Fallback: press Enter
      await chatInput.press('Enter');
      console.log('  Sent via Enter key! Marketing pipeline triggered.\n');
    }

    // Wait to see the response start
    await page.waitForTimeout(5000);
    await page.screenshot({ path: 'test-results/screenshots/n8n-chat-sent.png' });
    console.log('  Screenshot saved: test-results/screenshots/n8n-chat-sent.png\n');
  } else {
    console.error('  Could not find chat input in n8n.');
    console.error('  The workflow may need the chat panel opened manually.\n');
    await page.screenshot({ path: 'test-results/screenshots/n8n-no-chat-input.png' });

    // Copy to clipboard as fallback
    await page.evaluate((json) => {
      const textarea = document.createElement('textarea');
      textarea.value = json;
      textarea.style.position = 'fixed';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }, jsonPayload);

    console.log('  JSON copied to clipboard as fallback. Paste manually into n8n chat.\n');
  }

  // Keep browser open so the n8n workflow can finish processing.
  // n8n chat-triggered workflows run inside the browser session —
  // closing the browser kills the execution.
  console.log('  Done! Browser will stay open for up to 12 minutes while n8n processes.\n');
  console.log('  Press Ctrl+C to close early.\n');
  try {
    await page.waitForTimeout(12 * 60 * 1000);
  } catch {
    // Browser closed early (e.g. daemon task timeout or Ctrl+C) — that's fine,
    // the n8n pipeline was already triggered successfully.
  }

  try { await context.close(); } catch { /* already closed */ }
});
