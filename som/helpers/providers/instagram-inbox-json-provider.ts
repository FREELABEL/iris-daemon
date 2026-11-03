import { Page, BrowserContext, Response } from '@playwright/test';
import {
  BaseDiscoveryProvider,
  DiscoveredProfile,
  DiscoveryConfig,
  DiscoveryResult,
  dismissInstagramPopups, keepDiscovered } from './base-provider';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { REFUSED_TYPE } = require('../delivery-check');

/**
 * Instagram Inbox (JSON) Provider — reads the DM inbox from the data the Instagram web app
 * itself loads, instead of scraping the rendered sidebar (#191279).
 *
 * Why: the DOM provider clicks into every thread, takes ~8s per conversation (87s for 11 on
 * 2026-10-26), only ever sees display names, and has to guess who is who. The web app's own
 * mailbox response carries, for every thread, the other person's exact username, the last
 * messages with an exact sender id, and the viewer's own id — 15 threads in ~1.5s.
 *
 * It is read-only: it opens the inbox, switches tabs and scrolls the thread list. It never
 * opens a thread (which would mark it seen) and never types.
 *
 * Identity guard (#191277): before reading anything it confirms the logged-in account IS the
 * account we were asked to read. A session file that belongs to another account fails loudly
 * instead of reporting that account's inbox under the wrong name.
 */

/** One message as parsed from the mailbox payload, oldest first within a thread. */
export interface MailboxMessage {
  fromViewer: boolean;
  text: string;
  timestampMs: number;
  /** Instagram's "this account can't receive your message": sent by us, typed by Instagram (#192164). */
  refused?: boolean;
}

/** One DM thread as parsed from the mailbox payload. */
export interface MailboxThread {
  threadId: string;
  username: string;        // the other person's exact IG handle
  fullName: string;
  folder: string;          // PRIMARY | GENERAL | ... as Instagram labels it
  lastActivityMs: number;
  unread: boolean;         // their last message is newer than our read watermark
  lastFromThem: boolean;   // the newest message we can see was sent by them
  messages: MailboxMessage[];
}

/** Walk any JSON value and yield every `as_ig_direct_thread` node in it. */
function* findThreadNodes(value: any): Generator<any> {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value) yield* findThreadNodes(v);
    return;
  }
  if (value.as_ig_direct_thread && typeof value.as_ig_direct_thread === 'object') {
    yield value.as_ig_direct_thread;
  }
  for (const [k, v] of Object.entries(value)) {
    if (k === 'as_ig_direct_thread') continue;
    if (v && typeof v === 'object') yield* findThreadNodes(v);
  }
}

function messageText(node: any): string {
  const t = node?.text_body ?? node?.content?.text_body ?? node?.igd_snippet;
  if (typeof t === 'string' && t.trim()) return t.trim();
  const type = String(node?.content_type || node?.content?.__typename || 'message');
  return `[${type.toLowerCase()}]`;
}

/**
 * Parse one mailbox payload (the JSON body of an /api/graphql response) into threads.
 * Pure: no I/O, so it is unit-tested against a recorded payload.
 * Group threads are skipped — a group reply is not one person's reply.
 */
export function parseMailboxPayload(payload: any): MailboxThread[] {
  const out: MailboxThread[] = [];
  for (const t of findThreadNodes(payload)) {
    if (t.is_group) continue;
    const other = (t.usersWithoutViewer && t.users)
      ? (t.users.find((u: any) => String(u.id) === String(t.usersWithoutViewer[0]?.id)) || t.users[0])
      : t.users?.[0];
    const username = String(other?.username || '').trim();
    if (!username) continue;

    const viewerFbid = String(t.viewer?.interop_messaging_user_fbid || '');
    const edges: any[] = t.slide_messages?.edges || [];
    const messages: MailboxMessage[] = edges
      .map(e => e?.node)
      .filter(Boolean)
      .map((n: any) => ({
        fromViewer: !!viewerFbid && String(n.sender_fbid) === viewerFbid,
        text: messageText(n),
        timestampMs: Number(n.timestamp_ms) || 0,
        refused: REFUSED_TYPE.test(String(n.content_type || '')),
      }))
      .sort((a, b) => a.timestampMs - b.timestampMs);

    const newest = messages[messages.length - 1];
    const lastFromThem = !!newest && !newest.fromViewer;
    const lastActivityMs = Number(t.last_activity_timestamp_ms) || newest?.timestampMs || 0;
    const viewerWatermark = (t.slide_read_receipts || [])
      .filter((r: any) => String(r.participant_fbid) === viewerFbid)
      .reduce((m: number, r: any) => Math.max(m, Number(r.watermark_timestamp_ms) || 0), 0);

    out.push({
      threadId: String(t.thread_key || t.thread_fbid || t.id || ''),
      username,
      fullName: String(other?.full_name || '').trim(),
      folder: String(t.folder || t.system_folder || ''),
      lastActivityMs,
      unread: !!t.marked_as_unread || (lastFromThem && lastActivityMs > viewerWatermark),
      lastFromThem,
      messages,
    });
  }
  return out;
}

