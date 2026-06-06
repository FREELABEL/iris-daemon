import { Page, BrowserContext } from '@playwright/test';
import {
  BaseDiscoveryProvider,
  DiscoveredProfile,
  DiscoveryConfig,
  DiscoveryResult,
  dismissInstagramPopups,
} from './base-provider';

/**
 * Instagram Inbox Provider — scrapes DM conversations from instagram.com/direct/inbox/
 *
 * ARCHITECTURE: Single-pass scroll+click.
 * IG virtualizes sidebar items — once you scroll past a conversation, it's removed from DOM.
 * So we MUST click into each conversation immediately when it appears, read messages,
 * go back to the sidebar, then scroll for more. No two-phase collect-then-click.
 */
export class InstagramInboxProvider extends BaseDiscoveryProvider {
  readonly platform = 'instagram';
  readonly discoveryType = 'inbox';

  private grabMessages = process.env.GRAB_MESSAGES !== '0';

  async discover(
    page: Page,
    context: BrowserContext,
    config: DiscoveryConfig
  ): Promise<DiscoveryResult> {
    const errors: string[] = [];
    const start = Date.now();
    const seen = new Set<string>();
    const profiles: DiscoveredProfile[] = [];

    console.log(`    Navigating to Instagram DMs...`);
    await page.goto('https://www.instagram.com/direct/inbox/');
    await page.waitForTimeout(4000);

    await dismissInstagramPopups(page);
    await page.waitForTimeout(2000);
    await this.dismissNotificationPrompt(page);
    await page.waitForTimeout(1000);

    // Switch to "General" tab — cold-DM replies land here (not Primary)
    const inboxTab = process.env.INBOX_TAB?.toLowerCase() || 'general';
    if (inboxTab !== 'primary') {
      const generalTab = page.locator('span:text-is("General"), div[role="tab"]:has-text("General"), button:has-text("General")').first();
      if (await generalTab.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log(`    Switching to "${inboxTab}" tab...`);
        await generalTab.click();
        await page.waitForTimeout(3000);
        await dismissInstagramPopups(page);
      } else {
        console.log(`    No "General" tab found — staying on current tab`);
      }
    }

    // ── Single-pass: scroll sidebar, click each NEW conversation immediately, read, go back ──
    let noNewCount = 0;
    let totalScrolls = 0;

    for (let scroll = 0; scroll < config.scrollAttempts && profiles.length < config.limit; scroll++) {
      totalScrolls = scroll + 1;

      // Get ALL currently visible conversation names in the sidebar
      const visibleContacts = await page.evaluate(() => {
        const results: { name: string; lastMessage: string; timestamp: string }[] = [];
        const titleSpans = document.querySelectorAll('span[title]');
        const seenNames = new Set<string>();

        for (const span of Array.from(titleSpans)) {
          const title = (span.getAttribute('title') || '').trim();
          if (!title || title.length < 2 || title === 'Verified' || title === 'Instagram') continue;
          if (seenNames.has(title)) continue;

          const row = span.closest('[role="button"]') || span.closest('[role="listitem"]');
          if (!row) continue;

          const parentLi = row.closest('li');
          if (parentLi) {
            const liStyle = parentLi.getAttribute('style') || '';
            if (liStyle.includes('translateX')) continue;
          }

          const profilePic = row.querySelector('img[alt]') as HTMLImageElement | null;
          if (!profilePic) continue;

          seenNames.add(title);

          let lastMessage = '';
          const allSpans = row.querySelectorAll('span');
          for (const s of Array.from(allSpans)) {
            if (s.querySelector('span')) continue;
            const text = (s.textContent || '').trim();
            if (text === title || text === 'Verified') continue;
            if (text.match(/^\d+[mhdw]$/i)) continue;
            if (text.length > 10 && text.length < 300) { lastMessage = text; break; }
          }

          let timestamp = '';
          const abbr = row.querySelector('abbr[aria-label]');
          if (abbr) timestamp = abbr.getAttribute('aria-label') || (abbr.textContent || '').trim();

          results.push({ name: title, lastMessage, timestamp });
        }
        return results;
      });

      // Find NEW contacts we haven't processed yet
      const newContacts = visibleContacts.filter(c => !seen.has(c.name.toLowerCase()));

      if (newContacts.length === 0) {
        noNewCount++;
        console.log(`    Scroll ${scroll + 1}: ${seen.size} total, no new visible`);
        if (noNewCount >= 5) break;
      } else {
        noNewCount = 0;
      }

      // Process each NEW conversation IMMEDIATELY (before scrolling past it)
      for (const contact of newContacts) {
        if (profiles.length >= config.limit) break;

        const key = contact.name.toLowerCase();
        seen.add(key);

        let fullMessages = '';
        let username = '';

        if (this.grabMessages) {
          // Click the conversation in the sidebar — IG loads thread in the RIGHT panel
          // The sidebar stays intact (split-view layout). No page navigation needed.
          const clicked = await this.clickConversationInView(page, contact.name);

          if (!clicked) {
            // Retry once after a short wait — IG may still be rendering after scroll
            await page.waitForTimeout(1500);
            const retryClicked = await this.clickConversationInView(page, contact.name);
            if (!retryClicked) {
              console.log(`    [${profiles.length + 1}/${config.limit}] ${contact.name} — click failed`);
            } else {
              await page.waitForTimeout(2500);
              username = await this.extractUsernameFromThread(page, contact.name);
              fullMessages = await this.extractMessages(page);
            }
          } else {
            // Wait for thread to load in right panel
            await page.waitForTimeout(2500);

            // Extract @username from thread header (right panel)
            username = await this.extractUsernameFromThread(page, contact.name);

            // Extract messages from right panel
            fullMessages = await this.extractMessages(page);
          }

          if (fullMessages || username) {
            const msgCount = fullMessages ? fullMessages.split('\n').length : 0;
            const preview = fullMessages ? fullMessages.substring(0, 100).replace(/\n/g, ' | ') : '(empty)';
            console.log(`    [${profiles.length + 1}/${config.limit}] ${contact.name}${username ? ` (@${username})` : ''} — ${msgCount} msgs`);
            if (preview !== '(empty)') console.log(`      "${preview}${fullMessages.length > 100 ? '...' : ''}"`);
          }

          // NO navigation back — sidebar is still there in split-view.
          // Just a small delay before clicking the next conversation.
          await page.waitForTimeout(800 + Math.random() * 700);
        }

        const profile: DiscoveredProfile = {
          username: username || contact.name,
          platform: 'instagram',
          displayName: contact.name,
          profileUrl: username ? `https://www.instagram.com/${username}/` : undefined,
          sourceContext: 'instagram inbox',
          rawMetadata: {
            lastMessage: contact.lastMessage,
            timestamp: contact.timestamp,
            fullMessages: fullMessages || undefined,
          },
        };

        if (!config.filterFn || config.filterFn(profile)) {
          profiles.push(profile);
        }
      }

      if (profiles.length >= config.limit) break;

      // Scroll the sidebar for more conversations
      await this.scrollSidebar(page);
      await page.waitForTimeout(config.scrollDelay || 3000);
    }

    console.log(`    Done: ${profiles.length} conversations processed in ${totalScrolls} scrolls`);

    return {
      profiles: profiles.slice(0, config.limit),
      totalScraped: seen.size,
      totalAfterFilter: Math.min(profiles.length, config.limit),
      durationMs: Date.now() - start,
      errors,
    };
  }

