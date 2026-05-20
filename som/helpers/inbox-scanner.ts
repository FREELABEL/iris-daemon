/**
 * Shared Inbox Scanner Module
 *
 * Centralizes all common logic across Instagram, LinkedIn, and WhatsApp
 * inbox check specs. Each spec provides platform-specific glue (session,
 * provider, lead field mapping) and delegates scanning to this module.
 */
import * as https from 'https';

// ── Types ──────────────────────────────────────────────────────────

export interface Lead {
  id: number;
  name: string;
  phone?: string;
  igHandle?: string;
  [key: string]: any;
}

export interface ScanConfig {
  platform: string;       // 'instagram' | 'linkedin' | 'whatsapp'
  account: string;        // e.g. 'heyiris.io', 'linkedin', WA_ACCOUNT
  boardId: number;
  apiBase: string;
  token: string;
  dryRun: boolean;
  ourName: string;        // empty string for auto-detect
  discordWebhook: string;
}

export interface InboxProfile {
  displayName?: string;
  username?: string;
  rawMetadata?: Record<string, any>;
}

export interface ScanResult {
  tagged: { name: string; leadId: number; contact: string; lastMsg: string }[];
  unmatched: { contact: string; phone?: string; lastMsg: string }[];
  alreadyTaggedCount: number;
  scannedCount: number;
}

export interface RunOptions {
  autoDetectOurName?: boolean;
  onEnrich?: (lead: Lead, contactPhone: string, contactName: string) => Promise<void>;
}

// ── Pure Utilities ─────────────────────────────────────────────────

/** Fuzzy name match — safe for short names (no "Al" matching "Alice") */
export function nameMatch(a: string, b: string): boolean {
  const na = a.toLowerCase().replace(/[^a-z0-9._]/g, '').trim();
  const nb = b.toLowerCase().replace(/[^a-z0-9._]/g, '').trim();
  if (!na || !nb || na.length < 2 || nb.length < 2) return false;
  if (na === nb) return true;
  if (na.length < 5 || nb.length < 5) return false;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length > nb.length ? na : nb;
  if (shorter.length / longer.length < 0.4) return false;
  return longer.includes(shorter);
}

/** Normalize phone to last 10 digits for comparison */
export function normalizePhone(phone: string): string {
  const digits = (phone || '').replace(/[^\d]/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/** Match two phone numbers by last 10 digits */
export function phoneMatch(a: string, b: string): boolean {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb || na.length < 7 || nb.length < 7) return false;
  return na === nb;
}

/** Send a Discord webhook alert (fire-and-forget) */
export function sendDiscordAlert(webhook: string, message: string): Promise<void> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ content: message });
    const url = new URL(webhook);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, () => resolve());
    req.on('error', () => resolve());
    req.write(body);
    req.end();
  });
}

// ── API Helpers ────────────────────────────────────────────────────

/** Fetch board leads with pagination, mapping each via callback */
export async function fetchBoardLeads<T extends Lead>(
  apiBase: string,
  token: string,
  boardId: number,
  mapLead: (raw: any) => T,
  maxPages = 3,
): Promise<T[]> {
  const leads: T[] = [];
  for (let pg = 1; pg <= maxPages; pg++) {
    try {
      const res = await fetch(
        `${apiBase}/api/v1/leads?bloq_id=${boardId}&per_page=200&page=${pg}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
      );
      if (!res.ok) break;
      const data = await res.json();
      const items = data.data?.data || data.data || [];
      for (const l of items) leads.push(mapLead(l));
      if (items.length < 200) break;
    } catch (err: any) {
      console.log(`API error (page ${pg}): ${err.message}`);
      break;
    }
  }
  return leads;
}

/** Check if lead already has an [inbox reply] or [replied] note */
export async function isAlreadyTagged(apiBase: string, token: string, leadId: number): Promise<boolean> {
  try {
    const res = await fetch(
      `${apiBase}/api/v1/leads/${leadId}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
    );
    if (!res.ok) return false;
    const detail = await res.json();
    const notes = detail.data?.notes || [];
    return notes.some((n: any) => {
      const msg = (n.message || n.content || '').toLowerCase();
      return msg.includes('[inbox reply]') || msg.includes('[replied]');
    });
  } catch {
    return false;
  }
}

/** Post a note to a lead — always uses `message` field (not `content`) */
export async function tagLeadAsReplied(
  apiBase: string, token: string, leadId: number, noteText: string, dryRun: boolean
): Promise<boolean> {
  if (dryRun) {
    console.log(`    [DRY RUN] Would tag lead #${leadId}`);
    return true;
  }
  try {
    const res = await fetch(
      `${apiBase}/api/v1/leads/${leadId}/notes`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ message: noteText, type: 'system' }),
      }
    );
    if (res.ok) {
      console.log(`    Tagged lead #${leadId}`);
      return true;
    }
    console.log(`    Tag failed: ${res.status}`);
    return false;
  } catch (err: any) {
    console.log(`    Tag error: ${err.message}`);
    return false;
  }
}

