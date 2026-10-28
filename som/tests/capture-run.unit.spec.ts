/**
 * #191634 (one failed account crashed the whole capture), #191635 (one account's login read as
 * another) and #191633 (our own accounts became leads) — against the SHIPPED modules.
 *
 * No browser: no `page`/`browser` fixture is used. fetch and the Discord request are fakes;
 * session files are synthetic, in temp dirs.
 *
 * Run: npx playwright test tests/capture-run.unit.spec.ts --config playwright.config.ts
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  sendDiscordAlert, syncInbox, runInboxScan, ScanConfig,
} from '../helpers/inbox-scanner';
import {
  runCaptureAccounts, formatCaptureSummary, resolveSessionFile, assertSessionIsDistinct, SessionUnusableError,
} from '../helpers/capture-run';
import { InstagramIdentityError } from '../helpers/providers/instagram-inbox-json-provider';
import { keepDiscovered, DiscoveredProfile } from '../helpers/providers/base-provider';
import { LeadgenApiClient } from '../helpers/leadgen-api-client';

const OWNED = new Set(['thediscoverpage_', 'freelabelnet', 'thebeatbox__']);

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'capture-run-')); }
function session(userId: number) {
  return { cookies: [{ name: 'ds_user_id', value: String(userId), domain: '.instagram.com', path: '/' }], origins: [] };
}

/** Replace global fetch for one test; returns the recorded calls. */
function fakeFetch(respond: (url: string, init: any) => any) {
  const calls: { url: string; body: any }[] = [];
  const real = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
    const body = respond(String(url), init);
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { calls, restore: () => { (globalThis as any).fetch = real; } };
}

function convo(username: string) {
  return { username, displayName: username, rawMetadata: { fullMessages: `${username}: hey\nme: hi`, lastFromThem: true, hasTheirMessage: true } };
}

test.describe('an alert never crashes the scan (#191634)', () => {
  test('no webhook: logs, skips, resolves — and makes no request', async () => {
    let requested = 0;
    const req: any = () => { requested++; throw new Error('should not be called'); };
    await expect(sendDiscordAlert('', 'x', req)).resolves.toBeUndefined();
    await expect(sendDiscordAlert(undefined, 'x', req)).resolves.toBeUndefined();
    expect(requested).toBe(0);
  });

  test('a malformed webhook resolves instead of throwing', async () => {
    await expect(sendDiscordAlert('not a url', 'x')).resolves.toBeUndefined();
  });
});

test.describe('each account is isolated, and the run ends with a per-account summary (#191634)', () => {
  test('a logged-out and a broken account do not stop the accounts after them', async () => {
    const list = [
      { account: 'heyiris.io', boardId: 38 },
      { account: 'thediscoverpage_', boardId: 80 },
      { account: 'freelabelnet', boardId: 80 },
      { account: 'thebeatbox__', boardId: 224 },
    ];
    const read: string[] = [];
    const alerts: string[] = [];
    const rows = await runCaptureAccounts(list, async (e) => {
      read.push(e.account);
      if (e.account === 'thediscoverpage_') throw new InstagramIdentityError('@thediscoverpage_: not logged in');
      if (e.account === 'freelabelnet') throw new Error('inbox-sync rejected the capture');
      return 'read 3';
    }, async (e) => {
      alerts.push(e.account);
      // The alert itself failing — the original crash — must not stop the run either.
      await sendDiscordAlert('', 'x');
      throw new Error('alert blew up');
    });
    expect(read).toEqual(['heyiris.io', 'thediscoverpage_', 'freelabelnet', 'thebeatbox__']);
    expect(alerts).toEqual(['thediscoverpage_', 'freelabelnet']);
    expect(rows.map(r => [r.account, r.status])).toEqual([
      ['heyiris.io', 'ok'], ['thediscoverpage_', 'logged out'], ['freelabelnet', 'error'], ['thebeatbox__', 'ok'],
    ]);
    const text = formatCaptureSummary(rows);
    expect(text).toContain('2 ok, 1 logged out, 1 error');
    expect(text).toMatch(/@freelabelnet\s+board 80\s+error\s+inbox-sync rejected/);
  });

  test('a missing session counts as logged out', async () => {
    const rows = await runCaptureAccounts([{ account: 'a', boardId: 1 }], async () => { throw new SessionUnusableError('no session file'); });
    expect(rows[0].status).toBe('logged out');
  });
});

