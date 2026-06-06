import { test } from '@playwright/test';
import { dismissInstagramPopups } from './helpers/providers/base-provider';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Instagram Inbox — Read-only DM thread extractor for a single handle.
 *
 * Navigates to a specific user's DM thread and extracts the full message history.
 * Does NOT send anything.
 *
 * Env vars:
 *   TARGET_HANDLE        — IG username to read DMs for (required)
 *   IG_ACCOUNT           — Which IG account to read from (default: heyiris.io)
 *   BROWSER_SESSION_FILE — Path to session JSON
 *   OUTPUT_FILE          — Optional path to write JSON output
 */

const TARGET_HANDLE = process.env.TARGET_HANDLE || '';
const IG_ACCOUNT = process.env.IG_ACCOUNT || 'heyiris.io';
const OUTPUT_FILE = process.env.OUTPUT_FILE || '';

const IG_AUTH_FILE = process.env.BROWSER_SESSION_FILE
  || path.join(__dirname, `instagram-auth-${IG_ACCOUNT}.json`);

/** Dismiss all known IG popups/dialogs aggressively */
async function dismissAllPopups(page: any): Promise<void> {
  await dismissInstagramPopups(page);
  const dismissTexts = ['Not Now', 'Not now', 'Cancel', 'Dismiss', 'Maybe Later', 'Block', 'Close'];
  for (const text of dismissTexts) {
    try {
      const btn = page.locator(`button:has-text("${text}")`).first();
      if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(400);
      }
    } catch {}
  }
  // Close any role="dialog" via X button
  try {
    const closeBtn = page.locator('[role="dialog"] button[aria-label="Close"], [role="dialog"] svg[aria-label="Close"]').first();
    if (await closeBtn.isVisible({ timeout: 800 }).catch(() => false)) {
      await closeBtn.click();
      await page.waitForTimeout(400);
    }
  } catch {}
}