/** Sync conversations to inbox-sync API */
export async function syncInbox(
  apiBase: string,
  token: string,
  boardId: number,
  platform: string,
  account: string,
  profiles: InboxProfile[],
  ourName: string,
): Promise<void> {
  const conversations = profiles.map(profile => {
    const contactHandle = profile.rawMetadata?.phoneNumber || profile.username || profile.displayName || '';
    const fullMessages = profile.rawMetadata?.fullMessages || '';
    const lines = fullMessages.split('\n').filter(Boolean);

    let replied = false;
    const messages: { sender: string; body: string; timestamp: string }[] = [];

    for (const line of lines) {
      const senderMatch = line.match(/^(.+?):\s(.+?)(?:\s\[(.+?)\])?$/);
      if (senderMatch) {
        const sender = senderMatch[1].trim();
        const body = senderMatch[2].trim();
        const timestamp = senderMatch[3] || '';
        const isMe = sender === 'me' || (ourName && nameMatch(sender, ourName));
        if (!isMe && sender) replied = true;
        messages.push({ sender: isMe ? 'me' : sender, body, timestamp });
      }
    }

    return { handle: contactHandle, replied, messages };
  }).filter(c => c.messages.length > 0);

  if (conversations.length === 0) return;

  try {
    const res = await fetch(`${apiBase}/api/v1/leads/inbox-sync`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ conversations, board_id: boardId, account, platform }),
    });
    if (res.ok) {
      const data = await res.json();
      console.log(`\n  Inbox sync: ${data.stats?.new_messages || 0} new messages stored, ${data.stats?.replied || 0} leads marked replied`);
    } else {
      console.log(`\n  Inbox sync failed: ${res.status}`);
    }
  } catch (err: any) {
    console.log(`\n  Inbox sync error: ${err.message}`);
  }
}

// ── Auto-detect our name from sender frequency ────────────────────

export function autoDetectOurName(profiles: InboxProfile[]): string {
  const senderCounts: Record<string, number> = {};
  for (const profile of profiles) {
    const msgs = (profile.rawMetadata?.fullMessages || '').split('\n').filter(Boolean);
    for (const line of msgs) {
      const match = line.match(/^(.+?):\s/);
      if (match) {
        const sender = match[1].trim();
        senderCounts[sender] = (senderCounts[sender] || 0) + 1;
      }
    }
  }
  const sorted = Object.entries(senderCounts).sort((a, b) => b[1] - a[1]);
  if (sorted.length > 0) {
    console.log(`Auto-detected our name: "${sorted[0][0]}" (appeared in ${sorted[0][1]} messages)`);
    return sorted[0][0];
  }
  return '';
}

// ── Reply Detection ───────────────────────────────────────────────

export function detectReply(
  profile: InboxProfile,
  ourName: string,
): boolean {
  const fullMessages = profile.rawMetadata?.fullMessages || '';
  const lastMessage = profile.rawMetadata?.lastMessage || '';

  if (fullMessages) {
    const lines = fullMessages.split('\n').filter(Boolean);
    const lastLine = lines[lines.length - 1] || '';
    const senderMatch = lastLine.match(/^(.+?):\s/);
    const lastSender = senderMatch?.[1]?.trim() || '';

    if (lastLine.startsWith('them:') || lastLine.startsWith('them :')) return true;
    if (lastSender && lastSender !== 'me' && (!ourName || !nameMatch(lastSender, ourName))) return true;
  } else if (lastMessage) {
    const lower = lastMessage.toLowerCase();
    if (!lower.startsWith('you sent') && !lower.startsWith('you:') &&
        !lower.startsWith('sent a') && !lower.startsWith('me:')) {
      return true;
    }
  }
  return false;
}

