import { test, chromium } from '@playwright/test';
import { WhatsAppInboxProvider } from './helpers/providers/whatsapp-inbox-provider';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';

const TOKEN = process.env.HEYIRIS_TOKEN || 'ca54cd87e7046098eee99de3b9c98cfd';
const BOARD_ID = parseInt(process.env.BOARD_ID || '38', 10);
const LIMIT = parseInt(process.env.LIMIT || '20', 10);
const WA_ACCOUNT = process.env.WA_ACCOUNT || 'default';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

// Hive credential protocol: BROWSER_SESSION_FILE can be:
//   1. A directory path (persistent browser profile) — used directly
//   2. A .tar.gz/.tgz archive — extracted to temp dir on start
//   3. A .json file — NOT supported for WA (needs IndexedDB, not just cookies)
const SESSION_INPUT = process.env.BROWSER_SESSION_FILE
  || process.env.WA_SESSION_DIR
  || path.join(os.homedir(), '.iris', 'whatsapp-sessions', WA_ACCOUNT);
const API_BASE = process.env.IRIS_FL_API_URL || 'https://raichu.heyiris.io';

/** Resolve session input to a usable directory, extracting archives if needed */
function resolveSessionDir(input: string): { dir: string; cleanup: boolean } {
  // Archive: extract to temp dir
  if (input.endsWith('.tar.gz') || input.endsWith('.tgz')) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-session-'));
    const { execSync } = require('child_process');
    execSync(`tar -xzf "${input}" -C "${tmpDir}"`, { stdio: 'pipe' });
    console.log(`  Extracted session archive to ${tmpDir}`);
    return { dir: tmpDir, cleanup: true };
  }

  // JSON file: unsupported — WhatsApp needs persistent context (IndexedDB)
  if (input.endsWith('.json')) {
    console.log(`  ERROR: JSON session files not supported for WhatsApp.`);
    console.log(`  WhatsApp stores auth in IndexedDB, not cookies.`);
    console.log(`  Run: WA_ACCOUNT=${WA_ACCOUNT} npx playwright test som/save-whatsapp-session.spec.ts --headed`);
    return { dir: '', cleanup: false };
  }

  // Directory: use as-is
  return { dir: input, cleanup: false };
}

const DISCORD_WEBHOOK = process.env.PLATFORM_UPDATES_DISCORD_CHANNEL_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1473938540139253834/XXWsRliRH7keLMEKrlnCcPPriR-iniyUhfCZU9MubNBBoZESBOLgvl8GqBAwYdajiEp7';

function sendDiscordAlert(message: string): Promise<void> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ content: message });
    const url = new URL(DISCORD_WEBHOOK);
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