  /**
   * Click a conversation that is CURRENTLY visible in the sidebar.
   * Uses evaluate to find and click the element directly in the DOM.
   */
  private async clickConversationInView(page: Page, targetName: string): Promise<boolean> {
    const clicked = await page.evaluate((name) => {
      const lowerName = name.toLowerCase().trim();
      const titleSpans = document.querySelectorAll('span[title]');
      for (const span of Array.from(titleSpans)) {
        const title = (span.getAttribute('title') || '').trim().toLowerCase();
        if (title === lowerName || title.includes(lowerName) || lowerName.includes(title)) {
          // Walk up to find clickable parent
          const btn = span.closest('[role="button"]') || span.closest('[role="listitem"]') || span.closest('div[tabindex]');
          if (btn) { (btn as HTMLElement).click(); return true; }
          // Walk up manually
          let el: HTMLElement | null = span as HTMLElement;
          for (let i = 0; i < 5 && el; i++) {
            el = el.parentElement;
            if (el && (el.getAttribute('role') === 'button' || el.hasAttribute('tabindex'))) {
              el.click(); return true;
            }
          }
          (span as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, targetName);

    if (clicked) return true;

    // Fallback: Playwright text locator
    try {
      const textEl = page.getByText(targetName, { exact: true }).first();
      if (await textEl.isVisible({ timeout: 1500 }).catch(() => false)) {
        await textEl.click();
        return true;
      }
    } catch {}

    return false;
  }

  /**
   * Extract messages from the currently open conversation thread.
   */
  private async extractMessages(page: Page): Promise<string> {
    return await page.evaluate(() => {
      const messages: string[] = [];
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
            const rect = row.getBoundingClientRect();
            const parentWidth = row.parentElement?.getBoundingClientRect().width || window.innerWidth * 0.6;
            const msgBubble = row.querySelector('div[dir="auto"], span[dir="auto"]');
            if (msgBubble) {
              const bubbleRect = msgBubble.getBoundingClientRect();
              const isLeftAligned = bubbleRect.left < (rect.left + parentWidth * 0.5);
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
          const time = timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent || '').trim() : '';

          if (body && body.length > 1 && !seenBodies.has(body)) {
            seenBodies.add(body);
            const prefix = sender || 'Unknown';
            const suffix = time ? ` [${time}]` : '';
            messages.push(`${prefix}: ${body}${suffix}`);
          }
        }
      }

      // Strategy 2: div[role="group"] blocks
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
            messages.push(`${sender}: ${text}`);
          }
        }
      }

      return messages.slice(-20).join('\n');
    });
  }

  /**
   * Scroll the sidebar to reveal more conversations.
   */
  private async scrollSidebar(page: Page): Promise<void> {
    const scrolled = await page.evaluate(() => {
      const firstConvo = document.querySelector('span[title]')?.closest('[role="button"]');
      if (!firstConvo) return false;

      let scrollContainer: HTMLElement | null = null;
      let parent: HTMLElement | null = firstConvo.parentElement;
      while (parent && parent !== document.body) {
        if (parent.scrollHeight > parent.clientHeight + 100) {
          const style = window.getComputedStyle(parent);
          const overflow = style.overflowY || style.overflow;
          if (overflow === 'auto' || overflow === 'scroll' || overflow === 'hidden') {
            scrollContainer = parent;
            break;
          }
        }
        parent = parent.parentElement;
      }

      if (!scrollContainer) {
        const allDivs = document.querySelectorAll('div');
        for (const div of Array.from(allDivs)) {
          const rect = div.getBoundingClientRect();
          if (rect.left > 400) continue;
          if (div.scrollHeight > div.clientHeight + 200 && div.clientHeight > 300) {
            if (div.querySelector('span[title]')) {
              scrollContainer = div as HTMLElement;
              break;
            }
          }
        }
      }

      if (scrollContainer) {
        scrollContainer.scrollBy({ top: 600, behavior: 'smooth' });
        return true;
      }
      return false;
    });

    if (!scrolled) {
      try {
        for (let k = 0; k < 3; k++) {
          await page.keyboard.press('PageDown');
          await page.waitForTimeout(300);
        }
      } catch {}
    }
  }

  /**
   * After going back to inbox, scroll down to skip past already-processed conversations.
   */
  private async scrollToPosition(page: Page, processedCount: number): Promise<void> {
    // Each conversation is ~70px tall. Scroll past the ones we've already processed.
    const scrollAmount = Math.max(0, (processedCount - 5) * 70);
    if (scrollAmount > 0) {
      await page.evaluate((amount) => {
        const firstConvo = document.querySelector('span[title]')?.closest('[role="button"]');
        if (!firstConvo) return;
        let parent: HTMLElement | null = firstConvo.parentElement;
        while (parent && parent !== document.body) {
          if (parent.scrollHeight > parent.clientHeight + 100) {
            parent.scrollTop = amount;
            return;
          }
          parent = parent.parentElement;
        }
      }, scrollAmount);
      await page.waitForTimeout(1500);
    }
  }

  /**
   * Extract the @username from the thread header when viewing a conversation.
   */
  private async extractUsernameFromThread(page: Page, displayName: string): Promise<string> {
    return page.evaluate((name) => {
      const profileOpeners = document.querySelectorAll('a[aria-label^="Open the profile page"]');
      for (const link of Array.from(profileOpeners)) {
        const label = link.getAttribute('aria-label') || '';
        const match = label.match(/Open the profile page of (.+)/i);
        if (match) return match[1].trim();
      }

      const headerTitle = document.querySelector('h2 span[title]');
      if (headerTitle) {
        const title = headerTitle.getAttribute('title') || '';
        if (title && title !== name) return title;
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
        const text = (link.textContent || '').trim();
        if (text.toLowerCase() === name.toLowerCase()) return match[1];
      }

      return '';
    }, displayName);
  }

  private async dismissNotificationPrompt(page: Page): Promise<void> {
    for (const text of ['Not Now', 'Not now', 'Cancel', 'Dismiss', 'Maybe Later', 'Block']) {
      try {
        const btn = page.locator(`button:has-text("${text}")`).first();
        if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await btn.click();
          await page.waitForTimeout(500);
        }
      } catch {}
    }
    try {
      const dialog = page.locator('[role="dialog"]').first();
      if (await dialog.isVisible({ timeout: 1000 }).catch(() => false)) {
        const notNow = dialog.locator('button:has-text("Not Now")');
        if (await notNow.isVisible({ timeout: 500 }).catch(() => false)) {
          await notNow.click();
          await page.waitForTimeout(500);
        }
      }
    } catch {}
  }
}