// ── Lead Matching ─────────────────────────────────────────────────

export function matchLeadLocal(
  leads: Lead[],
  contactName: string,
  contactPhone: string,
  phoneMap?: Map<string, Lead>,
): Lead | undefined {
  // Phone match first (fast map lookup)
  if (contactPhone && phoneMap) {
    const normalized = normalizePhone(contactPhone);
    const hit = phoneMap.get(normalized);
    if (hit) return hit;
  }

  return leads.find(lead => {
    if (lead.igHandle && contactName && nameMatch(lead.igHandle, contactName)) return true;
    if (lead.name && contactName && nameMatch(lead.name, contactName)) return true;
    if (contactPhone && lead.phone && phoneMatch(contactPhone, lead.phone)) return true;
    return false;
  });
}

export async function matchLeadApi(
  apiBase: string, token: string, boardId: number, searchTerm: string
): Promise<Lead | undefined> {
  for (const scope of [`bloq_id=${boardId}&`, '']) {
    try {
      const res = await fetch(
        `${apiBase}/api/v1/leads?${scope}search=${encodeURIComponent(searchTerm)}&per_page=1`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
      );
      if (res.ok) {
        const data = await res.json();
        const results = data.data?.data || data.data || [];
        if (results.length > 0) {
          return { id: results[0].id, name: results[0].name || '' };
        }
      }
    } catch {}
  }
  return undefined;
}

// ── Core Orchestrator ─────────────────────────────────────────────

export async function runInboxScan(
  config: ScanConfig,
  profiles: InboxProfile[],
  leads: Lead[],
  options?: RunOptions,
): Promise<ScanResult> {
  let ourName = config.ourName;
  if (!ourName && options?.autoDetectOurName) {
    ourName = autoDetectOurName(profiles);
    if (!ourName) {
      console.log(`Could not determine user name for ${config.platform}. Set the appropriate env var.`);
      console.log('Continuing with best-effort detection...');
    }
  }

  // Build phone lookup map
  const phoneMap = new Map<string, Lead>();
  for (const lead of leads) {
    if (lead.phone) {
      const normalized = normalizePhone(lead.phone);
      if (normalized.length >= 7) phoneMap.set(normalized, lead);
    }
  }
  if (phoneMap.size > 0) {
    console.log(`Phone lookup map: ${phoneMap.size} leads with phone numbers`);
  }

  const tagged: ScanResult['tagged'] = [];
  const unmatched: ScanResult['unmatched'] = [];
  let alreadyTaggedCount = 0;

  for (const profile of profiles) {
    const contactName = profile.displayName || profile.username || '';
    const contactPhone = profile.rawMetadata?.phoneNumber || '';
    const fullMessages = profile.rawMetadata?.fullMessages || '';
    const lastMessage = profile.rawMetadata?.lastMessage || '';

    if (!detectReply(profile, ourName)) continue;

    // Match lead
    let matchedLead = matchLeadLocal(leads, contactName, contactPhone, phoneMap);

    if (!matchedLead && (contactName || contactPhone)) {
      const searchTerm = contactPhone || contactName;
      matchedLead = await matchLeadApi(config.apiBase, config.token, config.boardId, searchTerm);
    }

    if (!matchedLead) {
      unmatched.push({
        contact: contactName,
        phone: contactPhone || undefined,
        lastMsg: (lastMessage || fullMessages || '').substring(0, 80),
      });
      continue;
    }

    // Check already tagged
    if (await isAlreadyTagged(config.apiBase, config.token, matchedLead.id)) {
      alreadyTaggedCount++;
      continue;
    }

    const preview = (lastMessage || fullMessages || '').substring(0, 100);
    const contactHandle = profile.username || contactName;
    console.log(`\n  REPLY: ${contactName} -> Lead #${matchedLead.id} (${matchedLead.name})`);
    console.log(`    "${preview}"`);

    const notePrefix = config.platform === 'whatsapp' ? 'WA' :
                       config.platform === 'instagram' ? 'IG' : 'LinkedIn';
    const contactLabel = contactPhone ? `${contactName} (${contactPhone})` :
                         contactHandle ? `@${contactHandle}` : contactName;
    const noteText = `[inbox reply] ${notePrefix} reply from ${contactLabel}: "${preview}"`;

    const success = await tagLeadAsReplied(
      config.apiBase, config.token, matchedLead.id, noteText, config.dryRun
    );
    if (success) {
      tagged.push({ name: matchedLead.name, leadId: matchedLead.id, contact: contactName, lastMsg: preview });
    }

    // Enrichment callback (e.g. WA phone enrichment)
    if (options?.onEnrich && contactPhone && matchedLead.phone === '') {
      await options.onEnrich(matchedLead, contactPhone, contactName);
    }
  }

  return { tagged, unmatched, alreadyTaggedCount, scannedCount: profiles.length };
}

