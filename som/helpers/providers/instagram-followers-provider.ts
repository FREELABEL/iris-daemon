import { Page, BrowserContext } from '@playwright/test';
import {
  BaseDiscoveryProvider,
  DiscoveredProfile,
  DiscoveryConfig,
  DiscoveryResult,
  dismissInstagramPopups, keepDiscovered } from './base-provider';

export class InstagramFollowersProvider extends BaseDiscoveryProvider {
  readonly platform = 'instagram';
  readonly discoveryType = 'followers';

  async discover(
    page: Page,
    context: BrowserContext,
    config: DiscoveryConfig
  ): Promise<DiscoveryResult> {
    const errors: string[] = [];
    const start = Date.now();
    const seen = new Set<string>();
    const profiles: DiscoveredProfile[] = [];

    // Step 1: Navigate to profile
    console.log(`    Navigating to profile: ${config.targetUrl}`);
    await page.goto(config.targetUrl);
    await page.waitForTimeout(3000);
    await dismissInstagramPopups(page);

    // Step 2: Click "followers" link to open dialog
    const followersLink = page.locator('a[href*="/followers"]').first();
    if (!(await followersLink.isVisible({ timeout: 5000 }).catch(() => false))) {
      // Try alternate: click the text that says "N followers"
      const altFollowers = page.locator('header section ul li').nth(1).locator('a, button').first();
      if (await altFollowers.isVisible({ timeout: 3000 }).catch(() => false)) {
        await altFollowers.click();
      } else {
        errors.push('Followers link not found — account may be private');
        return { profiles, totalScraped: 0, totalAfterFilter: 0, durationMs: Date.now() - start, errors };
      }
    } else {
      await followersLink.click();
    }
    await page.waitForTimeout(3000);

    // Step 3: Wait for followers dialog
    const dialog = page.locator('div[role="dialog"]').first();
    if (!(await dialog.isVisible({ timeout: 5000 }).catch(() => false))) {
      errors.push('Followers dialog did not open');
      return { profiles, totalScraped: 0, totalAfterFilter: 0, durationMs: Date.now() - start, errors };
    }

    // Step 4: Scroll dialog and extract usernames
    let noNewCount = 0;
    for (let scroll = 0; scroll < config.scrollAttempts && profiles.length < config.limit; scroll++) {
      const prevSize = seen.size;

      const followers = await page.evaluate(() => {
        const dialog = document.querySelector('div[role="dialog"]');
        if (!dialog) return [];
        const links = dialog.querySelectorAll('a[href^="/"][role="link"], a[href^="/"]');
        const results: { username: string; displayName: string; isVerified: boolean }[] = [];
        const seenLocal = new Set<string>();

        links.forEach(el => {
          const href = el.getAttribute('href') || '';
          const match = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
          if (match && !['explore', 'accounts', 'reels', 'stories', 'direct'].includes(match[1])) {
            const username = match[1];
            if (seenLocal.has(username)) return;
            seenLocal.add(username);

            // Check for verified badge
            const li = el.closest('div[role="dialog"] > div > div > div > div') || el.closest('li') || el.parentElement;
            const verified = !!li?.querySelector('svg[aria-label="Verified"]');

            // Try to get display name from nearby span
            const nameSpan = li?.querySelector('span[dir]');
            const displayName = nameSpan?.textContent?.trim() || username;

            results.push({ username, displayName, isVerified: verified });
          }
        });
        return results;
      });

      for (const f of followers) {
        const key = f.username.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          const profile: DiscoveredProfile = {
            username: f.username,
            platform: 'instagram',
            displayName: f.displayName,
            profileUrl: `https://www.instagram.com/${f.username}/`,
            sourceContext: `follower of ${config.targetUrl}`,
            rawMetadata: { isVerified: f.isVerified },
          };
          if (keepDiscovered(profile, config)) {
            profiles.push(profile);
          }
        }
      }

      const newFound = seen.size - prevSize;
      console.log(`    Scroll ${scroll + 1}/${config.scrollAttempts}: ${seen.size} unique, ${profiles.length} kept` +
        (newFound === 0 ? ' (no new)' : ` (+${newFound})`));

      if (newFound === 0) {
        noNewCount++;
        if (noNewCount >= 3) {
          console.log(`    No new followers after 3 scrolls — stopping`);
          break;
        }
      } else {
        noNewCount = 0;
      }

      if (profiles.length >= config.limit) break;

      // Scroll the dialog down
      await page.evaluate(() => {
        const dialog = document.querySelector('div[role="dialog"]');
        if (!dialog) return;
        // Find the scrollable child div
        const scrollable = dialog.querySelector('div[style*="overflow"]') ||
                          dialog.querySelector('div[class*="scroll"]') ||
                          dialog.children[0]?.children[0] ||
                          dialog;
        if (scrollable && 'scrollTop' in scrollable) {
          (scrollable as HTMLElement).scrollTop = (scrollable as HTMLElement).scrollHeight;
        }
      });
      await page.waitForTimeout(2000);
    }

    // Close dialog
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    return {
      profiles: profiles.slice(0, config.limit),
      totalScraped: seen.size,
      totalAfterFilter: Math.min(profiles.length, config.limit),
      durationMs: Date.now() - start,
      errors,
    };
  }
}
