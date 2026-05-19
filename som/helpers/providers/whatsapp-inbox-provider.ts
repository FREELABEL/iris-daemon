import { Page, BrowserContext } from '@playwright/test';
import {
  BaseDiscoveryProvider,
  DiscoveredProfile,
  DiscoveryConfig,
  DiscoveryResult,
} from './base-provider';

/**
 * WhatsApp Inbox Provider — scrapes DM conversations from web.whatsapp.com
 *
 * ARCHITECTURE: Same split-view pattern as Instagram inbox provider.
 * WhatsApp Web shows sidebar (chat list) on left, conversation on right.
 * Click sidebar row -> messages load in right panel. No page navigation.
 *
 * SESSION: Uses persistent browser profile (launchPersistentContext) because
 * WhatsApp stores auth in IndexedDB, which storageState() doesn't capture.
 * Session dir: ~/.iris/whatsapp-sessions/{account}/
 */
export class WhatsAppInboxProvider extends BaseDiscoveryProvider {
  readonly platform = 'whatsapp';
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

    console.log(`    Navigating to WhatsApp Web...`);
    await page.goto('https://web.whatsapp.com/', { timeout: 30000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    // Wait for chat list to appear (session must be valid)
    const chatListReady = await page.locator('div[aria-label="Chat list"][role="grid"]')
      .isVisible({ timeout: 30000 }).catch(() => false);

    if (!chatListReady) {
      // Fallback: check for search bar
      const searchReady = await page.locator('div[contenteditable="true"][data-tab="3"]')
        .isVisible({ timeout: 5000 }).catch(() => false);
      if (!searchReady) {
        errors.push('Chat list not found — session may be expired (QR page?)');
        console.log(`    Chat list not found. Session expired or still loading.`);
        return { profiles: [], totalScraped: 0, totalAfterFilter: 0, durationMs: Date.now() - start, errors };
      }
    }

    console.log(`    WhatsApp Web loaded, scanning inbox...`);
    await this.dismissPopups(page);
    await page.waitForTimeout(1000);

    // Single-pass: scroll sidebar, click each NEW conversation, read messages, continue
    let noNewCount = 0;
    let totalScrolls = 0;

    for (let scroll = 0; scroll < config.scrollAttempts && profiles.length < config.limit; scroll++) {
      totalScrolls = scroll + 1;

      // Get all visible chat rows in sidebar
      const visibleContacts = await page.evaluate(() => {
        const results: { name: string; lastMessage: string; timestamp: string; isGroup: boolean; phoneNumber: string }[] = [];
        const seenNames = new Set<string>();

        // WhatsApp chat list uses role="grid" with role="row" children
        const rows = document.querySelectorAll('div[role="row"][data-testid^="list-item-"]');

        for (const row of Array.from(rows)) {
          // Contact name from cell-frame-title
          const titleContainer = row.querySelector('div[data-testid="cell-frame-title"]');
          const nameSpan = titleContainer?.querySelector('span[dir="auto"][title]');
          const name = nameSpan?.getAttribute('title')?.trim() || '';
          if (!name || name.length < 2 || seenNames.has(name)) continue;

          // Skip system channels and notification accounts
          if (['Instagram', 'Meta AI', 'WhatsApp', 'Archived'].includes(name)) continue;

          // Detect groups: SVG icon OR multiple-person avatar OR community sub-channels
          const hasGroupIcon = !!row.querySelector('svg[data-testid="default-group-refreshed"]') ||
                              !!row.querySelector('svg[data-testid="default-group"]');
          const hasGroupAvatar = !!row.querySelector('[data-testid="group-chat-profile-picture"]') ||
                                !!row.querySelector('span[data-testid="default-group"]');
          // Community channels often have " - " in names like "Saddle Pass - Texas..."
          // or "Developer Channel" as sub-channel names
          const isGroup = hasGroupIcon || hasGroupAvatar;

          // Detect phone number in contact name (unsaved contacts show as phone)
          const phonePattern = /^[+\d\s().-]{7,}$/;
          const phoneNumber = phonePattern.test(name.replace(/[^+\d\s().-]/g, '')) ? name.replace(/[^+\d]/g, '') : '';

          seenNames.add(name);

          // Last message preview
          let lastMessage = '';
          const lastMsgEl = row.querySelector('span[data-testid="last-msg-status"]');
          if (lastMsgEl) {
            lastMessage = lastMsgEl.getAttribute('title') || lastMsgEl.textContent?.trim() || '';
          }
          if (!lastMessage) {
            // Fallback: find the preview text span
            const secondaryContainer = row.querySelector('div[data-testid="cell-frame-secondary"]');
            if (secondaryContainer) {
              const spans = secondaryContainer.querySelectorAll('span[dir="auto"]');
              for (const s of Array.from(spans)) {
                const text = (s.textContent || '').trim();
                if (text.length > 5 && text.length < 500) { lastMessage = text; break; }
              }
            }
          }

          // Timestamp
          let timestamp = '';
          const timeContainer = row.querySelector('div[data-testid="cell-frame-primary-detail"]');
          if (timeContainer) {
            const timeSpan = timeContainer.querySelector('span');
            timestamp = timeSpan?.textContent?.trim() || '';
          }

          results.push({ name, lastMessage, timestamp, isGroup, phoneNumber });
        }
        return results;
      });

      // Find NEW contacts we haven't processed
      const newContacts = visibleContacts.filter(c => !seen.has(c.name.toLowerCase()));

      if (newContacts.length === 0) {
        noNewCount++;
        console.log(`    Scroll ${scroll + 1}: ${seen.size} total, no new visible`);
        if (noNewCount >= 5) break;
      } else {
        noNewCount = 0;
      }

      // Process each NEW conversation immediately
      for (const contact of newContacts) {
        if (profiles.length >= config.limit) break;

        const key = contact.name.toLowerCase();
        seen.add(key);

        // Skip groups unless explicitly opted in
        if (contact.isGroup && process.env.WA_INCLUDE_GROUPS !== '1') {
          console.log(`    [skip] ${contact.name} (group)`);
          continue;
        }

        let fullMessages = '';
        let phoneFromThread = contact.phoneNumber || '';

        if (this.grabMessages) {
          let clicked = await this.clickConversationInView(page, contact.name);
          if (!clicked) {
            await page.waitForTimeout(1500);
            clicked = await this.clickConversationInView(page, contact.name);
          }

          if (!clicked) {
            console.log(`    [${profiles.length + 1}/${config.limit}] ${contact.name} -- click failed`);
          } else {
            // Wait for conversation panel to load (key: must see compose box or messages)
            const panelLoaded = await page.locator('[data-testid="conversation-panel-messages"]')
              .isVisible({ timeout: 5000 }).catch(() => false);

            if (panelLoaded) {
              await page.waitForTimeout(1500);
              if (!phoneFromThread) phoneFromThread = await this.extractPhoneFromThread(page);
              fullMessages = await this.extractMessages(page);
            }
          }

          if (fullMessages || phoneFromThread) {
            const msgCount = fullMessages ? fullMessages.split('\n').length : 0;
            const preview = fullMessages ? fullMessages.substring(0, 100).replace(/\n/g, ' | ') : '(empty)';
            console.log(`    [${profiles.length + 1}/${config.limit}] ${contact.name}${phoneFromThread ? ` (${phoneFromThread})` : ''} -- ${msgCount} msgs`);
            if (preview !== '(empty)') console.log(`      "${preview}${fullMessages.length > 100 ? '...' : ''}"`);
          }

          // Anti-detection: longer delays than IG (WhatsApp is more sensitive)
          await page.waitForTimeout(2000 + Math.random() * 2000);
        }

        const profile: DiscoveredProfile = {
          username: contact.name,
          platform: 'whatsapp',
          displayName: contact.name,
          profileUrl: undefined,
          sourceContext: 'whatsapp inbox',
          rawMetadata: {
            lastMessage: contact.lastMessage,
            timestamp: contact.timestamp,
            fullMessages: fullMessages || undefined,
            phoneNumber: phoneFromThread || undefined,
            isGroup: contact.isGroup,
          },
        };

        if (!config.filterFn || config.filterFn(profile)) {
          profiles.push(profile);
        }
      }

      if (profiles.length >= config.limit) break;

      // Scroll sidebar for more chats
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
   * Click a conversation visible in the sidebar by matching the contact name.
   * IMPORTANT: Must use Playwright-native click (not evaluate click) because
   * WhatsApp Web requires proper event propagation to load the conversation panel.
   */
  private async clickConversationInView(page: Page, targetName: string): Promise<boolean> {
    // Strategy 1: Playwright locator on the title span (most reliable)
    try {
      const titleSpan = page.locator(`span[title="${targetName}"]`).first();
      if (await titleSpan.isVisible({ timeout: 2000 }).catch(() => false)) {
        await titleSpan.click();
        return true;
      }
    } catch {}

    // Strategy 2: Fuzzy text match via getByText
    try {
      const textEl = page.getByText(targetName, { exact: true }).first();
      if (await textEl.isVisible({ timeout: 1500 }).catch(() => false)) {
        await textEl.click();
        return true;
      }
    } catch {}

    // Strategy 3: Find the list-item row containing the name
    try {
      const row = page.locator('div[data-testid^="list-item-"]').filter({ hasText: targetName }).first();
      if (await row.isVisible({ timeout: 1500 }).catch(() => false)) {
        await row.click({ force: true });
        return true;
      }
    } catch {}

    return false;
  }

  /**
   * Extract messages from the currently open conversation (right panel).
   * Real DOM uses: data-testid="conv-msg-{ID}" for each message row,
   * .message-in / .message-out classes, data-testid="msg-container" for bubble.
   */
  private async extractMessages(page: Page): Promise<string> {
    // Wait for conversation panel to load
    await page.waitForSelector('[data-testid="conversation-panel-messages"]', { timeout: 5000 }).catch(() => null);

    return await page.evaluate(() => {
      const messages: string[] = [];
      const seenBodies = new Set<string>();

      // Strategy 1: Find individual message rows via data-testid="conv-msg-{ID}"
      const convMsgs = document.querySelectorAll('[data-testid^="conv-msg-"]');

      if (convMsgs.length > 0) {
        for (const msg of Array.from(convMsgs)) {
          // Determine direction: check for .message-in or .message-out in the subtree
          let sender = 'them';
          const msgIn = msg.querySelector('.message-in');
          const msgOut = msg.querySelector('.message-out');
          if (msgOut) {
            sender = 'me';
          } else if (!msgIn) {
            // Check the element itself and parents
            let el: Element | null = msg;
            for (let i = 0; i < 5 && el; i++) {
              const cls = el.className || '';
              if (cls.includes('message-out')) { sender = 'me'; break; }
              if (cls.includes('message-in')) { sender = 'them'; break; }
              el = el.parentElement;
            }
          }

          // Extract text from msg-container or selectable-text
          const container = msg.querySelector('[data-testid="msg-container"]') || msg;
          const textEl = container.querySelector('span.selectable-text') ||
                        container.querySelector('span[dir="ltr"]') ||
                        container.querySelector('span[dir="auto"]');

          let body = '';
          if (textEl) {
            // Get all text content including nested spans
            body = textEl.textContent?.trim() || '';
          }

          // Fallback: get innerText from container, filter out metadata
          if (!body) {
            const innerText = (container as HTMLElement).innerText || '';
            const lines = innerText.split('\n').filter(l => l.trim().length > 1);
            // Skip time-only lines and status lines
            body = lines.find(l => !l.match(/^\d{1,2}:\d{2}/) && !l.match(/^(Forwarded|Starred)/i)) || '';
            body = body.trim();
          }

          if (!body || body.length < 2) continue;
          if (/^(Tap to learn more|Messages.*end-to-end|This message was deleted|Waiting for this message)/i.test(body)) continue;

          if (seenBodies.has(body)) continue;
          seenBodies.add(body);

          // Timestamp
          const timeEl = container.querySelector('[data-testid="msg-meta"] span') ||
                        container.querySelector('span[data-testid="msg-time"]');
          const time = timeEl?.textContent?.trim() || '';
          const suffix = time ? ` [${time}]` : '';

          messages.push(`${sender}: ${body}${suffix}`);
        }
      }

      // Strategy 2: Fall back to .message-in / .message-out globally
      if (messages.length === 0) {
        const allMsgs = document.querySelectorAll('.message-in, .message-out');
        for (const msg of Array.from(allMsgs)) {
          const cls = msg.className || '';
          const sender = cls.includes('message-out') ? 'me' : 'them';

          const textEl = msg.querySelector('span.selectable-text') ||
                        msg.querySelector('span[dir="ltr"]') ||
                        msg.querySelector('span[dir="auto"]');
          const body = textEl?.textContent?.trim() || '';

          if (!body || body.length < 2 || seenBodies.has(body)) continue;
          seenBodies.add(body);
          messages.push(`${sender}: ${body}`);
        }
      }

      return messages.slice(-20).join('\n');
    });
  }

  /**
   * Scroll the WhatsApp sidebar (#pane-side) to reveal more conversations.
   */
  private async scrollSidebar(page: Page): Promise<void> {
    const scrolled = await page.evaluate(() => {
      // WhatsApp sidebar container is #pane-side
      const paneSide = document.getElementById('pane-side');
      if (paneSide) {
        paneSide.scrollBy({ top: 600, behavior: 'smooth' });
        return true;
      }

      // Fallback: find scrollable container with chat rows
      const chatList = document.querySelector('div[aria-label="Chat list"][role="grid"]');
      if (chatList) {
        let parent: Element | null = chatList.parentElement;
        while (parent && parent !== document.body) {
          const el = parent as HTMLElement;
          if (el.scrollHeight > el.clientHeight + 100) {
            el.scrollBy({ top: 600, behavior: 'smooth' });
            return true;
          }
          parent = parent.parentElement;
        }
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
   * Extract phone number from the conversation header (right panel).
   * WhatsApp shows the phone in the header for unsaved contacts.
   * Uses data-testid="conversation-header" or "conversation-info-header".
   */
  private async extractPhoneFromThread(page: Page): Promise<string> {
    return page.evaluate(() => {
      // Look specifically in the conversation header (right panel)
      const convHeader = document.querySelector('[data-testid="conversation-header"]') ||
                         document.querySelector('[data-testid="conversation-info-header"]');
      if (!convHeader) return '';

      // Check the title span in the header
      const titleSpan = convHeader.querySelector('[data-testid="conversation-info-header-chat-title"] span[dir="auto"]') ||
                        convHeader.querySelector('span[dir="auto"][title]');
      if (titleSpan) {
        const title = titleSpan.getAttribute('title') || titleSpan.textContent || '';
        const digits = title.replace(/[^+\d]/g, '');
        if (digits.length >= 7) return digits;
      }

      // Check all spans in the header for phone-like text
      const spans = convHeader.querySelectorAll('span[dir="auto"], span[title]');
      for (const span of Array.from(spans)) {
        const text = (span.getAttribute('title') || span.textContent || '').trim();
        const digits = text.replace(/[^+\d]/g, '');
        if (digits.length >= 7 && digits.length <= 15 && /[+\d(]/.test(text.charAt(0))) {
          return digits;
        }
      }

      return '';
    });
  }

  /**
   * Dismiss WhatsApp-specific banners and popups.
   */
  private async dismissPopups(page: Page): Promise<void> {
    for (const text of ['OK', 'Continue', 'Dismiss', 'Got it', 'Not Now']) {
      try {
        const btn = page.locator(`button:has-text("${text}")`).first();
        if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await btn.click();
          await page.waitForTimeout(500);
        }
      } catch {}
    }
    // Dismiss "Use WhatsApp on your phone" or "Computer not connected" banners
    try {
      const banner = page.locator('[data-testid="banner-dismiss"]').first();
      if (await banner.isVisible({ timeout: 1000 }).catch(() => false)) {
        await banner.click();
        await page.waitForTimeout(500);
      }
    } catch {}
  }
}