/** Normalize phone to last 10 digits for comparison */
function normalizePhone(phone: string): string {
  const digits = (phone || '').replace(/[^\d]/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/** Match two phone numbers by last 10 digits */
function phoneMatch(a: string, b: string): boolean {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb || na.length < 7 || nb.length < 7) return false;
  return na === nb;
}

/** Fuzzy name match — safe for short names (no "Al" matching "Alice") */
function nameMatch(a: string, b: string): boolean {
  const na = a.toLowerCase().replace(/[^a-z0-9._]/g, '').trim();
  const nb = b.toLowerCase().replace(/[^a-z0-9._]/g, '').trim();
  if (!na || !nb || na.length < 2 || nb.length < 2) return false;
  if (na === nb) return true;
  // Short names (< 5 chars): exact match only — prevents "Al" matching "Albert"
  if (na.length < 5 || nb.length < 5) return false;
  // Longer names: substring match only if shorter is >= 40% of longer
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length > nb.length ? na : nb;
  if (shorter.length / longer.length < 0.4) return false;
  return longer.includes(shorter);
}

test(`WhatsApp Inbox Reply Check — ${WA_ACCOUNT} / Board ${BOARD_ID}`, async () => {
  test.setTimeout(600000); // 10 minutes for full inbox scan

  // ── Resolve session (directory, archive, or error) ──
  const resolved = resolveSessionDir(SESSION_INPUT);
  if (!resolved.dir) return; // JSON file or other unsupported format

  const SESSION_DIR = resolved.dir;

  if (!fs.existsSync(SESSION_DIR) || !fs.readdirSync(SESSION_DIR).length) {
    console.log(`No session found: ${SESSION_DIR}`);
    console.log(`Run: WA_ACCOUNT=${WA_ACCOUNT} npx playwright test som/save-whatsapp-session.spec.ts --headed`);
    return;
  }

  console.log(`Launching WhatsApp Web with persistent session (${WA_ACCOUNT})...`);

  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: process.env.HEADLESS === '1',
    viewport: { width: 1280, height: 720 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    // ── Session preflight ──
    console.log('Validating WhatsApp session...');
    await page.goto('https://web.whatsapp.com/', { timeout: 30000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    // Check if we're on QR code page (session expired)
    const hasChatList = await page.locator('div[aria-label="Chat list"][role="grid"]')
      .isVisible({ timeout: 15000 }).catch(() => false);

    if (!hasChatList) {
      const hasSearch = await page.locator('div[contenteditable="true"][data-tab="3"]')
        .isVisible({ timeout: 3000 }).catch(() => false);
      if (!hasSearch) {
        console.log(`SESSION EXPIRED: ${WA_ACCOUNT} — re-scan QR code`);
        await sendDiscordAlert(`**WA Inbox Check -- Session Expired** ${WA_ACCOUNT}`);
        return;
      }
    }
    console.log(`Session valid for ${WA_ACCOUNT}`);

    // ── Fetch board leads from API ──
    console.log(`\nFetching leads from board ${BOARD_ID}...`);
    let boardLeads: { id: number; name: string; phone: string; igHandle: string }[] = [];
    try {
      for (let pg = 1; pg <= 3; pg++) {
        const res = await fetch(
          `${API_BASE}/api/v1/leads?bloq_id=${BOARD_ID}&per_page=200&page=${pg}`,
          { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' } }
        );
        if (!res.ok) break;
        const data = await res.json();
        const leads = data.data?.data || data.data || [];
        for (const l of leads) {
          const name = (l.name || l.full_name || '').trim();
          const contactInfo = typeof l.contact_info === 'string' ? JSON.parse(l.contact_info || '{}') : (l.contact_info || {});
          const phone = contactInfo.phone || contactInfo.whatsapp || l.phone || '';
          const igHandle = name.startsWith('@') ? name.slice(1) : name;
          boardLeads.push({ id: l.id, name, phone, igHandle });
        }
        if (leads.length < 200) break;
      }
      console.log(`Loaded ${boardLeads.length} leads from board ${BOARD_ID}`);
    } catch (err: any) {
      console.log(`API error: ${err.message}`);
    }

    if (boardLeads.length === 0) {
      console.log('No leads found on board — nothing to match against.');
      return;
    }

    // Build phone lookup map (last 10 digits -> lead)
    const phoneMap = new Map<string, typeof boardLeads[0]>();
    for (const lead of boardLeads) {
      if (lead.phone) {
        const normalized = normalizePhone(lead.phone);
        if (normalized.length >= 7) phoneMap.set(normalized, lead);
      }
    }
    console.log(`Phone lookup map: ${phoneMap.size} leads with phone numbers`);

    // ── Scan inbox ──
    console.log(`\nScanning WhatsApp inbox (limit: ${LIMIT} conversations)...`);
    const provider = new WhatsAppInboxProvider();
    const inboxResult = await provider.discover(page, context, {
      targetUrl: 'https://web.whatsapp.com/',
      limit: LIMIT,
      scrollAttempts: 20,
      scrollDelay: 3000,
    });

    console.log(`\nInbox scan complete: ${inboxResult.profiles.length} conversations read`);
    if (inboxResult.errors.length > 0) {
      console.log(`Errors: ${inboxResult.errors.join(', ')}`);
    }

    // ── Detect replies ──
    const taggedLeads: { name: string; leadId: number; contact: string; lastMsg: string }[] = [];
    const unmatched: { contact: string; phone: string; lastMsg: string }[] = [];
    let alreadyTaggedCount = 0;

    for (const profile of inboxResult.profiles) {
      const contactName = profile.displayName || profile.username || '';
      const contactPhone = profile.rawMetadata?.phoneNumber || '';
      const fullMessages = profile.rawMetadata?.fullMessages || '';
      const lastMessage = profile.rawMetadata?.lastMessage || '';

      let isReply = false;

      if (fullMessages) {
        const lines = fullMessages.split('\n').filter(Boolean);
        const lastLine = lines[lines.length - 1] || '';
        const senderMatch = lastLine.match(/^(.+?):\s/);
        const lastSender = senderMatch?.[1]?.trim() || '';

        if (lastLine.startsWith('them:') || lastLine.startsWith('them :')) {
          isReply = true;
        } else if (lastSender && lastSender !== 'me') {
          isReply = true;
        }
      } else if (lastMessage) {
        const lower = lastMessage.toLowerCase();
        // WhatsApp group last messages have sender prefix: "~Name: message"
        if (!lower.startsWith('you:') && !lower.startsWith('me:')) {
          isReply = true;
        }
      }

      if (!isReply) continue;

      // Match by phone first, then name fallback
      let matchedLead: typeof boardLeads[0] | undefined;

      if (contactPhone) {
        const normalized = normalizePhone(contactPhone);
        matchedLead = phoneMap.get(normalized);
      }

      if (!matchedLead) {
        // Name-based matching
        matchedLead = boardLeads.find(lead =>
          nameMatch(lead.name, contactName) ||
          nameMatch(lead.igHandle, contactName) ||
          (contactPhone && lead.phone && phoneMatch(contactPhone, lead.phone))
        );
      }

      // API search fallback
      if (!matchedLead && (contactName || contactPhone)) {
        const searchTerm = contactPhone || contactName;
        for (const scope of [`bloq_id=${BOARD_ID}&`, '']) {
          if (matchedLead) break;
          try {
            const searchRes = await fetch(
              `${API_BASE}/api/v1/leads?${scope}search=${encodeURIComponent(searchTerm)}&per_page=1`,
              { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' } }
            );
            if (searchRes.ok) {
              const searchData = await searchRes.json();
              const results = searchData.data?.data || searchData.data || [];
              if (results.length > 0) {
                matchedLead = { id: results[0].id, name: results[0].name || '', phone: '', igHandle: '' };
              }
            }
          } catch {}
        }
      }

      if (!matchedLead) {
        unmatched.push({
          contact: contactName,
          phone: contactPhone,
          lastMsg: (lastMessage || fullMessages || '').substring(0, 80),
        });
        continue;
      }

      // Check if already tagged
      try {
        const detailRes = await fetch(
          `${API_BASE}/api/v1/leads/${matchedLead.id}`,
          { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' } }
        );
        if (detailRes.ok) {
          const detail = await detailRes.json();
          const notes = detail.data?.notes || [];
          const alreadyTagged = notes.some((n: any) => {
            const msg = (n.message || n.content || '').toLowerCase();
            return msg.includes('[inbox reply]') || msg.includes('[replied]');
          });
          if (alreadyTagged) {
            alreadyTaggedCount++;
            continue;
          }
        }
      } catch {}

      const preview = (lastMessage || fullMessages || '').substring(0, 100);
      console.log(`\n  REPLY: ${contactName} -> Lead #${matchedLead.id} (${matchedLead.name})`);
      console.log(`    "${preview}"`);

      if (DRY_RUN) {
        console.log(`    [DRY RUN] Would tag lead #${matchedLead.id}`);
        taggedLeads.push({ name: matchedLead.name, leadId: matchedLead.id, contact: contactName, lastMsg: preview });
        continue;
      }

      try {
        const noteRes = await fetch(
          `${API_BASE}/api/v1/leads/${matchedLead.id}/notes`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${TOKEN}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({
              message: `[inbox reply] WA reply from ${contactName}${contactPhone ? ` (${contactPhone})` : ''}: "${preview}"`,
              type: 'system',
            }),
          }
        );
        if (noteRes.ok) {
          console.log(`    Tagged lead #${matchedLead.id}`);
          taggedLeads.push({ name: matchedLead.name, leadId: matchedLead.id, contact: contactName, lastMsg: preview });
        } else {
          console.log(`    Tag failed: ${noteRes.status}`);
        }
      } catch (err: any) {
        console.log(`    Tag error: ${err.message}`);
      }

      // ── Self-enrich: if we have a phone from WA but lead has none, add enrichment note ──
      if (contactPhone && matchedLead.phone === '') {
        const enrichMsg = `[wa-enrich] WhatsApp phone detected: ${contactPhone} (from conversation with "${contactName}"). Run \`iris leads update ${matchedLead.id} --phone ${contactPhone}\` to confirm.`;
        if (!DRY_RUN) {
          try {
            await fetch(`${API_BASE}/api/v1/leads/${matchedLead.id}/notes`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({ message: enrichMsg, type: 'system' }),
            });
            console.log(`    Enrichment note added (phone: ${contactPhone})`);
          } catch {}
        } else {
          console.log(`    [DRY RUN] Would add enrichment note: phone ${contactPhone}`);
        }
      }
    }

    // ── Summary ──
    console.log('\n' + '='.repeat(60));
    console.log(DRY_RUN ? '  DRY RUN COMPLETE' : '  WHATSAPP INBOX CHECK COMPLETE');
    console.log('='.repeat(60));
    console.log(`  Account: ${WA_ACCOUNT}`);
    console.log(`  Board: ${BOARD_ID}`);
    console.log(`  Conversations scanned: ${inboxResult.profiles.length}`);
    console.log(`  Replies detected: ${taggedLeads.length}`);
    console.log(`  Already tagged: ${alreadyTaggedCount}`);
    console.log(`  Unmatched replies: ${unmatched.length}`);
    if (taggedLeads.length > 0) {
      console.log(`\n  ${DRY_RUN ? 'Would tag' : 'Tagged'} ${taggedLeads.length} leads:`);
      for (const t of taggedLeads) {
        console.log(`    - ${t.name} (#${t.leadId}) via ${t.contact}`);
      }
    }
    if (unmatched.length > 0) {
      console.log(`\n  Unmatched conversations with replies (not on board):`);
      for (const u of unmatched.slice(0, 10)) {
        const phoneTag = u.phone ? ` [phone: ${u.phone}]` : '';
        console.log(`    - ${u.contact}${phoneTag}: "${u.lastMsg}"`);
      }
      if (unmatched.length > 10) console.log(`    ... and ${unmatched.length - 10} more`);
      console.log(`\n  Tip: Use \`iris leads search "<name>"\` to find + link these contacts.`);
    }
    console.log('='.repeat(60));

    // ── Sync to inbox-sync API ──
    if (!DRY_RUN && inboxResult.profiles.length > 0) {
      const conversations = inboxResult.profiles.map(profile => {
        const contactName = profile.displayName || profile.username || '';
        const contactPhone = profile.rawMetadata?.phoneNumber || '';
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
            const isMe = sender === 'me';
            if (!isMe) replied = true;
            messages.push({ sender: isMe ? 'me' : sender, body, timestamp });
          }
        }

        // Use phone or name as the handle for matching
        const handle = contactPhone || contactName;
        return { handle, replied, messages };
      }).filter(c => c.messages.length > 0);

      if (conversations.length > 0) {
        try {
          const syncRes = await fetch(`${API_BASE}/api/v1/leads/inbox-sync`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${TOKEN}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({
              conversations,
              board_id: BOARD_ID,
              account: WA_ACCOUNT,
              platform: 'whatsapp',
            }),
          });
          if (syncRes.ok) {
            const syncData = await syncRes.json();
            console.log(`\n  Inbox sync: ${syncData.stats?.new_messages || 0} new messages stored, ${syncData.stats?.replied || 0} leads marked replied`);
          } else {
            console.log(`\n  Inbox sync failed: ${syncRes.status}`);
          }
        } catch (err: any) {
          console.log(`\n  Inbox sync error: ${err.message}`);
        }
      }
    }

    if (!DRY_RUN && (taggedLeads.length > 0 || unmatched.length > 0)) {
      let alertMsg = '';
      if (taggedLeads.length > 0) {
        const tagLines = taggedLeads.slice(0, 10).map(t =>
          `  - **${t.name}** (#${t.leadId}) -- ${t.contact}`
        ).join('\n');
        alertMsg += `**WA Inbox Check -- ${taggedLeads.length} Replies Found**\n` +
          `Account: \`${WA_ACCOUNT}\` | Board: \`${BOARD_ID}\`\n${tagLines}`;
      }
      if (unmatched.length > 0) {
        const unmatchedWithPhones = unmatched.filter(u => u.phone);
        if (unmatchedWithPhones.length > 0) {
          const unmLines = unmatchedWithPhones.slice(0, 5).map(u =>
            `  - ${u.contact} (${u.phone})`
          ).join('\n');
          alertMsg += `\n\n**Unmatched contacts with phone numbers** (run \`iris leads search\` to link):\n${unmLines}`;
        }
      }
      if (alertMsg) await sendDiscordAlert(alertMsg);
    }
  } finally {
    await context.close();
    // Clean up extracted temp directory if we unpacked an archive
    if (resolved.cleanup && fs.existsSync(SESSION_DIR)) {
      try { fs.rmSync(SESSION_DIR, { recursive: true }); } catch {}
    }
  }
});
