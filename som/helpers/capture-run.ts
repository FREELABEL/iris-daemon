/**
 * The browser-free half of capture-replies.spec.ts: which session file an account reads, and
 * how a run over several accounts survives one of them failing.
 *
 * #191634: a logged-out @thediscoverpage_ threw out of the per-account catch (the Discord alert
 * itself crashed with no webhook), which failed the whole test, so the accounts after it were
 * never read. Here every account runs in its own try/catch and the run always ends with a
 * per-account summary: ok / logged out / error.
 *
 * Unit-tested in tests/capture-run.unit.spec.ts — no browser, no network.
 */
import * as fs from 'fs';
import * as path from 'path';
import { InstagramIdentityError } from './providers/instagram-inbox-json-provider';
const igAccounts = require('./ig-accounts');

export type CaptureStatus = 'ok' | 'logged out' | 'error';

export interface CaptureRow {
  account: string;
  boardId: number;
  status: CaptureStatus;
  detail: string;
}

/** A session that is missing, has no cookies, or is not logged in as the account. */
export class SessionUnusableError extends Error {}

export function classifyCaptureError(err: any): CaptureStatus {
  if (err instanceof InstagramIdentityError || err instanceof SessionUnusableError) return 'logged out';
  return 'error';
}

/**
 * Run captureOne for every account. Nothing one account does — a throw, a rejected alert — stops
 * the next. onFailure (the alert) is itself guarded.
 */
export async function runCaptureAccounts<T extends { account: string; boardId: number }>(
  list: T[],
  captureOne: (entry: T) => Promise<string | void>,
  onFailure?: (entry: T, row: CaptureRow) => Promise<void> | void,
): Promise<CaptureRow[]> {
  const rows: CaptureRow[] = [];
  for (const entry of list) {
    let row: CaptureRow;
    try {
      const detail = await captureOne(entry);
      row = { account: entry.account, boardId: entry.boardId, status: 'ok', detail: detail || '' };
    } catch (err: any) {
      row = {
        account: entry.account, boardId: entry.boardId,
        status: classifyCaptureError(err), detail: String(err?.message || err),
      };
      if (onFailure) {
        try { await onFailure(entry, row); } catch (alertErr: any) {
          console.log(`  failure alert for @${entry.account} not sent: ${alertErr?.message || alertErr}`);
        }
      }
    }
    rows.push(row);
  }
  return rows;
}

export function formatCaptureSummary(rows: CaptureRow[]): string {
  const width = Math.max(8, ...rows.map(r => r.account.length + 1));
  const lines = rows.map(r =>
    `  ${('@' + r.account).padEnd(width)}  board ${String(r.boardId).padEnd(5)}  ${r.status.padEnd(10)}  ${r.detail}`.trimEnd());
  const n = (s: CaptureStatus) => rows.filter(r => r.status === s).length;
  return `CAPTURE RESULT — ${n('ok')} ok, ${n('logged out')} logged out, ${n('error')} error\n${lines.join('\n')}`;
}

/**
 * The session file for an account. Only instagram-auth-<account>.json counts when several
 * accounts are read: an override (BROWSER_SESSION_FILE) or the legacy instagram-auth.json is
 * one login, and handing it to every account is how one account reads as another.
 */
export function resolveSessionFile(
  account: string,
  opts: { dirs: string[]; override?: string; singleAccount: boolean; legacyFile?: string },
): string | null {
  const own = opts.dirs.map(d => path.join(d, `instagram-auth-${account}.json`));
  const candidates = opts.singleAccount
    ? [opts.override, ...own, opts.legacyFile].filter(Boolean) as string[]
    : own;
  return candidates.find(p => fs.existsSync(p)) || null;
}

/**
 * Before a session is used: refuse it when another account's auth file holds the same login
 * (#191635). Throws an Error naming both files.
 */
export function assertSessionIsDistinct(sessionFile: string, account: string): void {
  igAccounts.assertDistinctAuthFile(path.dirname(sessionFile), account);
}
