import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { InstagramCommentsProvider } from './helpers/providers/instagram-comments-provider';
import { InstagramDmProvider } from './helpers/providers/instagram-dm-provider';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const kdm = require('./helpers/keyword-dm');

/**
 * Comment a keyword, get a DM (FL-CO-47, #190735).
 *
 * A creator posts "comment PIPELINE and I'll send it". This reads the post's commenters, keeps the
 * ones whose comment contains the keyword as a whole word, and DMs each of them the message.
 *
 * Runs only when a person invokes it (POST /api/instagram/keyword-dm, or by hand). No schedule.
 *
 * Env vars:
 *   POST_URL      — instagram.com /p/ or /reel/ URL (required)
 *   KEYWORD       — keyword(s), comma-separated, case-insensitive whole word (required)
 *   MESSAGE       — DM text; {handle} becomes the commenter's handle (required)
 *   IG_ACCOUNT    — account to send from (default heyiris.io); it is never messaged itself
 *   DRY_RUN       — ON unless exactly "0"/"false". A dry run lists who WOULD be messaged and opens
 *                   no DM thread (typing in a composer shows the person a typing indicator).
 *   MAX_SENDS     — default 10, hard ceiling 25
 *   LEDGER_FILE   — JSON ledger keyed by post (default ~/.iris/keyword-dm-ledger.json)
 *   BROWSER_SESSION_FILE — session JSON (default som/instagram-auth-<IG_ACCOUNT>.json)
 *   SEND_DELAY_MS — base gap between sends, jittered ±40% (default 45000, floor 10000)
 *   SCROLL_ATTEMPTS — comment-list scrolls (default 40)
 *   HEADLESS      — "1" to hide the browser (default: visible, so the person sees it working)
 *
 * Last stdout line: KEYWORD_DM_RESULT {json} — parsed by the daemon route.
 */

const POST_URL = (process.env.POST_URL || '').trim();
const KEYWORDS: string[] = kdm.parseKeywords(process.env.KEYWORD);
const MESSAGE = process.env.MESSAGE || '';
const IG_ACCOUNT = (process.env.IG_ACCOUNT || 'heyiris.io').replace(/^@/, '');
const DRY_RUN: boolean = kdm.isDryRun(process.env.DRY_RUN);
const MAX_SENDS: number = kdm.clampMax(process.env.MAX_SENDS);
const LEDGER_FILE = process.env.LEDGER_FILE || kdm.DEFAULT_LEDGER_FILE;
const SEND_DELAY_MS = Math.max(10000, parseInt(process.env.SEND_DELAY_MS || '45000', 10) || 45000);
const SCROLL_ATTEMPTS = Math.max(1, parseInt(process.env.SCROLL_ATTEMPTS || '40', 10) || 40);
const IG_AUTH_FILE = process.env.BROWSER_SESSION_FILE
  || path.join(__dirname, `instagram-auth-${IG_ACCOUNT}.json`);

test.use({ headless: process.env.HEADLESS === '1' });

type Summary = {
  ok: boolean;
  error?: string;
  postUrl: string;
  keywords: string[];
  account: string;
  dry: boolean;
  max: number;
  commenters: number;
  matched: number;
  targets: { handle: string; comment: string }[];
  skipped: { handle: string; comment: string; reason: string }[];
  results: any[];
  sent: number;
  failed: number;
  stoppedReason?: string;
  ledgerFile: string;
};

function finish(summary: Summary) {
  console.log('');
  console.log(`  ${summary.dry ? 'DRY RUN — nothing sent' : 'KEYWORD DM COMPLETE'}`);
  console.log(`  Matched: ${summary.matched}  |  Sent: ${summary.sent}  |  Skipped: ${summary.skipped.length}  |  Failed: ${summary.failed}`);
  if (summary.stoppedReason) console.log(`  Stopped: ${summary.stoppedReason}`);
  console.log(kdm.formatResultLine(summary));
}

