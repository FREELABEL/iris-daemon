import { Page, BrowserContext } from '@playwright/test';
import {
  BaseDiscoveryProvider,
  DiscoveredProfile,
  DiscoveryConfig,
  DiscoveryResult,
  dismissInstagramPopups, keepDiscovered } from './base-provider';

export class InstagramCommentsProvider extends BaseDiscoveryProvider {
  readonly platform = 'instagram';
  readonly discoveryType = 'comments';

  async discover(
    page: Page,
    context: BrowserContext,
    config: DiscoveryConfig
  ): Promise<DiscoveryResult> {
    const errors: string[] = [];
    const start = Date.now();
    const seen = new Set<string>();
    const profiles: DiscoveredProfile[] = [];

    // Step 1: Resolve post URL
    let postUrl = config.targetUrl;
    if (!postUrl.includes('/p/') && !postUrl.includes('/reel/')) {
      console.log(`    Target is a profile URL — finding latest post...`);
      postUrl = await this.findLatestPost(page, config.targetUrl);
      if (!postUrl) {
        errors.push('Could not find latest post on profile');
        return { profiles, totalScraped: 0, totalAfterFilter: 0, durationMs: Date.now() - start, errors };
      }
      console.log(`    Found latest post: ${postUrl}`);
    }

    // Step 2: Navigate to post
    console.log(`    Navigating to post: ${postUrl}`);
    await page.goto(postUrl);
    await page.waitForTimeout(3000);
    await dismissInstagramPopups(page);

    // Timing config — randomized to break detection patterns
    const baseDelay = config.scrollDelay || 3000;
    const jitteredDelay = () => baseDelay + Math.floor((Math.random() - 0.5) * baseDelay * 0.8);
    const COOLDOWN_EVERY = 50;
    const cooldownMs = () => 15000 + Math.floor(Math.random() * 10000);

    // Step 2b: For Reels — click the comment bubble icon to expand comments panel
    const commentBubble = page.locator('svg[aria-label="Comment"]').first();
    if (await commentBubble.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log(`    Clicking comment bubble to expand comments...`);
      await commentBubble.click();
      await page.waitForTimeout(2000 + Math.floor(Math.random() * 2000));
    }

    // Step 3: Click "View all N comments" to load the full comment list
    await this.loadMoreComments(page, baseDelay);
    await page.waitForTimeout(1500 + Math.floor(Math.random() * 1500));
    await this.loadMoreComments(page, baseDelay);

    // Step 4: Skip reply expansion — top-level commenters only for speed

    // Step 5: Scroll and extract commenters
    let noNewCount = 0;

    try {
    for (let scroll = 0; scroll < config.scrollAttempts && profiles.length < config.limit; scroll++) {
      const prevSize = seen.size;

      // Extract comments using structural DOM selectors:
      // - Each comment has a permalink a[href*="/c/"] (captions don't)
      // - Walk up from permalink to find widest single-comment container
      // - Username from a[href^="/{username}/"] profile links
      // - Comment text from leaf <span dir="auto"> elements (not inside buttons)
      const commentData = await page.evaluate(() => {
        const results: { username: string; displayName: string; commentText: string; timestamp: string }[] = [];
        const skipPaths = new Set(['explore', 'accounts', 'reels', 'stories', 'direct', 'p', 'reel', 'tags', 'locations']);
        const skipTextPatterns = /^(Reply|View|Load|like|likes?|Hide|Report|See translation|Edited|\d+\s*likes?|\d+\s*(w|d|h|m|s)$)/i;
        const usernamePattern = /^\/([a-zA-Z0-9._]+)\/?$/;

        // Helper: find username link in an element
        const findUsername = (el: Element): { username: string; displayName: string } | null => {
          const links = el.querySelectorAll('a[href^="/"]');
          for (const link of Array.from(links)) {
            const href = link.getAttribute('href') || '';
            const match = href.match(usernamePattern);
            if (match && !skipPaths.has(match[1])) {
              // Clean displayName: remove "Verified" badge text that gets included from SVG title
              let display = link.textContent?.trim() || match[1];
              display = display.replace(/Verified$/i, '').trim() || match[1];
              return {
                username: match[1],
                displayName: display,
              };
            }
          }
          return null;
        };

        // Find all comment permalink timestamps: a[href*="/c/"] > time[datetime]
        const commentPermalinks = document.querySelectorAll('a[href*="/c/"]');

        for (const permalink of Array.from(commentPermalinks)) {
          const timeEl = permalink.querySelector('time[datetime]');
          const timestamp = timeEl?.getAttribute('datetime') || '';

          // Walk up from permalink. Find username first, then keep walking
          // until we reach the widest container that still has cLinks=1
          // (single comment). This ensures we capture the comment text
          // which is in a sibling DIV of the username row.
          let commentItem: Element | null = permalink;
          let user: { username: string; displayName: string } | null = null;
          let bestContainer: Element | null = null;

          for (let i = 0; i < 12 && commentItem; i++) {
            commentItem = commentItem.parentElement;
            if (!commentItem) break;

            // Track when we first find a username
            if (!user) user = findUsername(commentItem);

            // Once we have a username, keep going up while this is still
            // a single-comment container (1 /c/ link = our comment only)
            if (user) {
              const cLinks = commentItem.querySelectorAll('a[href*="/c/"]').length;
              if (cLinks === 1) {
                bestContainer = commentItem;
              } else {
                // Hit a container with multiple comments — stop
                break;
              }
            }
          }

          if (!user || !bestContainer) continue;

          // Extract comment text from the widest single-comment container
          let commentText = '';

          // Helper: check if a span is inside a role="button" element
          const isInsideButton = (el: Element): boolean => {
            let p: Element | null = el.parentElement;
            while (p && p !== bestContainer) {
              if (p.getAttribute('role') === 'button') return true;
              p = p.parentElement;
            }
            return false;
          };

          // Strategy 1: leaf <span dir="auto"> not containing links/time/svg
          // These are the actual comment text spans on Instagram
          const allSpans = bestContainer.querySelectorAll('span[dir]');
          for (const span of Array.from(allSpans)) {
            if (span.querySelector('a, time, svg')) continue;
            if (isInsideButton(span)) continue;
            const text = span.textContent?.trim() || '';
            if (!text || text.length < 2) continue;
            if (text === user.username || text === user.displayName) continue;
            if (skipTextPatterns.test(text)) continue;
            if (text.length > commentText.length) commentText = text;
          }

          // Strategy 2: any leaf span (no dir requirement)
          if (!commentText) {
            const leafSpans = bestContainer.querySelectorAll('span');
            for (const span of Array.from(leafSpans)) {
              if (span.querySelector('a, time, svg')) continue;
              if (span.children.length > 0) continue; // true leaf only
              if (isInsideButton(span)) continue;
              const text = span.textContent?.trim() || '';
              if (!text || text.length < 2) continue;
              if (text === user.username || text === user.displayName) continue;
              if (skipTextPatterns.test(text)) continue;
              if (text.length > commentText.length) commentText = text;
            }
          }

          // Strategy 3: clone container, strip known elements, get remaining text
          if (!commentText) {
            const clone = bestContainer.cloneNode(true) as Element;
            clone.querySelectorAll('time, svg, [role="button"], a[href*="/c/"]').forEach(el => el.remove());
            const rawText = clone.textContent?.trim() || '';
            let cleaned = rawText;
            // Remove username prefix
            if (cleaned.toLowerCase().startsWith(user.username.toLowerCase())) {
              cleaned = cleaned.substring(user.username.length).trim();
            }
            // Remove "Verified" badge text
            cleaned = cleaned.replace(/^Verified\s*/i, '').trim();
            // Remove trailing UI text
            cleaned = cleaned.replace(/\d+\s*likes?\s*$/i, '').trim();
            cleaned = cleaned.replace(/\s*(Reply|See translation)\s*$/gi, '').trim();
            if (cleaned.length > 2) commentText = cleaned;
          }

          results.push({
            username: user.username,
            displayName: user.displayName,
            commentText: commentText.substring(0, 500),
            timestamp,
          });
        }

        return results;
      });

      let skippedExisting = 0;
      for (const c of commentData) {
        const key = c.username.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          // Skip handles already on the board — don't count toward limit
          if (config.existingHandles?.has(key)) {
            skippedExisting++;
            continue;
          }
          const profile: DiscoveredProfile = {
            username: c.username,
            platform: 'instagram',
            displayName: c.displayName,
            profileUrl: `https://www.instagram.com/${c.username}/`,
            sourceContext: `comment on ${postUrl}`,
            rawMetadata: {
              commentText: c.commentText || '',
              timestamp: c.timestamp || '',
            },
          };
          if (keepDiscovered(profile, config)) {
            profiles.push(profile);
          }
        }
      }

      const newFound = seen.size - prevSize;
      const skipNote = skippedExisting > 0 ? `, ${skippedExisting} existing skipped` : '';
      console.log(`    Scroll ${scroll + 1}/${config.scrollAttempts}: ${seen.size} unique, ${profiles.length} new` +
        (newFound === 0 ? ' (no new)' : ` (+${newFound})`) + skipNote);

      if (newFound === 0) {
        noNewCount++;

        // Try clicking "Load more" buttons when scrolling stalls
        if (noNewCount >= 2) {
          await this.loadMoreComments(page, jitteredDelay());
        }

        // Check if scroll container is already at the bottom
        const atBottom = await page.evaluate(() => {
          const commentLink = document.querySelector('a[href*="/c/"]');
          if (!commentLink) return true;
          let el: Element | null = commentLink.parentElement;
          while (el) {
            const style = window.getComputedStyle(el);
            if ((style.overflowY === 'auto' || style.overflowY === 'scroll') &&
                el.scrollHeight > el.clientHeight) {
              return el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
            }
            el = el.parentElement;
          }
          return true;
        });

        // Stop faster at bottom — 2 empty scrolls at bottom is enough
        if (atBottom && noNewCount >= Math.max(2, Number(process.env.NO_NEW_LIMIT || 4) - 2)) {
          console.log(`    Reached bottom of comments — stopping`);
          break;
        }
        // comments load in bursts on big posts; NO_NEW_LIMIT lets a long run wait longer before giving up
        if (noNewCount >= Number(process.env.NO_NEW_LIMIT || 4)) {
          console.log(`    No new comments after ${noNewCount} scrolls — stopping`);
          break;
        }
      } else {
        noNewCount = 0;
      }

      if (profiles.length >= config.limit) break;

      // Cooldown pause every N scrolls — mimic human taking a break
      if (scroll > 0 && scroll % COOLDOWN_EVERY === 0) {
        const cd = cooldownMs();
        console.log(`    Cooldown: pausing ${Math.round(cd / 1000)}s after ${scroll} scrolls (${profiles.length} leads found)...`);
        await page.waitForTimeout(cd);
      }

      // Scroll the comment container to trigger infinite loading
      await this.scrollCommentContainer(page, jitteredDelay());

      // Every 5 scrolls, try loading more comments
      if (scroll % 5 === 4) {
        await this.loadMoreComments(page, jitteredDelay());
      }
    }
    } catch (err: any) {
      // Browser closed or page crashed — return whatever we collected
      console.log(`    ⚠️  Scroll interrupted (${err.message?.substring(0, 60)})`);
      console.log(`    Returning ${profiles.length} profiles collected before interruption`);
      errors.push(`Interrupted: ${err.message?.substring(0, 100)}`);
    }

