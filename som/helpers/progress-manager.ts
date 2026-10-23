/**
 * Progress Manager — Crash Recovery + Stats for Leadgen Scraper
 *
 * Writes a JSON progress file to disk after every meaningful event.
 * Supports resuming interrupted runs via RESUME=1 env var.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DiscoveredProfile } from './providers/base-provider';

export interface ProgressConfig {
  targetUrl: string;
  boardId: number;
  limit: number;
  discoveryMode: string;
}

export interface CreationResult {
  username: string;
  status: 'created' | 'duplicate' | 'error';
  leadId?: number;
  error?: string;
}

interface ProgressState {
  sessionId: string;
  startedAt: string;
  lastUpdatedAt: string;
  config: ProgressConfig;
  phase: 'scraping' | 'creating' | 'complete';
  profiles: Array<{
    username: string;
    displayName?: string;
    commentText?: string;
    timestamp?: string;
    profileUrl?: string;
    sourceContext?: string;
  }>;
  creation: {
    lastProcessedIndex: number;
    results: CreationResult[];
  };
}

export class ProgressManager {
  readonly filePath: string;
  private state: ProgressState;

  private constructor(filePath: string, state: ProgressState) {
    this.filePath = filePath;
    this.state = state;
  }

  /** Create a new session or load an existing resumable one. */
  static loadOrCreate(outputDir: string, config: ProgressConfig): ProgressManager {
    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });

    // Check for resumable session
    const resumable = ProgressManager.findResumable(outputDir, config);
    if (resumable) return resumable;

    // Create new session
    const hash = ProgressManager.configHash(config);
    const sessionId = `${hash}-${Date.now()}`;
    const filePath = path.join(outputDir, `leadgen-progress-${sessionId}.json`);

    const state: ProgressState = {
      sessionId,
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      config,
      phase: 'scraping',
      profiles: [],
      creation: {
        lastProcessedIndex: -1,
        results: [],
      },
    };

    const mgr = new ProgressManager(filePath, state);
    mgr.save();
    return mgr;
  }

  /** Find a previous incomplete session matching the same config. */
  static findResumable(outputDir: string, config: ProgressConfig): ProgressManager | null {
    if (process.env.RESUME !== '1') return null;
    if (!fs.existsSync(outputDir)) return null;

    const hash = ProgressManager.configHash(config);
    const files = fs.readdirSync(outputDir)
      .filter(f => f.startsWith(`leadgen-progress-${hash}-`) && f.endsWith('.json'))
      .sort()
      .reverse(); // Most recent first

    for (const file of files) {
      try {
        const filePath = path.join(outputDir, file);
        const raw = fs.readFileSync(filePath, 'utf-8');
        const state = JSON.parse(raw) as ProgressState;

        if (state.phase !== 'complete') {
          console.log(`  Resuming session ${state.sessionId} (${state.profiles.length} profiles, ${state.creation.results.length} created)`);
          return new ProgressManager(filePath, state);
        }
      } catch { /* skip corrupt files */ }
    }

    return null;
  }

  setPhase(phase: ProgressState['phase']): void {
    this.state.phase = phase;
    this.save();
  }

  addDiscoveredProfiles(profiles: DiscoveredProfile[]): void {
    this.state.profiles = profiles.map(p => ({
      username: p.username,
      displayName: p.displayName,
      commentText: p.rawMetadata?.commentText,
      timestamp: p.rawMetadata?.timestamp,
      profileUrl: p.profileUrl,
      sourceContext: p.sourceContext,
    }));
    this.save();
  }

  recordCreationResult(result: CreationResult): void {
    this.state.creation.results.push(result);
    this.state.creation.lastProcessedIndex = this.state.creation.results.length - 1;
    this.save();
  }

  /** Get profiles from a resumed session (skip re-scraping). */
  getResumedProfiles(): DiscoveredProfile[] | null {
    if (this.state.profiles.length === 0) return null;
    return this.state.profiles.map(p => ({
      username: p.username,
      platform: 'instagram',
      displayName: p.displayName,
      profileUrl: p.profileUrl,
      sourceContext: p.sourceContext,
      rawMetadata: {
        commentText: p.commentText || '',
        timestamp: p.timestamp || '',
      },
    }));
  }

  /** Get set of usernames already processed in a resumed session. */
  getAlreadyProcessed(): Set<string> {
    return new Set(
      this.state.creation.results.map(r => r.username.toLowerCase().replace(/^@/, ''))
    );
  }

  isResumed(): boolean {
    return this.state.creation.results.length > 0 || this.state.profiles.length > 0;
  }

  private save(): void {
    this.state.lastUpdatedAt = new Date().toISOString();
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  private static configHash(config: ProgressConfig): string {
    const str = `${config.targetUrl}-${config.boardId}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }
}