test(`Instagram Inbox — read DMs with @${TARGET_HANDLE}`, async ({ page, context }) => {
  if (!TARGET_HANDLE) {
    console.log('ERROR: TARGET_HANDLE env var required');
    return;
  }

  // -- Load session cookies --
  if (!fs.existsSync(IG_AUTH_FILE)) {
    console.log(`No session file: ${IG_AUTH_FILE}`);
    return;
  }
  const state = JSON.parse(fs.readFileSync(IG_AUTH_FILE, 'utf-8'));
  if (state.cookies?.length > 0) {
    await context.addCookies(state.cookies);
    console.log(`Session loaded for @${IG_ACCOUNT}`);
  } else {
    console.log('Session file has no cookies.');
    return;
  }

  let threadOpen = false;

  // ── Strategy 1: Go to inbox, use sidebar search to find the thread ──
  console.log(`\nOpening DM thread with @${TARGET_HANDLE}...`);
  try {
    await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded' });
  } catch {
    // Retry with longer wait on ERR_ABORTED
    await page.waitForTimeout(2000);
    await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'load', timeout: 15000 });
  }
  await page.waitForTimeout(3000);
  await dismissAllPopups(page);
  await page.waitForTimeout(500);
  await dismissAllPopups(page); // second pass for stacked popups

  // Click the Search input in the inbox sidebar
  const searchInput = page.locator('input[placeholder="Search"], input[aria-label="Search"]').first();
  if (await searchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await searchInput.click();
    await page.waitForTimeout(500);
    await searchInput.fill(TARGET_HANDLE);
    await page.waitForTimeout(3000);

    // Click the matching conversation result
    // IG shows results as clickable rows — look for the handle text
    const searchResult = page.locator(`[role="listbox"] [role="option"], [role="button"]`).filter({ hasText: new RegExp(TARGET_HANDLE, 'i') }).first();
    if (await searchResult.isVisible({ timeout: 3000 }).catch(() => false)) {
      await searchResult.click();
      await page.waitForTimeout(3000);
      threadOpen = true;
      console.log('  Opened DM via inbox search');
    } else {
      // Try clicking any visible result that contains the handle
      const anyResult = page.getByText(TARGET_HANDLE, { exact: false }).first();
      if (await anyResult.isVisible({ timeout: 2000 }).catch(() => false)) {
        await anyResult.click();
        await page.waitForTimeout(3000);
        threadOpen = true;
        console.log('  Opened DM via search text match');
      }
    }
  }

  // ── Strategy 2: Go to profile, click Message ──
  if (!threadOpen) {
    console.log('  Inbox search failed, trying profile Message button...');
    await page.goto(`https://www.instagram.com/${TARGET_HANDLE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await dismissAllPopups(page);

    const msgBtn = page.locator('div[role="button"]:has-text("Message"), button:has-text("Message")').first();
    if (await msgBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await msgBtn.click();
      try {
        await page.waitForURL(/\/direct\//, { timeout: 8000 });
        threadOpen = true;
        console.log('  Opened DM via profile Message button');
      } catch {
        // Check if textbox appeared (overlay DM)
        const textbox = page.locator('div[role="textbox"][contenteditable="true"]').first();
        if (await textbox.isVisible({ timeout: 3000 }).catch(() => false)) {
          threadOpen = true;
          console.log('  Opened DM overlay on profile page');
        }
      }
      await page.waitForTimeout(2000);
      await dismissAllPopups(page);
    }
  }

  // ── Strategy 3: Compose new message flow ──
  if (!threadOpen) {
    console.log('  Trying compose flow...');
    await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await dismissAllPopups(page);
    await page.waitForTimeout(500);
    await dismissAllPopups(page);

    const composeBtn = page.locator('svg[aria-label="New message"], [aria-label="New message"]').first();
    if (await composeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await composeBtn.click();
      await page.waitForTimeout(2000);
      await dismissAllPopups(page);
    }

    // Type in compose search
    const composeInput = page.locator('input[placeholder="Search..."], input[name="queryBox"]').first();
    if (await composeInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await composeInput.fill(TARGET_HANDLE);
    } else {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(500);
      await page.keyboard.type(TARGET_HANDLE, { delay: 30 });
    }
    await page.waitForTimeout(3000);

    const result = page.getByText(TARGET_HANDLE, { exact: false }).first();
    if (await result.isVisible({ timeout: 3000 }).catch(() => false)) {
      await result.click();
      await page.waitForTimeout(1000);
      const nextBtn = page.locator('div[role="button"]:has-text("Chat"), div[role="button"]:has-text("Next")').first();
      if (await nextBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await nextBtn.click();
        await page.waitForTimeout(2000);
      }
      threadOpen = true;
      console.log('  Opened DM via compose flow');
    }
  }

  if (!threadOpen) {
    console.log(`  Could not open DM thread with @${TARGET_HANDLE}`);
    await page.screenshot({ path: `test-results/inbox-fail-${Date.now()}.png` }).catch(() => {});
    return;
  }

  // Wait for thread messages to load
  await page.waitForTimeout(3000);
  await dismissAllPopups(page);

  console.log(`  Thread URL: ${page.url()}`);

  // -- Extract username from thread header --
  const handle = await page.evaluate((displayName: string) => {
    const profileOpeners = document.querySelectorAll('a[aria-label^="Open the profile page"]');
    for (const link of Array.from(profileOpeners)) {
      const label = link.getAttribute('aria-label') || '';
      const match = label.match(/Open the profile page of (.+)/i);
      if (match) return match[1].trim();
    }

    const headerTitle = document.querySelector('h2 span[title]');
    if (headerTitle) {
      const title = headerTitle.getAttribute('title') || '';
      if (title && title !== displayName) return title;
      const headerLink = headerTitle.closest('a');
      if (headerLink) {
        const href = headerLink.getAttribute('href') || '';
        const hrefMatch = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
        if (hrefMatch) return hrefMatch[1];
      }
    }

    const profileLinks = document.querySelectorAll('a[href^="/"]');
    const usernamePattern = /^\/([a-zA-Z0-9._]+)\/?$/;
    const skipPaths = new Set(['direct', 'explore', 'accounts', 'reels', 'stories', 'p', 'reel', 'tags', 'locations', 'inbox']);
    for (const link of Array.from(profileLinks)) {
      const href = link.getAttribute('href') || '';
      const match = href.match(usernamePattern);
      if (!match || skipPaths.has(match[1])) continue;
      const rect = link.getBoundingClientRect();
      if (rect.top < 150 && rect.left > window.innerWidth * 0.3) return match[1];
    }
    return '';
  }, TARGET_HANDLE);

  // -- Extract display name from thread header --
  const displayName = await page.evaluate(() => {
    const headerTitle = document.querySelector('h2 span[title]');
    if (headerTitle) return (headerTitle.getAttribute('title') || headerTitle.textContent || '').trim();
    const profileOpeners = document.querySelectorAll('a[aria-label^="Open the profile page"]');
    for (const link of Array.from(profileOpeners)) {
      const label = link.getAttribute('aria-label') || '';
      const match = label.match(/Open the profile page of (.+)/i);
      if (match) return match[1].trim();
    }
    return '';
  });

  // -- Extract messages from thread --
  const rawMessages = await page.evaluate(() => {
    const messages: Array<{ sender: string; body: string; timestamp: string }> = [];
    const seenBodies = new Set<string>();

    // Strategy 1: role="row" message rows in the right panel
    const messageRows = document.querySelectorAll('[role="row"], [role="listitem"]');
    const rightPanelRows = Array.from(messageRows).filter(row => {
      const rect = row.getBoundingClientRect();
      return rect.left > window.innerWidth * 0.3;
    });

    if (rightPanelRows.length > 0) {
      let lastKnownSender = '';
      for (const row of rightPanelRows) {
        let sender = '';
        const profileLink = row.querySelector('a[href^="/"][role="link"] img[alt*="profile"]');
        if (profileLink) {
          const link = profileLink.closest('a');
          const href = (link?.getAttribute('href') || '').replace(/\//g, '');
          if (href) { sender = href; lastKnownSender = sender; }
        }
        if (!sender) {
          const profLink = row.querySelector('a[aria-label*="profile page"]');
          if (profLink) {
            const href = (profLink.getAttribute('href') || '').replace(/\//g, '');
            if (href) { sender = href; lastKnownSender = sender; }
          }
        }
        if (!sender) {
          const senderImg = row.querySelector('img[alt*="profile picture"]');
          if (senderImg) {
            const alt = (senderImg.getAttribute('alt') || '').trim();
            const match = alt.match(/^(.+?)(?:'s)?\s+profile\s+picture$/i);
            if (match) { sender = match[1]; lastKnownSender = sender; }
          }
        }
        if (!sender) {
          const msgBubble = row.querySelector('div[dir="auto"], span[dir="auto"]');
          if (msgBubble) {
            const bubbleRect = msgBubble.getBoundingClientRect();
            const parentWidth = row.parentElement?.getBoundingClientRect().width || window.innerWidth * 0.6;
            const isLeftAligned = bubbleRect.left < (row.getBoundingClientRect().left + parentWidth * 0.5);
            sender = isLeftAligned ? (lastKnownSender || 'them') : 'me';
          }
        }

        const spans = row.querySelectorAll('span[dir], div[dir="auto"] span');
        let body = '';
        for (const span of Array.from(spans)) {
          if (span.querySelector('span')) continue;
          const text = (span.textContent || '').trim();
          if (!text || text.length < 2) continue;
          if (text.match(/^(Seen|Delivered|Sent|Like|Reply|Unsend|\d+[mhdw])/i)) continue;
          if (text.match(/^(Today|Yesterday|\d{1,2}:\d{2})/i)) continue;
          if (text.length > body.length) body = text;
        }

        const timeEl = row.querySelector('time');
        const timestamp = timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent || '').trim() : '';

        if (body && body.length > 1 && !seenBodies.has(body)) {
          seenBodies.add(body);
          messages.push({ sender: sender || 'unknown', body, timestamp });
        }
      }
    }

    // Strategy 2: div[dir="auto"] broad scan (fallback for any thread layout)
    if (messages.length === 0) {
      const threadPanelLeft = window.innerWidth * 0.38; // left edge of thread panel
      const threadPanelRight = window.innerWidth; // right edge
      const threadCenter = threadPanelLeft + (threadPanelRight - threadPanelLeft) * 0.5; // true center of thread panel
      const allDirAuto = document.querySelectorAll('div[dir="auto"]');
      for (const el of Array.from(allDirAuto)) {
        const rect = el.getBoundingClientRect();
        // Only look at elements in the right half (thread area) and visible
        if (rect.left < window.innerWidth * 0.25 || rect.width < 20 || rect.height < 10) continue;
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length < 2) continue;
        if (text.match(/^(Seen|Delivered|Sent|Like|Reply|Unsend|Type a message|Active|Message\.\.\.|View transcription|Search|Primary|General|Requests)/i)) continue;
        if (text.match(/^(Today|Yesterday|\d{1,2}:\d{2})/i)) continue;
        if (seenBodies.has(text)) continue;
        seenBodies.add(text);

        // Determine sender by bubble styling
        // IG uses blue/purple background for "me" bubbles, light/white for "them"
        let sender = 'unknown';

        // Walk up to find the colored bubble container
        let parent: Element | null = el;
        let isBlueBubble = false;
        for (let i = 0; i < 5 && parent; i++) {
          const bg = window.getComputedStyle(parent).backgroundColor;
          // Blue/purple bubbles have high blue component — rgb(x, y, z) where z > 150
          const rgbMatch = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          if (rgbMatch) {
            const [, r, g, b] = rgbMatch.map(Number);
            // Blue-ish: blue > 150 and blue > red (IG uses various blue shades for sent msgs)
            if (b > 150 && b > r + 30) { isBlueBubble = true; break; }
            // Also check for gradient/solid dark blue
            if (r < 100 && g < 100 && b > 180) { isBlueBubble = true; break; }
          }
          parent = parent.parentElement;
        }

        if (isBlueBubble) {
          sender = 'me';
        } else {
          // Check for nearby profile pic (left side = them)
          const container = el.closest('div[role="row"], div[role="listitem"]') || el.parentElement?.parentElement?.parentElement;
          const nearbyImg = container?.querySelector('img[alt*="profile picture"]');
          sender = nearbyImg ? 'them' : (rect.left > threadCenter ? 'me' : 'them');
        }

        messages.push({ sender, body: text, timestamp: '' });
      }
    }

    // Strategy 3: div[role="group"] blocks
    if (messages.length === 0) {
      const groups = document.querySelectorAll('div[role="group"]');
      const rightGroups = Array.from(groups).filter(g => {
        const rect = g.getBoundingClientRect();
        return rect.left > window.innerWidth * 0.25 && rect.width > 100;
      });

      for (const group of rightGroups) {
        const hasProfileLink = group.querySelector('a[aria-label*="profile page"], a[href^="/"][role="link"] img');
        const sender = hasProfileLink ? 'them' : 'me';
        const textEls = group.querySelectorAll('div[dir="auto"]');
        for (const el of Array.from(textEls)) {
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (text.length < 2) continue;
          if (text.match(/^(Seen|Delivered|Sent|Like|Reply|Unsend|Type a message|Active|Message\.\.\.|View transcription)/i)) continue;
          if (text.match(/^(Today|Yesterday|\d{1,2}:\d{2})/i)) continue;
          if (seenBodies.has(text)) continue;
          seenBodies.add(text);
          messages.push({ sender, body: text, timestamp: '' });
        }
      }
    }

    return messages.slice(-30);
  });

  // -- Build output --
  const lastMsg = rawMessages.length > 0 ? rawMessages[rawMessages.length - 1] : null;
  const output = {
    handle: handle || TARGET_HANDLE,
    display_name: displayName || TARGET_HANDLE,
    messages: rawMessages,
    message_count: rawMessages.length,
    last_message_from: lastMsg?.sender || null,
    last_message: lastMsg?.body || null,
  };

  // Print JSON to stdout for CLI capture
  console.log('\n--- INBOX_JSON_START ---');
  console.log(JSON.stringify(output, null, 2));
  console.log('--- INBOX_JSON_END ---');

  // Write to file if requested
  if (OUTPUT_FILE) {
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
    console.log(`\nOutput written to ${OUTPUT_FILE}`);
  }

  console.log(`\nDone — ${rawMessages.length} messages from @${handle || TARGET_HANDLE}`);
});
