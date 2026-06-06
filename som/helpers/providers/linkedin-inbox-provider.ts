import { Page, BrowserContext } from '@playwright/test';
import {
  BaseDiscoveryProvider,
  DiscoveredProfile,
  DiscoveryConfig,
  DiscoveryResult,
} from './base-provider';

export class LinkedInInboxProvider extends BaseDiscoveryProvider {
  readonly platform = 'linkedin';
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

    console.log(`    Navigating to LinkedIn messaging...`);
    await page.goto('https://www.linkedin.com/messaging/');
    await page.waitForTimeout(5000);

    await this.dismissLinkedInPopups(page);
    await page.waitForTimeout(2000);

    let noNewCount = 0;
    const conversationNames: { name: string; lastMessage: string; timestamp: string; index: number }[] = [];

    for (let scroll = 0; scroll < config.scrollAttempts && conversationNames.length < config.limit; scroll++) {
      const prevSize = seen.size;

      const contacts = await page.evaluate(() => {
        const results: { name: string; lastMessage: string; timestamp: string }[] = [];
        const items = document.querySelectorAll('li.msg-conversation-listitem:not(.msg-conversation-card--occluded)');

        items.forEach(li => {
          let name = '';
          const nameSpan = li.querySelector('h3.msg-conversation-listitem__participant-names span.truncate');
          if (nameSpan) name = (nameSpan.textContent || '').trim();

          if (!name) {
            const img = li.querySelector('img.msg-facepile-grid__img');
            if (img) name = (img.getAttribute('alt') || '').trim();
          }

          if (!name) {
            const label = li.querySelector('label[aria-label^="Select conversation with"]');
            if (label) {
              name = (label.getAttribute('aria-label') || '').replace('Select conversation with ', '').trim();
            }
          }

          if (!name || name.length < 2) return;
          name = name.replace(/,\s*#\w+/g, '').trim();

          let lastMessage = '';
          const msgEl = li.querySelector('p[class*="msg-conversation-card__message-snippet"]');
          if (msgEl) {
            const pill = msgEl.querySelector('span[class*="msg-conversation-card__pill"]');
            const pillText = pill ? (pill.textContent || '').trim() : '';
            let fullText = (msgEl.textContent || '').trim();
            if (pillText && fullText.startsWith(pillText)) {
              fullText = fullText.slice(pillText.length).trim();
            }
            lastMessage = fullText.substring(0, 200);
          }

          let timestamp = '';
          const timeEl = li.querySelector('time.msg-conversation-listitem__time-stamp');
          if (timeEl) timestamp = (timeEl.textContent || '').trim();

          results.push({ name, lastMessage, timestamp });
        });

        return results;
      });

      for (const c of contacts) {
        const key = c.name.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          conversationNames.push({ ...c, index: conversationNames.length });
        }
      }

      const newFound = seen.size - prevSize;
      console.log(`    Scroll ${scroll + 1}: ${seen.size} unique contacts found` +
        (newFound === 0 ? ' (no new)' : ` (+${newFound})`));

      if (newFound === 0) {
        noNewCount++;
        if (noNewCount >= 3) break;
      } else {
        noNewCount = 0;
      }

      if (conversationNames.length >= config.limit) break;

      await page.evaluate(() => {
        const list = document.querySelector('ul.msg-conversations-container__conversations-list');
        if (list) list.scrollTop = list.scrollHeight;
      });
      await page.waitForTimeout(2000);

      const loadMore = page.locator('button:has-text("Load more conversations")').first();
      if (await loadMore.isVisible({ timeout: 1000 }).catch(() => false)) {
        console.log(`    Clicking "Load more conversations"...`);
        await loadMore.click().catch(() => {});
        await page.waitForTimeout(3000);
      }
    }

    const toProcess = conversationNames.slice(0, config.limit);
    console.log(`    Found ${conversationNames.length} conversations, processing ${toProcess.length}`);

    if (this.grabMessages && toProcess.length > 0) {
      console.log(`    Reading full message threads...`);
    }