// ── Output ────────────────────────────────────────────────────────

export function printSummary(config: ScanConfig, result: ScanResult): void {
  console.log('\n' + '='.repeat(60));
  const platformLabel = config.platform.toUpperCase();
  console.log(config.dryRun ? '  DRY RUN COMPLETE' : `  ${platformLabel} INBOX CHECK COMPLETE`);
  console.log('='.repeat(60));
  if (config.account !== config.platform) {
    console.log(`  Account: ${config.platform === 'instagram' ? '@' : ''}${config.account}`);
  }
  console.log(`  Board: ${config.boardId}`);
  console.log(`  Conversations scanned: ${result.scannedCount}`);
  console.log(`  Replies detected: ${result.tagged.length}`);
  console.log(`  Already tagged: ${result.alreadyTaggedCount}`);
  console.log(`  Unmatched replies: ${result.unmatched.length}`);
  if (result.tagged.length > 0) {
    console.log(`\n  ${config.dryRun ? 'Would tag' : 'Tagged'} ${result.tagged.length} leads:`);
    for (const t of result.tagged) {
      console.log(`    - ${t.name} (#${t.leadId}) via ${t.contact}`);
    }
  }
  if (result.unmatched.length > 0) {
    console.log(`\n  Unmatched conversations with replies (not on board):`);
    for (const u of result.unmatched.slice(0, 10)) {
      const phoneTag = u.phone ? ` [phone: ${u.phone}]` : '';
      console.log(`    - ${u.contact}${phoneTag}: "${u.lastMsg}"`);
    }
    if (result.unmatched.length > 10) console.log(`    ... and ${result.unmatched.length - 10} more`);
  }
  console.log('='.repeat(60));
}

export async function sendResultAlert(config: ScanConfig, result: ScanResult): Promise<void> {
  if (config.dryRun) return;

  let alertMsg = '';
  const platformLabel = config.platform === 'whatsapp' ? 'WA' :
                        config.platform === 'instagram' ? 'IG' : 'LinkedIn';

  if (result.tagged.length > 0) {
    const lines = result.tagged.slice(0, 10).map(t =>
      `  - **${t.name}** (#${t.leadId}) -- ${t.contact}`
    ).join('\n');
    alertMsg += `**${platformLabel} Inbox Check -- ${result.tagged.length} Replies Found**\n` +
      `Account: \`${config.account}\` | Board: \`${config.boardId}\`\n${lines}`;
  }

  if (config.platform === 'whatsapp' && result.unmatched.length > 0) {
    const withPhones = result.unmatched.filter(u => u.phone);
    if (withPhones.length > 0) {
      const unmLines = withPhones.slice(0, 5).map(u =>
        `  - ${u.contact} (${u.phone})`
      ).join('\n');
      alertMsg += `\n\n**Unmatched contacts with phone numbers** (run \`iris leads search\` to link):\n${unmLines}`;
    }
  }

  if (alertMsg) {
    await sendDiscordAlert(config.discordWebhook, alertMsg);
  }
}
