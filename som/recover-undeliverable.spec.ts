/**
 * Reclassify leads already burned by the "can't receive your message" banner (#192164).
 * Run through recover-undeliverable.sh. RECOVER_APPLY=1 writes; anything else only reports.
 *
 * Reads through the same provider as capture-replies: the inbox's own data, never opens a thread.
 * Output is counts only. Refuses while a batch holds the lock, so one account never has two browsers.
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { InstagramInboxJsonProvider } from './helpers/providers/instagram-inbox-json-provider';
import { LeadgenApiClient } from './helpers/leadgen-api-client';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const recover = require('./helpers/recover-undeliverable');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TAG } = require('./helpers/dm-guard');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { lockVerdict } = require('./som-lock');

const TOKEN = process.env.HEYIRIS_TOKEN!;
const APPLY = process.env.RECOVER_APPLY === '1';
const LIMIT = parseInt(process.env.RECOVER_LIMIT || '500', 10);
const ACCOUNTS = (process.env.RECOVER_ACCOUNTS || 'heyiris.io:38,thediscoverpage_:80').split(',').map(p => {
  const [account, board] = p.trim().split(':');
  return { account: account.replace(/^@/, ''), boardId: parseInt(board, 10) };
});
const LOCK_FILE = '/tmp/som_batch.lock';

function batchRunning(): boolean {
  try { return lockVerdict(JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'))) === 'busy'; } catch { return false; }
}

test('recover undeliverable leads', async ({ browser }) => {
  test.setTimeout(Math.max(600_000, ACCOUNTS.length * 1_800_000));
  if (!TOKEN) throw new Error('HEYIRIS_TOKEN is required');
  if (batchRunning()) throw new Error('a SOM batch holds the lock; run this when it has finished');

  for (const { account, boardId } of ACCOUNTS) {
    if (batchRunning()) throw new Error('a SOM batch started; stopping before the next account');
    const file = path.join(__dirname, `instagram-auth-${account}.json`);
    if (!fs.existsSync(file)) { console.log(JSON.stringify({ account, error: 'no session file' })); continue; }
    const context = await browser.newContext();
    let profiles: any[] = [];
    try {
      await context.addCookies(JSON.parse(fs.readFileSync(file, 'utf8')).cookies);
      const page = await context.newPage();
      const inbox = await new InstagramInboxJsonProvider(account).discover(page, context, {
        targetUrl: 'https://www.instagram.com/direct/inbox/', limit: LIMIT, scrollAttempts: 60, scrollDelay: 1500,
      });
      profiles = inbox.profiles;
    } finally {
      await context.close().catch(() => {});
    }

    const api = new LeadgenApiClient(TOKEN, boardId);
    const needsLeads = profiles.some(p => p.rawMetadata?.cantReceive && !p.rawMetadata?.hasTheirMessage);
    const leadMap = needsLeads ? await api.getLeadMapFull() : new Map();
    const { counts, toCheck } = recover.planRecovery(profiles, leadMap);
    const applied = { noted: 0, archived: 0, reopened: 0, failed: 0 };
    let tagId: number | undefined;
    let tagTried = false;

    for (const item of toCheck) {
      const [leadRes, omRes] = await Promise.all([api.getLead(item.leadId), api.getOutreachMessages(item.leadId)]);
      const lead = leadRes.data?.data || leadRes.data;
      if (!leadRes.success || !omRes.success || !lead) { applied.failed++; continue; }
      const messages = omRes.data?.messages || [];
      const verdict = recover.decide(lead, messages, account);
      if (verdict === 'replied') { counts.replied++; continue; }
      if (verdict === 'already-marked') { counts.alreadyMarked++; continue; }
      counts.reclassify++;
      if (!APPLY) continue;
      if (!tagTried && lead.user_id) {
        tagTried = true;
        tagId = (await api.resolveTags(lead.user_id, [TAG]))[0];
      }
      const r = await recover.applyRecovery(api, { ...lead, id: item.leadId }, messages, { account, handle: item.handle, at: item.at, tagId });
      if (r.noted) applied.noted++; else applied.failed++;
      applied.archived += r.archived;
      applied.reopened += r.reopened;
    }
    console.log(JSON.stringify(recover.report({ account, apply: APPLY, counts, applied: APPLY ? applied : undefined })));
  }
});