    for (let i = 0; i < toProcess.length; i++) {
      const entry = toProcess[i];
      let fullMessages = '';

      if (this.grabMessages) {
        const clicked = await page.evaluate((targetName) => {
          const items = document.querySelectorAll('li.msg-conversation-listitem:not(.msg-conversation-card--occluded)');
          for (const li of items) {
            const nameSpan = li.querySelector('h3.msg-conversation-listitem__participant-names span.truncate');
            const name = nameSpan ? (nameSpan.textContent || '').trim() : '';
            if (name === targetName) {
              const clickTarget = li.querySelector('.msg-conversation-listitem__link') as HTMLElement;
              if (clickTarget) { clickTarget.click(); return true; }
            }
          }
          return false;
        }, entry.name);

        if (clicked) {
          await page.waitForTimeout(2000);

          fullMessages = await page.evaluate(() => {
            const messages: string[] = [];
            const seenBodies = new Set<string>();

            const msgEvents = document.querySelectorAll('.msg-s-event-listitem');

            if (msgEvents.length > 0) {
              msgEvents.forEach(ev => {
                if (ev.parentElement?.closest('.msg-s-event-listitem')) return;
                const senderEl = ev.querySelector('[class*="msg-s-message-group__name"]');
                const sender = senderEl ? (senderEl.textContent || '').trim() : '';
                const bodyEl = ev.querySelector('.msg-s-event-listitem__body') || ev.querySelector('[class*="msg-s-event__content"]');
                const body = bodyEl ? (bodyEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
                const timeEl = ev.querySelector('time');
                const time = timeEl ? (timeEl.textContent || '').trim() : '';

                if (body && body.length > 1 && !seenBodies.has(body)) {
                  seenBodies.add(body);
                  const prefix = sender ? `${sender}` : '';
                  const suffix = time ? ` [${time}]` : '';
                  messages.push(`${prefix}: ${body}${suffix}`);
                }
              });
            }

            if (messages.length === 0) {
              const threadPanel = document.querySelector(
                '[class*="msg-s-message-list-content"], [class*="msg-thread"], .scaffold-layout__detail'
              );
              if (threadPanel) {
                const textBlocks = threadPanel.querySelectorAll('p, span[dir="ltr"], [class*="message-body"]');
                textBlocks.forEach(block => {
                  const text = (block.textContent || '').replace(/\s+/g, ' ').trim();
                  if (text.length > 3 && !text.match(/^(Write a message|Type a message)/i) && !seenBodies.has(text)) {
                    seenBodies.add(text);
                    messages.push(text);
                  }
                });
              }
            }

            return messages.slice(-20).join('\n');
          });

          const msgCount = fullMessages ? fullMessages.split('\n').length : 0;
          const preview = fullMessages ? fullMessages.substring(0, 120).replace(/\n/g, ' | ') : '(empty)';
          console.log(`    [${i + 1}/${toProcess.length}] ${entry.name} — ${msgCount} messages read`);
          console.log(`      Preview: ${preview}${fullMessages.length > 120 ? '...' : ''}`);
        } else {
          console.log(`    [${i + 1}/${toProcess.length}] ${entry.name} — could not click conversation`);
        }

        if (i < toProcess.length - 1) {
          await page.waitForTimeout(1000 + Math.random() * 1000);
        }
      }

      const profile: DiscoveredProfile = {
        username: entry.name,
        platform: 'linkedin',
        displayName: entry.name,
        profileUrl: undefined,
        sourceContext: 'linkedin inbox',
        rawMetadata: {
          lastMessage: entry.lastMessage,
          timestamp: entry.timestamp,
          fullMessages: fullMessages || undefined,
        },
      };

      if (!config.filterFn || config.filterFn(profile)) {
        profiles.push(profile);
      }
    }

    return {
      profiles: profiles.slice(0, config.limit),
      totalScraped: seen.size,
      totalAfterFilter: Math.min(profiles.length, config.limit),
      durationMs: Date.now() - start,
      errors,
    };
  }

  private async dismissLinkedInPopups(page: Page): Promise<void> {
    for (const text of ['Dismiss', 'Not now', 'No thanks', 'Skip', 'Got it', 'Maybe later']) {
      const btn = page.locator(`button:has-text("${text}")`).first();
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(500);
      }
    }
  }
}
