import { Page, BrowserContext } from '@playwright/test';
const igAccounts = require('../ig-accounts');
const igParse = require('./ig-profile-parse');

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
  ownedHandles?: Set<string>;    // Our own accounts (default: ig-accounts' ownedHandles()) — never returned (#191633)
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

/**
 * Whether a discovered profile may be returned: never one of our own Instagram accounts
 * (#191633 — they comment on, follow and message each other), then the caller's filterFn.
 * Every provider's push goes through this, so no discovery path can hand a self-lead onward.
 */
export function keepDiscovered(profile: DiscoveredProfile, config: Pick<DiscoveryConfig, 'filterFn' | 'ownedHandles'>): boolean {
  if (profile.platform === 'instagram' &&
      igAccounts.isOwnedHandle(profile.username, config.ownedHandles || igAccounts.ownedHandles())) {
    return false;
  }
  return !config.filterFn || config.filterFn(profile);
}

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
 * Profile stats for the Instagram profile the page is on (#193482).
 *
 * Reads, in order: Instagram's own profile JSON (same-origin, with the page's session), the
 * page's meta description, then the old header selectors. The selectors alone had been
 * returning zeros and the display name as the bio since at least 2026-05. A count that could
 * not be read is null — not 0. Write lead fields with leadFields() from ig-profile-parse, which
 * leaves unknowns out instead of overwriting them.
 */
export async function scrapeProfileStats(page: Page): Promise<IgProfileStats> {
  const username = usernameFromUrl(page.url());

  if (username) {
    const body = await page.evaluate(async (u: string) => {
      try {
        const r = await fetch(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`, {
          headers: { 'x-ig-app-id': '936619743392459' },
          credentials: 'include',
        });
        return r.ok ? await r.json() : null;
      } catch { return null; }
    }, username).catch(() => null);
    const fromApi = igParse.fromWebProfileInfo(body);
    if (fromApi) return fromApi;
  }

  const desc = await page.evaluate(() =>
    document.querySelector('meta[name="description"]')?.getAttribute('content') ||
    document.querySelector('meta[property="og:description"]')?.getAttribute('content') || ''
  ).catch(() => '');
  const meta = igParse.fromMetaDescription(desc);

  const dom = await page.evaluate(() => {
    const nameEl = document.querySelector('header section span[dir]') || document.querySelector('header h2');
    const bioEl = document.querySelector('header section > div > span[dir]') ||
                  document.querySelector('header section div:not(:first-child) span');
    const linkEl = document.querySelector('header a[rel="me nofollow noopener noreferrer"]') ||
                   document.querySelector('header a[href*="l.instagram.com"]');
    return {
      displayName: nameEl?.textContent?.trim() || '',
      bio: bioEl?.textContent?.trim() || '',
      isVerified: !!document.querySelector('header svg[aria-label="Verified"]'),
      isPrivate: !!document.body.textContent?.includes('This account is private'),
      externalUrl: linkEl?.textContent?.trim() || '',
    };
  }).catch(() => ({ displayName: '', bio: '', isVerified: false, isPrivate: false, externalUrl: '' }));

  const displayName = meta?.displayName || dom.displayName;
  return {
    source: meta ? 'meta' : 'dom',
    username: username || '',
    followers: meta?.followers ?? null,
    following: meta?.following ?? null,
    posts: meta?.posts ?? null,
    displayName,
    bio: igParse.realBio(meta?.bio || dom.bio, displayName),
    isVerified: dom.isVerified,
    isPrivate: dom.isPrivate,
    externalUrl: dom.externalUrl,
    category: '',
    city: null,
    isBusiness: false,
  };
}

export type IgProfileStats = {
  source: 'api' | 'meta' | 'dom';
  username: string;
  followers: number | null;
  following: number | null;
  posts: number | null;
  displayName: string;
  bio: string;
  isVerified: boolean;
  isPrivate: boolean;
  externalUrl: string;
  category: string;
  city: string | null;
  isBusiness: boolean;
};

/** "https://www.instagram.com/jo.doe/" → "jo.doe"; not a profile URL → null. */
export function usernameFromUrl(url: string): string | null {
  const m = String(url || '').match(/instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:[?#]|$)/);
  if (!m) return null;
  const reserved = ['p', 'reel', 'reels', 'explore', 'direct', 'accounts', 'stories', 'tv'];
  return reserved.includes(m[1].toLowerCase()) ? null : m[1];
}

/** Parse a follower count string like "10K", "1.2M", "45,231" → number */
export function parseFollowerCount(text: string): number {
  if (!text) return 0;
  text = text.trim().toLowerCase().replace(/,/g, '');
  if (text.endsWith('k')) return Math.round(parseFloat(text) * 1000);
  if (text.endsWith('m')) return Math.round(parseFloat(text) * 1000000);
  return parseInt(text, 10) || 0;
}
