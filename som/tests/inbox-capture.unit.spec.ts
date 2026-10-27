/**
 * Reply capture — unit tests against the SHIPPED modules (no copies, no browser).
 *
 * The older tests/inbox-scanner.test.js carries its own copies of the matching functions, so
 * reverting the shipped code to fuzzy matching left it green (#191271 review). This file
 * imports the real code; break the code and it fails.
 *
 * Run: npx playwright test tests/inbox-capture.unit.spec.ts --config playwright.config.ts
 * Fixtures are synthetic — no real people's handles or messages.
 */
import { test, expect } from '@playwright/test';
import {
  parseMailboxPayload, mergeThreads, threadToProfile, viewerUsernameFromHtml, MailboxThread,
} from '../helpers/providers/instagram-inbox-json-provider';
import { detectReply, matchLeadLocal, exactHandleMatch } from '../helpers/inbox-scanner';

const VIEWER_FBID = '9000';
const THEM_FBID = '7000';

function thread(opts: {
  id: string; username: string; fullName?: string; messages: [string, string, number][];
  isGroup?: boolean; watermark?: number; markedUnread?: boolean;
}) {
  return {
    as_ig_direct_thread: {
      id: opts.id,
      thread_key: opts.id,
      is_group: !!opts.isGroup,
      folder: 'GENERAL',
      last_activity_timestamp_ms: String(Math.max(...opts.messages.map(m => m[2]))),
      marked_as_unread: !!opts.markedUnread,
      users: [{ id: 'u' + opts.id, username: opts.username, full_name: opts.fullName ?? '' }],
      usersWithoutViewer: [{ id: 'u' + opts.id }],
      viewer: { id: 'v', interop_messaging_user_fbid: VIEWER_FBID },
      slide_read_receipts: [{ participant_fbid: VIEWER_FBID, watermark_timestamp_ms: String(opts.watermark ?? 0) }],
      // Instagram returns newest first; the parser must not depend on that.
      slide_messages: {
        edges: [...opts.messages].reverse().map(([who, text, ts]) => ({
          node: { sender_fbid: who === 'me' ? VIEWER_FBID : THEM_FBID, timestamp_ms: String(ts), text_body: text },
        })),
      },
    },
  };
}

// Shaped like the real payloads: threads nested several levels down under varying keys.
const payload = {
  data: {
    fetch__SlideMailbox: {
      threads_by_folder: {
        edges: [
          { node: thread({ id: '1', username: 'replier.one', fullName: 'Replier One', messages: [['me', 'hey', 100], ['them', 'tell me more', 200]], watermark: 150 }) },
          { node: thread({ id: '2', username: 'quiet_two', messages: [['me', 'hey', 100]] }) },
          { node: thread({ id: '3', username: 'answered3', messages: [['me', 'hey', 100], ['them', 'sure', 200], ['me', 'great', 300]], watermark: 250 }) },
          { node: thread({ id: '4', username: 'group_chat', messages: [['them', 'yo', 100]], isGroup: true }) },
          { node: thread({ id: '5', username: '', fullName: 'No Handle', messages: [['them', 'hi', 100]] }) },
        ],
      },
    },
  },
};

test.describe('parseMailboxPayload', () => {
  const threads = parseMailboxPayload(payload);
  const by = (u: string) => threads.find(t => t.username === u)!;

  test('reads exact usernames, skips groups and threads with no handle', () => {
    expect(threads.map(t => t.username).sort()).toEqual(['answered3', 'quiet_two', 'replier.one']);
  });

  test('knows who sent the newest message from the sender id, not a name', () => {
    expect(by('replier.one').lastFromThem).toBe(true);
    expect(by('quiet_two').lastFromThem).toBe(false);
    expect(by('answered3').lastFromThem).toBe(false);
  });

  test('orders messages oldest first whatever order Instagram sends', () => {
    expect(by('answered3').messages.map(m => m.text)).toEqual(['hey', 'sure', 'great']);
  });

  test('unread means their message is newer than our read watermark', () => {
    expect(by('replier.one').unread).toBe(true);
    expect(by('answered3').unread).toBe(false);
  });
});

test('mergeThreads keeps one copy per thread, newest activity wins', () => {
  const map = new Map<string, MailboxThread>();
  const first = parseMailboxPayload(payload);
  expect(mergeThreads(map, first)).toBe(3);
  expect(mergeThreads(map, first)).toBe(0);
  expect(map.size).toBe(3);
});

test.describe('threadToProfile → detectReply', () => {
  const threads = parseMailboxPayload(payload);
  const profile = (u: string) => threadToProfile(threads.find(t => t.username === u)!);

  test('writes our messages as "me" and theirs under their exact handle', () => {
    const lines = profile('replier.one').rawMetadata!.fullMessages.split('\n');
    expect(lines[0]).toMatch(/^me: hey \[/);
    expect(lines[1]).toMatch(/^replier\.one: tell me more \[/);
    expect(profile('replier.one').rawMetadata!.hasTheirMessage).toBe(true);
    expect(profile('quiet_two').rawMetadata!.hasTheirMessage).toBe(false);
  });

  test('detectReply trusts the provider, even when their handle contains our name', () => {
    // A fan of @freelabel writing as @freelabelfan: name-guessing reads their reply as ours.
    const t = parseMailboxPayload({ x: thread({ id: '9', username: 'freelabelfan', messages: [['me', 'hi', 1], ['them', 'interested', 2]] }) });
    expect(detectReply(threadToProfile(t[0]), 'freelabel')).toBe(true);
    expect(detectReply(profile('answered3'), '')).toBe(false);
  });
});

test.describe('lead matching is exact (#191271)', () => {
  const leads = [
    { id: 7981, name: 'Wicus J', igHandle: 'wicus_j' },
    { id: 8213, name: 'Nobody But Zino', igHandle: 'nobodybutzino' },
  ];

  test('a near-miss handle is a different person', () => {
    expect(exactHandleMatch('wicus.j', 'wicus_j')).toBe(false);
    expect(matchLeadLocal(leads, 'wicus.j', '')).toBeUndefined();
  });

  test('one handle containing another is a different person', () => {
    expect(exactHandleMatch('wicus', 'wicus_j')).toBe(false);
    expect(exactHandleMatch('nobodybutzino', 'zino')).toBe(false);
    expect(matchLeadLocal(leads, 'wicus', '')).toBeUndefined();
    expect(matchLeadLocal(leads, 'zino', '')).toBeUndefined();
  });

  test('case and a leading @ are not identity', () => {
    expect(matchLeadLocal(leads, '@Wicus_J', '')?.id).toBe(7981);
  });

  test('a display name never matches a lead', () => {
    expect(matchLeadLocal(leads, 'Wicus J', '')).toBeUndefined();
  });
});

test('viewerUsernameFromHtml reads the logged-in account, or nothing', () => {
  const html = '..."should_show_category":false,"should_show_public_contacts":false,"username":"heyiris.io","is_supervised_user":false...';
  expect(viewerUsernameFromHtml(html)).toBe('heyiris.io');
  expect(viewerUsernameFromHtml('<html>logged out</html>')).toBe('');
});
