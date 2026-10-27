/**
 * Standalone reply capture — read every DM thread, write replies to the CRM, send nothing.
 *
 * Why this exists (#191269): reply capture used to run only as a PRE-FLIGHT inside a DM send
 * batch, against the newest 20 threads. Pausing campaigns therefore silenced reply capture
 * entirely, and on a busy day anything past thread 20 was never seen.
 *
 * This job is independent of sending. It runs on its own schedule, over every configured
 * account, and reads as far back as the provider can scroll.
 *
 * Config — either:
 *   CAPTURE_ACCOUNTS="heyiris.io:38,thediscoverpage_:80"   (account:boardId — a BOARD id, not an integration id)
 * or the single-account fallback:
 *   IG_ACCOUNT=heyiris.io BOARD_ID=38
 *
 * Optional:
 *   CAPTURE_LIMIT=500        max conversations per account (default 500)
 *   CAPTURE_SCROLLS=60       scroll attempts per account (default 60)
 *   DRY_RUN=1                match and report, write nothing
 *   BROWSER_SESSION_FILE     override the session file for the single-account fallback
 *
 * Example:
 *   npx playwright test capture-replies.spec.ts
 */
import { test, Browser, BrowserContext } from '@playwright/test';
import { InstagramInboxJsonProvider, InstagramIdentityError } from './helpers/providers/instagram-inbox-json-provider';
import { syncInbox, sendDiscordAlert } from './helpers/inbox-scanner';
import * as fs from 'fs';
import * as path from 'path';

const TOKEN = process.env.HEYIRIS_TOKEN;
if (!TOKEN) throw new Error('HEYIRIS_TOKEN env var required. Set in ~/.iris/bridge/.env or export it.');

const API_BASE = process.env.IRIS_FL_API_URL || 'https://raichu.heyiris.io';
const CAPTURE_LIMIT = parseInt(process.env.CAPTURE_LIMIT || '500', 10);
const CAPTURE_SCROLLS = parseInt(process.env.CAPTURE_SCROLLS || '60', 10);
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const DISCORD_WEBHOOK = process.env.PLATFORM_UPDATES_DISCORD_CHANNEL_WEBHOOK_URL || '';
// One JSON line per account per live run: what reply-digest.js summarises for the daily email.
// Kept outside any checkout: it holds real people's messages and must never be committed.
const CAPTURE_LOG = process.env.CAPTURE_LOG || path.join(require('os').homedir(), '.iris', 'data', 'reply-capture.jsonl');

function appendCaptureLog(entry: Record<string, any>): void {
  try {
    fs.mkdirSync(path.dirname(CAPTURE_LOG), { recursive: true });
    fs.appendFileSync(CAPTURE_LOG, JSON.stringify(entry) + '\n');
  } catch (err: any) {
    console.log(`  capture log not written (${CAPTURE_LOG}): ${err.message}`);
  }
}

interface CaptureAccount { account: string; boardId: number }

function accounts(): CaptureAccount[] {
  const raw = (process.env.CAPTURE_ACCOUNTS || '').trim();
  if (raw) {
    return raw.split(',')
      .map(pair => pair.trim())
      .filter(Boolean)
      .map(pair => {
        const [account, board] = pair.split(':');
        const boardId = parseInt(board, 10);
        if (!account || !Number.isFinite(boardId)) {
          throw new Error(`CAPTURE_ACCOUNTS entry "${pair}" is not account:boardId`);
        }
        return { account: account.replace(/^@/, ''), boardId };
      });
  }

  return [{
    account: process.env.IG_ACCOUNT || 'heyiris.io',
    boardId: parseInt(process.env.BOARD_ID || '38', 10),
  }];
}

/** Session files live next to this spec, or at the repo root on legacy installs. */
function sessionFile(account: string): string | null {
  const candidates = [
    process.env.BROWSER_SESSION_FILE,
    path.join(__dirname, `instagram-auth-${account}.json`),
    path.join(__dirname, '../../..', `instagram-auth-${account}.json`),
    path.join(__dirname, 'instagram-auth.json'),
  ].filter(Boolean) as string[];

  return candidates.find(p => fs.existsSync(p)) || null;
}

