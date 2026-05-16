import { Page, BrowserContext } from '@playwright/test';

// ── Types ──────────────────────────────────────────────────────────

export interface DiscoveredProfile {
  username: string;
  platform: string;           // "instagram" | "linkedin" | "youtube" | "tiktok"
  displayName?: string;
  profileUrl?: string;
  sourceContext?: string;      // "comment on <url>" | "follower of @X" | "direct profile scrape"
  rawMetadata?: Record<string, any>;
}

export interface DiscoveryConfig {
  targetUrl: string;          // Post URL, profile URL, or comma-separated usernames
  limit: number;              // Max NEW profiles to return (existing handles are skipped)
  scrollAttempts: number;     // How many scroll-to-load-more attempts
  scrollDelay?: number;       // ms between scroll attempts (default: 2000)
  filterFn?: (profile: DiscoveredProfile) => boolean;
  existingHandles?: Set<string>; // Handles already on the board — skip during scraping
}

export interface DiscoveryResult {
  profiles: DiscoveredProfile[];
  totalScraped: number;       // Unique usernames found before filtering
  totalAfterFilter: number;   // After filterFn applied
  durationMs: number;
  errors: string[];
}

// ── Qualification (post-discovery follower-count check) ────────────

export interface QualificationConfig {
  minFollowers?: number;
  maxFollowers?: number;
  verifiedOnly?: boolean;
  businessOnly?: boolean;
}

export interface QualifiedProfile extends DiscoveredProfile {
  followers?: number;
  following?: number;
  posts?: number;
  isVerified?: boolean;
  isBusiness?: boolean;
  bio?: string;
  externalUrl?: string;
  isPrivate?: boolean;
}

// ── Abstract Provider ──────────────────────────────────────────────

export abstract class BaseDiscoveryProvider {
  abstract readonly platform: string;
  abstract readonly discoveryType: string; // "comments" | "followers" | "profiles"

  /**
   * Discover profiles from the target.
   * The Page must already be authenticated for the platform.
   */
  abstract discover(
    page: Page,
    context: BrowserContext,
    config: DiscoveryConfig
  ): Promise<DiscoveryResult>;

  /** Unique key for deduplication. */
  dedupKey(profile: DiscoveredProfile): string {
    return `${profile.platform}:${profile.username.toLowerCase().replace(/^@/, '')}`;
  }
}

// ── Shared Helpers ─────────────────────────────────────────────────

/** Dismiss common IG popups ("Not Now", "Cancel", etc.) */
export async function dismissInstagramPopups(page: Page): Promise<void> {
  for (const text of ['Not Now', 'Not now', 'Cancel', 'Dismiss']) {
    try {
      const btn = page.locator(`button:has-text("${text}")`).first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(800);
      }
    } catch { /* ignore */ }
  }
}

/**
 * Scrape basic profile stats from an Instagram profile page.
 * Assumes the page is already navigated to the profile URL.
 */
export async function scrapeProfileStats(page: Page): Promise<{
  followers: number;
  following: number;
  posts: number;
  displayName: string;
  bio: string;
  isVerified: boolean;
  isPrivate: boolean;
  externalUrl: string;
  category: string;
}> {
  return page.evaluate(() => {
    const parseCount = (text: string): number => {
      if (!text) return 0;
      text = text.trim().toLowerCase().replace(/,/g, '');
      if (text.endsWith('k')) return Math.round(parseFloat(text) * 1000);
      if (text.endsWith('m')) return Math.round(parseFloat(text) * 1000000);
      return parseInt(text, 10) || 0;
    };

    // Stats from the header section (posts, followers, following)
    const statEls = document.querySelectorAll('header section ul li');
    let posts = 0, followers = 0, following = 0;
    statEls.forEach((el, i) => {
      const span = el.querySelector('span span') || el.querySelector('span');
      const count = span?.textContent || '0';
      if (i === 0) posts = parseCount(count);
      if (i === 1) followers = parseCount(count);
      if (i === 2) following = parseCount(count);
    });

    // Display name
    const nameEl = document.querySelector('header section span[dir]') ||
                   document.querySelector('header h2');
    const displayName = nameEl?.textContent?.trim() || '';

    // Bio
    const bioEl = document.querySelector('header section > div > span[dir]') ||
                  document.querySelector('header section div:not(:first-child) span');
    const bio = bioEl?.textContent?.trim() || '';

    // Verified badge
    const isVerified = !!document.querySelector('header svg[aria-label="Verified"]');

    // Private account
    const isPrivate = !!document.body.textContent?.includes('This account is private');

    // External URL
    const linkEl = document.querySelector('header a[rel="me nofollow noopener noreferrer"]') ||
                   document.querySelector('header a[href*="l.instagram.com"]');
    const externalUrl = linkEl?.textContent?.trim() || '';

    // Category (e.g. "Musician/Band", "Digital creator")
    const catEl = document.querySelector('header div[class*="category"]') ||
                  document.querySelector('header section > div > div > span:not([dir])');
    const category = catEl?.textContent?.trim() || '';

    return { followers, following, posts, displayName, bio, isVerified, isPrivate, externalUrl, category };
  });
}

/** Parse a follower count string like "10K", "1.2M", "45,231" → number */
export function parseFollowerCount(text: string): number {
  if (!text) return 0;
  text = text.trim().toLowerCase().replace(/,/g, '');
  if (text.endsWith('k')) return Math.round(parseFloat(text) * 1000);
  if (text.endsWith('m')) return Math.round(parseFloat(text) * 1000000);
  return parseInt(text, 10) || 0;
}
