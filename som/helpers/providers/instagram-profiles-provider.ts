import { Page, BrowserContext } from '@playwright/test';
import {
  BaseDiscoveryProvider,
  DiscoveredProfile,
  DiscoveryConfig,
  DiscoveryResult,
  dismissInstagramPopups,
  scrapeProfileStats,
} from './base-provider';

export class InstagramProfilesProvider extends BaseDiscoveryProvider {
  readonly platform = 'instagram';
  readonly discoveryType = 'profiles';

  async discover(
    page: Page,
    context: BrowserContext,
    config: DiscoveryConfig
  ): Promise<DiscoveryResult> {
    const errors: string[] = [];
    const start = Date.now();
    const profiles: DiscoveredProfile[] = [];

    // Parse targetUrl as comma-separated usernames or URLs
    const usernames = this.parseUsernames(config.targetUrl);

    if (usernames.length === 0) {
      errors.push('No usernames provided');
      return { profiles, totalScraped: 0, totalAfterFilter: 0, durationMs: Date.now() - start, errors };
    }

    console.log(`    Scraping ${usernames.length} profile(s)...`);
    const toProcess = usernames.slice(0, config.limit);

    for (let i = 0; i < toProcess.length; i++) {
      const username = toProcess[i];
      console.log(`    [${i + 1}/${toProcess.length}] @${username}`);

      try {
        const profileUrl = `https://www.instagram.com/${username}/`;
        await page.goto(profileUrl);
        await page.waitForTimeout(2500);

        if (i === 0) await dismissInstagramPopups(page);

        // Check if page loaded (not a 404 / "Sorry, this page isn't available")
        const notFound = await page.locator('h2').filter({ hasText: /Sorry|Page Not Found/i }).isVisible({ timeout: 2000 }).catch(() => false);
        if (notFound) {
          console.log(`      Not found — skipping`);
          errors.push(`@${username}: profile not found`);
          continue;
        }

        // Scrape profile stats
        const stats = await scrapeProfileStats(page);

        const profile: DiscoveredProfile = {
          username,
          platform: 'instagram',
          displayName: stats.displayName || username,
          profileUrl,
          sourceContext: 'direct profile scrape',
          rawMetadata: {
            followers: stats.followers,
            following: stats.following,
            posts: stats.posts,
            bio: stats.bio,
            isVerified: stats.isVerified,
            isPrivate: stats.isPrivate,
            externalUrl: stats.externalUrl,
            category: stats.category,
          },
        };

        const followerStr = this.formatCount(stats.followers);
        const status = stats.isPrivate ? '(private)' : `${followerStr} followers`;
        console.log(`      ${stats.displayName || username} — ${status}${stats.isVerified ? ' ✓' : ''}`);

        if (!config.filterFn || config.filterFn(profile)) {
          profiles.push(profile);
        } else {
          console.log(`      Filtered out by criteria`);
        }
      } catch (err: any) {
        errors.push(`@${username}: ${err.message?.substring(0, 80)}`);
        console.log(`      Error: ${err.message?.substring(0, 80)}`);
      }
    }

    return {
      profiles,
      totalScraped: toProcess.length,
      totalAfterFilter: profiles.length,
      durationMs: Date.now() - start,
      errors,
    };
  }

  /** Parse comma-separated usernames/URLs into clean username array. */
  private parseUsernames(input: string): string[] {
    return input
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map(s => {
        // Strip @ prefix
        if (s.startsWith('@')) return s.slice(1);
        // Extract username from URL
        const urlMatch = s.match(/instagram\.com\/([a-zA-Z0-9._]+)/);
        if (urlMatch) return urlMatch[1];
        // Assume it's already a username
        return s;
      })
      .filter(s => s.length > 0 && !['explore', 'accounts', 'p', 'reel'].includes(s));
  }

  private formatCount(n: number): string {
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }
}