async function captureAccount(
  browser: Browser,
  { account, boardId }: CaptureAccount,
  failures: string[],
  summary: Record<string, any>[],
): Promise<void> {
  const label = `@${account} / Board ${boardId}`;
  console.log(`\n${'='.repeat(60)}\n  CAPTURE ${label}\n${'='.repeat(60)}`);

  const file = sessionFile(account);
  if (!file) {
    console.log(`  SKIP: no Instagram session file for @${account}`);
    await sendDiscordAlert(DISCORD_WEBHOOK, `**IG Reply Capture — no session** @${account} (board ${boardId})`);
    failures.push(`@${account}: no session file`);
    return;
  }

  const state = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (!state.cookies || state.cookies.length === 0) {
    console.log(`  SKIP: session file has no cookies (${file})`);
    failures.push(`@${account}: session file has no cookies`);
    return;
  }

  let context: BrowserContext | null = null;
  try {
    context = await browser.newContext();
    await context.addCookies(state.cookies);
    const page = await context.newPage();

    // Reads the inbox from the data Instagram's own page loads: exact usernames, exact sender,
    // and it refuses a session that is logged in as a different account (#191277, #191279).
    const provider = new InstagramInboxJsonProvider(account);
    const inbox = await provider.discover(page, context, {
      targetUrl: 'https://www.instagram.com/direct/inbox/',
      limit: CAPTURE_LIMIT,
      scrollAttempts: CAPTURE_SCROLLS,
      scrollDelay: 1500,
    });
    console.log(`  Read ${inbox.profiles.length} conversations`);
    if (inbox.errors.length > 0) console.log(`  Provider errors: ${inbox.errors.join(', ')}`);
    if (inbox.profiles.length === 0) {
      // A logged-in inbox with zero threads is almost never true; reading nothing must not
      // look like a quiet day (#190636).
      throw new Error(`read 0 conversations for @${account} — treating as a failed capture, not "no replies"`);
    }

    // One write path: every conversation goes to inbox-sync, which matches the WHOLE board by
    // exact handle on the server, stores both sides of the thread (deduped per message), sets
    // has_replied, and — with create_missing — makes a lead for someone we did not have yet
    // (#191269 #191270 #191271 #191278). No client-side lead list, no second "replied" note.
    const withReplies = inbox.profiles.filter(p => p.rawMetadata?.hasTheirMessage === true);
    console.log(`  ${withReplies.length} of ${inbox.profiles.length} threads contain a message from them; ` +
      `${inbox.profiles.filter(p => p.rawMetadata?.lastFromThem).length} are waiting on us`);
    if (DRY_RUN) {
      for (const p of withReplies.slice(0, 25)) {
        console.log(`    @${p.username}${p.rawMetadata?.lastFromThem ? '  [waiting on us]' : ''}  "${String(p.rawMetadata?.lastMessage || '').slice(0, 70)}"`);
      }
      console.log(`  [DRY RUN] would send ${withReplies.length} conversations to inbox-sync (create_missing)`);
      const out = path.join(__dirname, '../test-results', `capture-${account}.json`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(inbox.profiles, null, 1));
      console.log(`  [DRY RUN] parsed threads written to ${out}`);
      return;
    }
    const stats = await syncInbox(API_BASE, TOKEN, boardId, 'instagram', account, withReplies, '', { createMissing: true });
    if (stats === null) throw new Error(`inbox-sync rejected the capture for @${account}`);
    summary.push({ account, boardId, read: inbox.profiles.length, withReplies: withReplies.length, ...stats });
    appendCaptureLog({
      at: new Date().toISOString(), account, boardId,
      read: inbox.profiles.length, withReplies: withReplies.length,
      stats: { matched: stats.matched ?? 0, created: stats.created ?? 0, new_messages: stats.new_messages ?? 0, unmatched: stats.unmatched ?? 0, failed: stats.failed ?? 0 },
      createdLeads: (stats as any).created_leads ?? [],
      threads: withReplies.map(p => ({
        handle: p.username,
        name: p.displayName && p.displayName !== p.username ? p.displayName : '',
        waitingOnUs: p.rawMetadata?.lastFromThem === true,
        lastActivityAt: p.rawMetadata?.lastActivityAt ?? null,
        // last few lines of the thread, oldest first, "me:" = us — what the digest drafts from
        recent: String(p.rawMetadata?.fullMessages || '').split('\n').slice(-6),
      })),
    });
  } catch (err: any) {
    const kind = err instanceof InstagramIdentityError ? 'wrong or expired session' : 'failed';
    console.log(`  CAPTURE FAILED (${kind}) for ${label}: ${err.message}`);
    await sendDiscordAlert(DISCORD_WEBHOOK, `**IG Reply Capture — ${kind}** ${label}\n${err.message}`);
    failures.push(`${label}: ${err.message}`);
  } finally {
    await context?.close().catch(() => {});
  }
}

test('Capture Instagram replies — every account, read-only', async ({ browser }) => {
  const list = accounts();
  // Reading hundreds of threads is slow by design — do not let the 10-minute default
  // kill a legitimate scan and turn it into a silent "0 replies".
  test.setTimeout(Math.max(600_000, list.length * 1_800_000));
  console.log(`Capturing replies for ${list.length} account(s), limit ${CAPTURE_LIMIT} threads each`);

  const failures: string[] = [];
  const summary: Record<string, any>[] = [];
  for (const entry of list) {
    await captureAccount(browser, entry, failures, summary);
  }
  console.log(`\nCAPTURE SUMMARY ${JSON.stringify(summary)}`);
  // One account failing must not hide behind the others passing.
  if (failures.length > 0) {
    throw new Error(`reply capture failed for ${failures.length} of ${list.length} account(s):\n  ` + failures.join('\n  '));
  }
});
