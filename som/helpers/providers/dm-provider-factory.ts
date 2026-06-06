import { DmProviderInterface, DmProviderOptions } from './dm-provider-types';
import { LinkedInDmProvider } from './linkedin-dm-provider';

export type DmPlatform = 'linkedin' | 'twitter';

const PLATFORM_DEFAULTS: Record<DmPlatform, Partial<DmProviderOptions>> = {
  linkedin: { delayBetweenDms: 5000, cooldownAfter: 8, cooldownDuration: 45000 },
  twitter:  { delayBetweenDms: 5000, cooldownAfter: 8, cooldownDuration: 45000 },
};

const DAILY_CAPS: Record<DmPlatform, number> = {
  linkedin: 25,
  twitter: 40,
};

export function getDmProvider(platform: DmPlatform, options?: DmProviderOptions): DmProviderInterface {
  const merged = { ...PLATFORM_DEFAULTS[platform], ...options };
  switch (platform) {
    case 'linkedin': return new LinkedInDmProvider(merged);
    default: throw new Error(`Unknown DM platform: ${platform}`);
  }
}

export function getDefaultDailyCap(platform: DmPlatform): number {
  return DAILY_CAPS[platform] ?? 25;
}