test(`Instagram keyword DM — ${KEYWORDS.join(',')} on ${POST_URL}`, async ({ page, context }) => {
  const summary: Summary = {
    ok: false, postUrl: POST_URL, keywords: KEYWORDS, account: IG_ACCOUNT, dry: DRY_RUN, max: MAX_SENDS,
    commenters: 0, matched: 0, targets: [], skipped: [], results: [], sent: 0, failed: 0, ledgerFile: LEDGER_FILE,
  };

  if (!kdm.postKey(POST_URL)) { summary.error = 'POST_URL must be an instagram.com /p/ or /reel/ URL'; return finish(summary); }
  if (!KEYWORDS.length) { summary.error = 'KEYWORD is required'; return finish(summary); }
  if (!MESSAGE.trim()) { summary.error = 'MESSAGE is required'; return finish(summary); }

  // ── Session ──
  if (!fs.existsSync(IG_AUTH_FILE)) { summary.error = `no session file: ${IG_AUTH_FILE}`; return finish(summary); }
  const state = JSON.parse(fs.readFileSync(IG_AUTH_FILE, 'utf-8'));
  if (!state.cookies?.length) { summary.error = 'session file has no cookies'; return finish(summary); }
  await context.addCookies(state.cookies);
  console.log(`Session loaded for @${IG_ACCOUNT}${DRY_RUN ? '  [DRY RUN]' : ''}`);

  // ── Commenters ──
  const comments = new InstagramCommentsProvider();
  const discovered = await comments.discover(page, context, {
    targetUrl: POST_URL,
    limit: 2000,
    scrollAttempts: SCROLL_ATTEMPTS,
  });
  const url = page.url();
  if (url.includes('/accounts/login') || url.includes('/challenge/')) {
    summary.error = 'session expired';
    summary.stoppedReason = 'session expired — re-save the Instagram session';
    return finish(summary);
  }
  const commenters = discovered.profiles.map((p) => ({ username: p.username, commentText: String(p.rawMetadata?.commentText || '') }));
  summary.commenters = commenters.length;

  // ── Who qualifies ──
  const ledger = kdm.readLedger(LEDGER_FILE);
  const handled = kdm.handledHandles(ledger, POST_URL);
  const { targets, skipped } = kdm.selectTargets({ commenters, keywords: KEYWORDS, account: IG_ACCOUNT, handled, max: MAX_SENDS });
  summary.targets = targets.map((t: any) => ({ handle: t.handle, comment: t.comment }));
  summary.skipped = skipped;
  summary.matched = targets.length + skipped.length;
  console.log(`  ${commenters.length} commenters, ${summary.matched} said ${KEYWORDS.join('/')}, ${targets.length} to message, ${skipped.length} skipped`);
  for (const t of targets) console.log(`    ${DRY_RUN ? 'would DM' : 'DM'} @${t.handle}  — "${t.comment.slice(0, 60)}"`);
  for (const s of skipped) console.log(`    skip @${s.handle} (${s.reason})`);

  // ── Dry run: list only, write who would have been sent ──
  if (DRY_RUN) {
    const at = new Date().toISOString();
    summary.results = targets.map((t: any) => ({ handle: t.handle, comment: t.comment, status: 'dry', delivered: false, time: at, dry: true }));
    if (summary.results.length) kdm.writeLedger(LEDGER_FILE, kdm.appendLedger(ledger, POST_URL, summary.results));
    summary.ok = true;
    return finish(summary);
  }

  // ── Send ──
  const dm = new InstagramDmProvider();
  test.setTimeout(Math.max(600000, targets.length * (SEND_DELAY_MS * 1.4 + 60000) + 300000));
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (i > 0) {
      const gap = kdm.jitterDelay(SEND_DELAY_MS);
      console.log(`    waiting ${Math.round(gap / 1000)}s before the next DM...`);
      await page.waitForTimeout(gap);
    }
    let r: any;
    try {
      r = await dm.sendToHandle(page, t.handle, kdm.fillTemplate(MESSAGE, t.handle), { dryRun: false });
    } catch (err: any) {
      r = { handle: t.handle, status: 'failed', delivered: false, error: String(err?.message || err).slice(0, 200) };
    }
    const entry = { handle: t.handle, comment: t.comment, status: r.status, delivered: !!r.delivered, error: r.error, time: new Date().toISOString(), dry: false };
    summary.results.push(entry);
    // Write after every send so a crash mid-run never forgets who was already messaged.
    kdm.writeLedger(LEDGER_FILE, kdm.appendLedger(kdm.readLedger(LEDGER_FILE), POST_URL, [entry]));
    if (r.status === 'sent') summary.sent++; else summary.failed++;
    console.log(`    ${r.status === 'sent' ? 'SENT' : 'FAILED'} @${t.handle}${r.error ? ` — ${r.error}` : ''}`);
    if (kdm.isSessionStop(r)) {
      summary.stoppedReason = `${r.error} — stopped after ${i + 1} of ${targets.length}`;
      break;
    }
  }
  summary.ok = !summary.stoppedReason;
  if (summary.stoppedReason) summary.error = summary.stoppedReason;
  finish(summary);
});