/** Merge threads seen across several payloads, keeping the copy with the newest activity. */
export function mergeThreads(into: Map<string, MailboxThread>, threads: MailboxThread[]): number {
  let added = 0;
  for (const t of threads) {
    const key = t.threadId || t.username;
    const prev = into.get(key);
    if (!prev) added++;
    if (!prev || t.lastActivityMs >= prev.lastActivityMs) {
      const messages = prev && prev.messages.length > t.messages.length && prev.lastActivityMs === t.lastActivityMs
        ? prev.messages : t.messages;
      into.set(key, { ...t, messages });
    }
  }
  return added;
}

/**
 * Convert a thread to the InboxProfile shape the scanner already understands.
 * fullMessages uses the scanner's line format "<sender>: <text> [<iso>]", oldest first,
 * with our own messages written as "me" — so detectReply needs no name guessing.
 */
export function threadToProfile(t: MailboxThread): DiscoveredProfile {
  const lines = t.messages.map(m =>
    `${m.fromViewer ? 'me' : t.username}: ${m.text.replace(/\s+/g, ' ')} [${new Date(m.timestampMs).toISOString()}]`);
  const lastThem = [...t.messages].reverse().find(m => !m.fromViewer);
  const refusal = [...t.messages].reverse().find(m => m.refused);
  return {
    username: t.username,
    platform: 'instagram',
    displayName: t.fullName || t.username,
    profileUrl: `https://www.instagram.com/${t.username}/`,
    sourceContext: `ig inbox (${t.folder || 'unknown'})`,
    rawMetadata: {
      fullMessages: lines.join('\n'),
      lastMessage: lastThem?.text || '',
      threadId: t.threadId,
      folder: t.folder,
      unread: t.unread,
      lastFromThem: t.lastFromThem,
      hasTheirMessage: t.messages.some(m => !m.fromViewer),
      lastActivityAt: t.lastActivityMs ? new Date(t.lastActivityMs).toISOString() : null,
      handleIsExact: true,
      cantReceive: !!refusal,
      cantReceiveAt: refusal?.timestampMs ? new Date(refusal.timestampMs).toISOString() : null,
    },
  };
}

/**
 * The logged-in account's username, read from the inbox document Instagram serves.
 * Returns '' when it cannot be determined — callers must treat that as "not confirmed".
 */
export function viewerUsernameFromHtml(html: string): string {
  const m = html.match(/"should_show_public_contacts":(?:true|false),"username":"([^"]+)"/)
    || html.match(/"viewer":\{[^{}]*"username":"([^"]+)"/);
  return m ? m[1] : '';
}

export class InstagramIdentityError extends Error {}

export class InstagramInboxJsonProvider extends BaseDiscoveryProvider {
  readonly platform = 'instagram';
  readonly discoveryType = 'inbox';

  /** Tabs to read, replies first. Cold-DM replies land in General; Primary is mostly our own
   *  outbound DMs, so reading it first lets it eat the whole limit before General is reached.
   *  Requests is last: it opens /direct/requests/, a page with no tabs to come back from. */
  private tabs = (process.env.INBOX_TABS || 'General,Primary,Requests')
    .split(',').map(s => s.trim()).filter(Boolean);

  constructor(private expectedAccount: string) {
    super();
  }