test.describe('one account never reads another account\'s login (#191635)', () => {
  test('with several accounts, an override or the legacy file is not used for every account', () => {
    const dir = tmp();
    const override = path.join(dir, 'override.json');
    const legacy = path.join(dir, 'instagram-auth.json');
    fs.writeFileSync(override, '{}');
    fs.writeFileSync(legacy, '{}');
    fs.writeFileSync(path.join(dir, 'instagram-auth-heyiris.io.json'), '{}');
    expect(resolveSessionFile('thediscoverpage_', { dirs: [dir], override, legacyFile: legacy, singleAccount: false })).toBeNull();
    expect(resolveSessionFile('heyiris.io', { dirs: [dir], override, legacyFile: legacy, singleAccount: false }))
      .toBe(path.join(dir, 'instagram-auth-heyiris.io.json'));
    expect(resolveSessionFile('thediscoverpage_', { dirs: [dir], override, legacyFile: legacy, singleAccount: true })).toBe(override);
  });

  test('identical auth files are refused before use, naming both', () => {
    const dir = tmp();
    const same = JSON.stringify(session(555));
    fs.writeFileSync(path.join(dir, 'instagram-auth-freelabelnet.json'), same);
    const f = path.join(dir, 'instagram-auth-thediscoverpage_.json');
    fs.writeFileSync(f, same);
    expect(() => assertSessionIsDistinct(f, 'thediscoverpage_'))
      .toThrow(/instagram-auth-freelabelnet\.json and instagram-auth-thediscoverpage_\.json/);
    fs.writeFileSync(f, JSON.stringify(session(556)));
    expect(() => assertSessionIsDistinct(f, 'thediscoverpage_')).not.toThrow();
  });
});

test.describe('our own accounts are never leads (#191633)', () => {
  const config: ScanConfig = {
    platform: 'instagram', account: 'thebeatbox__', boardId: 224, apiBase: 'http://api.test',
    token: 't', dryRun: true, ourName: '', discordWebhook: '',
  };

  test('inbox-sync never receives a conversation with one of our accounts', async () => {
    const f = fakeFetch(() => ({ stats: { created: 1 } }));
    try {
      await syncInbox('http://api.test', 't', 224, 'instagram', 'thebeatbox__',
        [convo('thediscoverpage_'), convo('FreelabelNet'), convo('a_real_fan')], '', { createMissing: true, ownedHandles: OWNED });
    } finally { f.restore(); }
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].body.conversations.map((c: any) => c.handle)).toEqual(['a_real_fan']);
  });

  test('only our accounts: nothing is sent at all', async () => {
    const f = fakeFetch(() => ({ stats: {} }));
    try {
      await syncInbox('http://api.test', 't', 224, 'instagram', 'thebeatbox__', [convo('freelabelnet')], '', { createMissing: true, ownedHandles: OWNED });
    } finally { f.restore(); }
    expect(f.calls).toHaveLength(0);
  });

  test('the inbox scan neither matches, tags nor counts our accounts', async () => {
    const f = fakeFetch(() => ({ data: [] }));
    let result;
    try {
      result = await runInboxScan(config, [convo('thediscoverpage_'), convo('a_real_fan')],
        [{ id: 29469, name: 'thediscoverpage_', igHandle: 'thediscoverpage_' }], { ownedHandles: OWNED });
    } finally { f.restore(); }
    expect(result.tagged).toEqual([]);
    expect(result.scannedCount).toBe(1);
    expect(result.unmatchedProfiles.map((p: any) => p.username)).toEqual(['a_real_fan']);
  });

  test('every discovery provider drops our accounts (comments, followers, inbox, profiles)', () => {
    const p = (username: string, platform = 'instagram'): DiscoveredProfile => ({ username, platform });
    expect(keepDiscovered(p('freelabelnet'), { ownedHandles: OWNED })).toBe(false);
    expect(keepDiscovered(p('@TheBeatBox__'), { ownedHandles: OWNED })).toBe(false);
    expect(keepDiscovered(p('a_real_fan'), { ownedHandles: OWNED })).toBe(true);
    expect(keepDiscovered(p('a_real_fan'), { ownedHandles: OWNED, filterFn: () => false })).toBe(false);
    expect(keepDiscovered(p('freelabelnet', 'linkedin'), { ownedHandles: OWNED })).toBe(true);
  });

  test('leadgen never creates a lead for one of our accounts', async () => {
    const f = fakeFetch(() => ({ data: { id: 1 } }));
    let batch;
    try {
      const client = new LeadgenApiClient('t', 224, { ownedHandles: OWNED });
      batch = await client.createLeadsBatch([
        { name: '@freelabelnet', source: 'leadgen:instagram:comments', contact_info: { instagram: 'freelabelnet' } },
        { name: 'Fan', source: 'leadgen:instagram:comments', contact_info: { instagram: 'a_real_fan' } },
      ], { concurrency: 5, delayBetweenBatches: 0 });
    } finally { f.restore(); }
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].body.contact_info.instagram).toBe('a_real_fan');
    expect(batch.owned).toBe(1);
    expect(batch.created).toBe(1);
  });
});