    return {
      profiles: profiles.slice(0, config.limit),
      totalScraped: seen.size,
      totalAfterFilter: Math.min(profiles.length, config.limit),
      durationMs: Date.now() - start,
      errors,
    };
  }

  /** Find the latest post URL from a profile page. */
  private async findLatestPost(page: Page, profileUrl: string): Promise<string | null> {
    await page.goto(profileUrl);
    await page.waitForTimeout(3000);
    await dismissInstagramPopups(page);

    const firstPost = page.locator('article a[href*="/p/"], article a[href*="/reel/"], main a[href*="/p/"], main a[href*="/reel/"]').first();
    if (await firstPost.isVisible({ timeout: 5000 }).catch(() => false)) {
      const href = await firstPost.getAttribute('href');
      return href ? `https://www.instagram.com${href}` : null;
    }
    return null;
  }

  /** Click all visible "View all N replies" buttons to expand reply threads. */
  private async expandReplyThreads(page: Page, delay: number): Promise<void> {
    // IG reply toggle: div[role="button"] containing span with "View all N repl..."
    try {
      const replyButtons = page.locator('div[role="button"]').filter({
        hasText: /View all \d+ repl/i
      });
      const count = await replyButtons.count();
      for (let i = 0; i < Math.min(count, 15); i++) { // Max 15 per pass
        try {
          const btn = replyButtons.nth(i);
          if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
            await btn.click();
            await page.waitForTimeout(delay);
          }
        } catch { /* reply already expanded or gone */ }
      }
    } catch { /* no reply buttons */ }
  }

  /**
   * Click "View all N comments" / "Load more comments" / "+" buttons
   * that Instagram shows on high-engagement posts before infinite scroll kicks in.
   */
  private async loadMoreComments(page: Page, delay: number): Promise<void> {
    try {
      // Strategy 1: "View all N comments" button (shown on initial load)
      const viewAll = page.locator('span, div[role="button"], a, li').filter({
        hasText: /View all \d+[\s,]* comments?/i,
      });
      if (await viewAll.first().isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log(`    Clicking "View all comments" button...`);
        await viewAll.first().click();
        await page.waitForTimeout(delay + 2000); // extra wait for comment panel to load
        return;
      }

      // Strategy 2: "Load more comments" / "View more comments" link/button
      const loadMore = page.locator('button, div[role="button"], a, span').filter({
        hasText: /load more|view more|more comments|View previous/i,
      });
      if (await loadMore.first().isVisible({ timeout: 1000 }).catch(() => false)) {
        console.log(`    Clicking "Load more" button...`);
        await loadMore.first().click();
        await page.waitForTimeout(delay);
        return;
      }

      // Strategy 3: IG's "load previous comments" button with a "+" icon
      // Only match buttons whose visible text contains "+" and nothing else suspicious
      const prevComments = page.locator('button, div[role="button"]').filter({
        hasText: /^[\s+]+$|load previous|view previous/i,
      });
      if (await prevComments.first().isVisible({ timeout: 500 }).catch(() => false)) {
        console.log(`    Clicking "load previous" button...`);
        await prevComments.first().click();
        await page.waitForTimeout(delay);
      }
    } catch { /* no load-more buttons found */ }
  }

  /**
   * Scroll the comment container to trigger IG's infinite scroll loading.
   * Uses multiple strategies to find and scroll the correct container.
   */
  private async scrollCommentContainer(page: Page, delay: number): Promise<void> {
    await page.evaluate(() => {
      // Helper: find the scrollable comment container
      const findScrollable = (): Element | null => {
        // Strategy 1: Find via comment permalink anchor
        const commentLink = document.querySelector('a[href*="/c/"]');
        if (commentLink) {
          let el: Element | null = commentLink.parentElement;
          while (el) {
            const style = window.getComputedStyle(el);
            if ((style.overflowY === 'auto' || style.overflowY === 'scroll') &&
                el.scrollHeight > el.clientHeight) {
              return el;
            }
            el = el.parentElement;
          }
        }

        // Strategy 2: Any scrollable container with comment content
        const scrollables = Array.from(document.querySelectorAll('*')).filter(el => {
          const style = window.getComputedStyle(el);
          return (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
                 el.scrollHeight > el.clientHeight &&
                 el.clientHeight > 200 &&
                 el.querySelectorAll('a[href*="/c/"]').length > 0;
        });
        if (scrollables.length > 0) return scrollables[scrollables.length - 1];

        // Strategy 3: Dialog-based scrollable
        const dialogScrollable = Array.from(
          document.querySelectorAll('div[role="dialog"] div, article div')
        ).filter(el => {
          const style = window.getComputedStyle(el);
          return (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
                 el.scrollHeight > el.clientHeight &&
                 el.clientHeight > 200;
        });
        if (dialogScrollable.length > 0) return dialogScrollable[0];

        return null;
      };

      const container = findScrollable();
      if (container) {
        // Incremental scroll (800px) instead of jumping to absolute bottom
        // This better triggers Instagram's lazy loading observer
        container.scrollTop += 800;
        // If still near the bottom, jump to absolute bottom to trigger load
        if (container.scrollTop + container.clientHeight >= container.scrollHeight - 50) {
          container.scrollTop = container.scrollHeight;
        }
      } else {
        // Full page scroll as last resort
        window.scrollBy(0, 1200);
      }
    });
    await page.waitForTimeout(delay);
  }
}
