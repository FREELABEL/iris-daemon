/**
 * Replies are logged as replies, by account, exactly once (#191637). Imports the shipped modules.
 * Run: npx playwright test tests/record-reply.unit.spec.ts --config playwright.config.ts
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { LeadgenApiClient } from '../helpers/leadgen-api-client';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { recordReply, replyCampaign } = require('../helpers/record-reply');

const base = { message: 'hi', channel_account: 'heyiris.io', campaign_name: 'reply:heyiris.io', bloq_id: 38, ig_handle: 'someone' };

/** Stub fetch: record-dm answers with the given statuses in turn; comms always succeeds. */
function stubFetch(recordStatuses: number[]) {
  const calls: { kind: 'record' | 'comms'; body: any }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, opts: any) => {
    const body = JSON.parse(opts.body);
    if (String(url).includes('/atlas/comms/log')) {
      calls.push({ kind: 'comms', body });
      return { ok: true, status: 200, json: async () => ({}) } as any;
    }
    calls.push({ kind: 'record', body });
    const status = recordStatuses.shift() ?? 200;
    return { ok: status < 400, status, json: async () => ({}) } as any;
  }) as any;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('an accepted reply is recorded once, as a reply, with one comms entry', async () => {
  const s = stubFetch([200]);
  try {
    const out = await recordReply(new LeadgenApiClient('t', 38), 1, base);
    expect(out.recordedAs).toBe('reply');
    expect(out.rec.success).toBe(true);
    expect(s.calls.filter(c => c.kind === 'record').map(c => c.body.kind)).toEqual(['reply']);
    expect(s.calls.filter(c => c.kind === 'comms')).toHaveLength(1);
  } finally { s.restore(); }
});

test('a refused reply link falls back to a plain message, with still only ONE comms entry', async () => {
  const s = stubFetch([422, 200]);
  try {
    const out = await recordReply(new LeadgenApiClient('t', 38), 1, base);
    expect(out.recordedAs).toBe('message (reply link refused)');
    expect(out.rec.success).toBe(true);
    expect(s.calls.filter(c => c.kind === 'record').map(c => c.body.kind)).toEqual(['reply', undefined]);
    expect(s.calls.filter(c => c.kind === 'comms')).toHaveLength(1);
  } finally { s.restore(); }
});

test('a campaign send (no kind) that fails still writes comms, as it did before', async () => {
  const s = stubFetch([500]);
  try {
    await new LeadgenApiClient('t', 38).recordDmSent(1, base);
    expect(s.calls.filter(c => c.kind === 'comms')).toHaveLength(1);
  } finally { s.restore(); }
});

test('replies are labelled by account, and the sender no longer names a campaign', () => {
  expect(replyCampaign('heyiris.io')).toBe('reply:heyiris.io');
  expect(replyCampaign('heyiris.io', 'x')).toBe('x');
  const spec = fs.readFileSync(path.join(__dirname, '..', 'send-approved-replies.spec.ts'), 'utf8');
  expect(spec).not.toContain('discover-creator-yes');
  expect(spec).toContain('recordReply(api, it.leadId');
});
