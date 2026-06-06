import { Page, BrowserContext } from '@playwright/test';

export interface DmTarget {
  name: string;
  profileUrl: string;
  message: string;
  leadId?: string | number;
}

export interface DmResult {
  name: string;
  profileUrl: string;
  status: 'sent' | 'failed' | 'skipped' | 'dry_run';
  error?: string;
  durationMs: number;
}

export interface DmBatchResult {
  results: DmResult[];
  sent: number;
  failed: number;
  skipped: number;
  dryRun: number;
  totalDurationMs: number;
}

export interface DmProviderOptions {
  dryRun?: boolean;
  delayBetweenDms?: number;
  cooldownAfter?: number;
  cooldownDuration?: number;
}

export interface DmProviderInterface {
  readonly platform: string;
  sendBatch(page: Page, context: BrowserContext, targets: DmTarget[]): Promise<DmBatchResult>;
}
