/**
 * Send the DMs a person approved in `iris reachr post-run` (#192163), and nothing else.
 *
 *   POST_RUN_SEND=1 CONFIRM_COUNT=<n> APPROVED_FILE=approved.json IG_ACCOUNT=<account> BOARD_ID=<id> \
 *     POST_URL=<url> RUN_ID=<id> HEYIRIS_TOKEN=<token> npx playwright test post-run-send --retries=0
 *
 * approved.json: [{ "handle": "...", "leadId": 123, "message": "the exact text shown in the preview" }]
 *
 * Not batch-with-login.spec.ts: that one sends a strategy's step, so what goes out is not what a
 * person read, and it adds warm-up likes. This sends the file's text word for word through the same
 * provider, and shares the batch's daily cap file so both count toward one limit.
 *
 * Opening a thread can follow the person when Instagram requires it, as the batch does.
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { InstagramDmProvider } from './helpers/providers/instagram-dm-provider';
import { LeadgenApiClient } from './helpers/leadgen-api-client';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const prs = require('./helpers/post-run-send');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { readThreadText } = require('./helpers/delivery-check');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { undeliverableAccounts } = require('./helpers/dm-guard');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const kdm = require('./helpers/keyword-dm');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isOwnedHandle } = require('./helpers/ig-accounts');

const IG_ACCOUNT = (process.env.IG_ACCOUNT || '').replace(/^@/, '');
const BOARD_ID = Number(process.env.BOARD_ID || 0);
const POST_URL = process.env.POST_URL || '';
const RUN_ID = process.env.RUN_ID || '';
const LEDGER_FILE = process.env.POST_RUN_LEDGER || prs.DEFAULT_LEDGER_FILE;
const DAILY_CAP = parseInt(process.env.DAILY_DM_CAP || String(prs.DEFAULT_DAILY_CAP), 10);
const SEND_DELAY_MS = Math.max(10000, parseInt(process.env.SEND_DELAY_MS || '45000', 10) || 45000);
const AUTH_FILE = process.env.BROWSER_SESSION_FILE || path.join(__dirname, `instagram-auth-${IG_ACCOUNT}.json`);

test(`post-run send as @${IG_ACCOUNT}`, async ({ page, context }) => {
  if (process.env.POST_RUN_SEND !== '1') throw new Error('refusing to send: POST_RUN_SEND=1 is not set');
  const shortcode = kdm.postKey(POST_URL);
  if (!shortcode) throw new Error('POST_URL must be an instagram.com post or reel URL');
  if (!IG_ACCOUNT || !BOARD_ID || !RUN_ID) throw new Error('IG_ACCOUNT, BOARD_ID and RUN_ID are required');
  const items: { handle: string; leadId: number; message: string }[] = JSON.parse(fs.readFileSync(process.env.APPROVED_FILE!, 'utf8'));
  const invalid = prs.validateApproved(items, process.env.CONFIRM_COUNT);
  if (invalid) throw new Error(`refusing to send: ${invalid}`);

  test.setTimeout(items.length * (SEND_DELAY_MS * 1.4 + 90000) + 300000);
  const state = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  if (!state.cookies?.length) throw new Error('the session file has no cookies');
  await context.addCookies(state.cookies);

  const api = new LeadgenApiClient(process.env.HEYIRIS_TOKEN!, BOARD_ID);
  const dm = new InstagramDmProvider();
  const capFile = prs.capFile(__dirname, IG_ACCOUNT);
  const outcomes: string[] = [];
  let attempted = false;

  for (const it of items) {
    const handle = prs.normalizeHandle(it.handle);
    const log = (entry: Record<string, unknown>) => {
      prs.appendLedger(LEDGER_FILE, {
        run_id: RUN_ID, post_url: POST_URL, shortcode, account: IG_ACCOUNT, board_id: BOARD_ID,
        handle, lead_id: it.leadId, message: it.message, at: new Date().toISOString(), ...entry,
      });
    };

    // Checked per person, not once: another run can have used the cap or reached them since the preview.
    if (isOwnedHandle(handle) || handle === IG_ACCOUNT.toLowerCase()) continue;
    if (prs.blockedHandles(prs.readLedger(LEDGER_FILE)).has(handle)) continue;
    // Refused by Instagram from this account, by the batch or an earlier list: not again (#192164).
    const known = (await api.getLead(it.leadId).catch(() => null))?.data;
    const lead = known?.data || known;
    if (lead && undeliverableAccounts(lead, lead.notes || [])[IG_ACCOUNT.toLowerCase()]?.kind === 'refused') continue;
    if (prs.remainingToday(capFile, DAILY_CAP) <= 0) { console.log(`STOP daily cap reached (${DAILY_CAP})`); break; }

    if (attempted) await page.waitForTimeout(kdm.jitterDelay(SEND_DELAY_MS));
    attempted = true;

    let result: any;
    try {
      result = await dm.sendToHandle(page, handle, it.message, { dryRun: false });
    } catch (err: any) {
      result = { status: 'failed', delivered: false, error: String(err?.message || err).split('\n')[0].slice(0, 200) };
    }
    // The refusal is drawn a moment after the message appears (#192164).
    await page.waitForTimeout(2500);
    // Not the whole page: the thread list beside it previews other people's refusals (#192164).
    const pageText = await readThreadText(page);
    const { outcome, reason, stop } = prs.classifySend(result, { url: page.url(), pageText });

    if (prs.countsTowardCap(outcome)) prs.recordCapSend(capFile, it.leadId);
    let recorded = false;
    if (outcome === 'sent') {
      const rec = await api.recordDmSent(it.leadId, {
        message: it.message, channel_account: IG_ACCOUNT, campaign_name: `post-run:${shortcode}`,
        bloq_id: BOARD_ID, ig_handle: handle, step_index: 0,
      });
      recorded = !!rec.success;
    } else {
      const note = prs.noteFor(outcome, { account: IG_ACCOUNT, handle, reason });
      if (note) recorded = !!(await api.addNote(it.leadId, note)).success;
    }
    log({ outcome, reason, recorded });
    outcomes.push(outcome);
    console.log(`RESULT ${outcome}${reason ? `: ${reason}` : ''}`);

    if (stop) { console.log(`STOP ${reason}`); break; }
    if (prs.shouldStopAfterMisses(outcomes)) { console.log(`STOP ${prs.MAX_CONSECUTIVE_MISSES} in a row not delivered; check the account before sending more`); break; }
  }
});