  /** Close whatever announcement or permission modal Instagram stacked on the inbox. */
  private async closeModals(page: Page): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const notNow = page.getByRole('button', { name: /^not now$/i }).first();
      if (await notNow.isVisible({ timeout: 1200 }).catch(() => false)) {
        await notNow.click().catch(() => {});
        await page.waitForTimeout(400);
        continue;
      }
      if (await page.locator('[role="dialog"]').first().isVisible({ timeout: 300 }).catch(() => false)) {
        await dismissInstagramPopups(page);
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(400);
        continue;
      }
      break;
    }
  }

  async discover(
    page: Page,
    _context: BrowserContext,
    config: DiscoveryConfig,
  ): Promise<DiscoveryResult> {
    const start = Date.now();
    const errors: string[] = [];
    const threads = new Map<string, MailboxThread>();
    let inboxHtml = '';
    let payloads = 0;

    const onResponse = async (res: Response) => {
      const url = res.url();
      try {
        if (url.includes('/direct/inbox') && res.request().resourceType() === 'document') {
          inboxHtml = await res.text();
          return;
        }
        if (!url.includes('/api/graphql') && !url.includes('/graphql/query')) return;
        const body = await res.text();
        if (!body.includes('as_ig_direct_thread')) return;
        payloads++;
        mergeThreads(threads, parseMailboxPayload(JSON.parse(body)));
      } catch {
        // a response that is not JSON, or a closed page — not ours to handle
      }
    };
    page.on('response', onResponse);

    try {
      await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!page.url().includes('/direct/')) {
        throw new InstagramIdentityError(`@${this.expectedAccount}: not logged in (landed on ${page.url()})`);
      }
      await page.waitForTimeout(2500);

      const viewer = viewerUsernameFromHtml(inboxHtml).toLowerCase();
      const expected = this.expectedAccount.replace(/^@/, '').toLowerCase();
      if (!viewer) {
        throw new InstagramIdentityError(`@${expected}: could not confirm which account this session belongs to`);
      }
      if (viewer !== expected) {
        throw new InstagramIdentityError(`session file for @${expected} is logged in as @${viewer} — refusing to read it`);
      }
      // The inbox renders after the document; wait for its tabs, then close any announcement modal.
      // Modals ("Turn on Notifications", "Your Meta Account is here") hide the tabs from the
      // accessibility tree, so they have to be closed before a tab can be found.
      await this.closeModals(page);
      await page.getByRole('tab').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

      const delay = config.scrollDelay ?? 1500;
      // config.limit is per tab, so one busy tab cannot starve the others.
      for (const tab of this.tabs) {
        const tabStart = threads.size;
        // Each tab loads its own mailbox query (General: a paginated thread-list query), so the
        // tab has to be opened for its threads to arrive at all.
        await this.closeModals(page);
        const tabEl = page.getByRole('tab', { name: tab }).first();
        if (await tabEl.waitFor({ state: 'visible', timeout: 10000 }).then(() => true, () => false)) {
          const before = payloads;
          await tabEl.click().catch(() => {});
          for (let w = 0; w < 10 && payloads === before; w++) await page.waitForTimeout(500);
          await page.waitForTimeout(800);
        } else {
          const shot = `../test-results/ig-inbox-no-${tab.toLowerCase()}-tab-${this.expectedAccount}.png`;
          await page.screenshot({ path: shot }).catch(() => {});
          errors.push(`tab "${tab}" not found (screenshot ${shot})`);
          continue;
        }
        // Scrolling the thread list pulls the next page; stop after two scrolls that add nothing.
        let stale = 0;
        for (let i = 0; i < config.scrollAttempts && threads.size - tabStart < config.limit; i++) {
          const before = threads.size;
          await page.mouse.move(260, 520);
          await page.mouse.wheel(0, 3000);
          await page.waitForTimeout(delay);
          stale = threads.size === before ? stale + 1 : 0;
          if (stale >= 2) break;
        }
      }
    } catch (err: any) {
      if (err instanceof InstagramIdentityError) throw err;
      errors.push(err.message);
    } finally {
      page.off('response', onResponse);
    }

    const all = [...threads.values()].sort((a, b) => b.lastActivityMs - a.lastActivityMs);
    // Our own accounts message each other; they are not people to capture (#191633).
    const profiles = all.map(threadToProfile).filter(p => keepDiscovered(p, config));
    console.log(`    Read ${profiles.length} threads from ${payloads} inbox payloads in ${((Date.now() - start) / 1000).toFixed(1)}s` +
      ` — ${all.filter(t => t.lastFromThem).length} with their message last, ${all.filter(t => t.unread).length} unread`);

    return {
      profiles,
      totalScraped: threads.size,
      totalAfterFilter: profiles.length,
      durationMs: Date.now() - start,
      errors,
    };
  }
}
