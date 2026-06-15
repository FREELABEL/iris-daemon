import { test } from '@playwright/test';
import { LeadgenApiClient } from './helpers/leadgen-api-client';
import { InstagramInboxProvider } from './helpers/providers/instagram-inbox-provider';
import { InstagramDmProvider } from './helpers/providers/instagram-dm-provider';
import * as fs from 'fs';
import * as path from 'path';

// ── CONFIG ──────────────────────────────────────────────────────────
const TOKEN = process.env.HEYIRIS_TOKEN || 'ca54cd87e7046098eee99de3b9c98cfd';
const BOARD_ID = parseInt(process.env.BOARD_ID || '38', 10);
const LIMIT = parseInt(process.env.LIMIT || '30', 10);
const IG_ACCOUNT = process.env.IG_ACCOUNT || 'heyiris.io';
const SINCE = process.env.SINCE || '24h';
const WRITE_BACK = process.env.WRITE_BACK === '1' || process.env.WRITE_BACK === 'true';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
// Scripted auto-reply: send the next outreach-strategy step when a lead replies.
// OFF by default — the responder always PREVIEWS the next-step text (for audit),
// and only actually sends when SEND_REPLIES=1 AND not a dry run.
const SEND_REPLIES = process.env.SEND_REPLIES === '1' || process.env.SEND_REPLIES === 'true';
const SEND_CAP = parseInt(process.env.SEND_CAP || '40', 10); // per-account safety cap per run
const USER_ID = parseInt(process.env.USER_ID || '193', 10);

const IG_AUTH_FILE = path.join(__dirname, `instagram-auth-${IG_ACCOUNT}.json`);
const IG_AUTH_LEGACY = path.join(__dirname, 'instagram-auth.json');

// ── HELPERS ─────────────────────────────────────────────────────────

/** Parse "24h", "48h", "7d", "2w" → milliseconds */
function parseSince(since: string): number {
  const match = since.match(/^(\d+)(h|d|w)$/i);
  if (!match) return 24 * 60 * 60 * 1000; // default 24h
  const num = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = { h: 3600000, d: 86400000, w: 604800000 };
  return num * (multipliers[unit] || 3600000);
}

/** Format ms duration as human-readable */
function formatAge(ms: number): string {
  if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h ago`;
  return `${Math.round(ms / 86400000)}d ago`;
}

/**
 * Parse a message line like "SenderName: message text [2026-03-24T14:30:00.000Z]"
 * Returns { sender, body, timestamp } or null if unparseable.
 */
function parseMessageLine(line: string): { sender: string; body: string; timestamp: string | null } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Extract sender (everything before first ": ")
  const colonIdx = trimmed.indexOf(': ');
  if (colonIdx < 1) return null;

  const sender = trimmed.substring(0, colonIdx).trim();
  let rest = trimmed.substring(colonIdx + 2);

  // Extract optional timestamp in brackets at the end
  let timestamp: string | null = null;
  const tsMatch = rest.match(/\s*\[([^\]]+)\]\s*$/);
  if (tsMatch) {
    timestamp = tsMatch[1];
    rest = rest.substring(0, rest.length - tsMatch[0].length);
  }

  return { sender, body: rest.trim(), timestamp };
}

/**
 * Check if a sender name matches our IG account (i.e., it's us, not a reply).
 * Compares against the account handle and common display name variations.
 */
function isOurMessage(senderName: string, igAccount: string, messageBody?: string): boolean {
  const lower = senderName.toLowerCase().replace(/[._]/g, '');
  const acctLower = igAccount.toLowerCase().replace(/[._]/g, '');
  // Exact match on normalized name
  if (lower === acctLower) return true;
  // Account handle appears within the sender name
  if (lower.includes(acctLower) || acctLower.includes(lower)) return true;

  // Content-based detection: if the message matches our outreach scripts, it's us.
  // Instagram shows display names (not handles) as senders, so handle comparison
  // fails when display name doesn't match handle (e.g. "Alexander Mayo" vs "hourdemayo").
  if (messageBody) {
    const body = messageBody.toLowerCase();
    const ourScriptStarts = [
      "i saw you're building with ai",
      "i saw you're pretty deep in the ai",
      "your sound is fire",
      "i built a platform",
      "we're organizing live showcases",
      "we're putting together a network",
      "hey! i came across your",
      "i noticed you're into",
      "bet — here's the quick rundown",
    ];
    for (const start of ourScriptStarts) {
      if (body.startsWith(start) || body.includes(start.substring(0, 30))) return true;
    }
  }

  return false;
}

// Hard opt-out / decline — these ALWAYS pause the sequence (never auto-reply).
const HARD_OPTOUT_RE = /\b(no thanks|not interested|stop|unsubscribe|don't message|dont message|leave me alone|nah i'm good|nah im good|pass|no thank you|remove me)\b/i;

export interface NextStep {
  id: number;
  order: number;
  title: string;
  instructions: string;
}

/**
 * Resolve the next scripted message to send for a lead, given their outreach
 * steps (from getSteps). Returns the first PENDING step that is an Instagram
 * message with non-empty text — i.e. the literal next line of the strategy
 * script. Returns null when the next pending step is a non-Instagram channel,
 * an empty action step (e.g. "Organic Interactions"), or the script is done.
 */
function resolveNextStep(steps: any[]): NextStep | null {
  const pending = (steps || [])
    .filter((s) => !s.is_completed)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (pending.length === 0) return null;

  const first = pending[0];
  const type = (first.type || 'instagram').toLowerCase();
  const instructions = (first.instructions || '').trim();
  if (type !== 'instagram' && type !== 'ig') return null; // next step is another channel
  if (!instructions) return null; // action-only step (no message to send)

  return { id: first.id, order: first.order ?? 0, title: first.title || `step ${first.order ?? 0}`, instructions };
}

// ── TYPES ───────────────────────────────────────────────────────────

interface MatchedLead {
  handle: string;
  leadId: number;
  leadName: string;
  status: 'replied' | 'no-response';
  replyMessages: { sender: string; body: string; timestamp: string | null }[];
  replyAge: string; // human-readable age of most recent reply
  tagIds: number[];
  nextStep?: NextStep | null; // resolved scripted reply (preview pass)
  optOut?: boolean;           // hard opt-out detected → never auto-reply
}

interface UnmatchedConvo {
  handle: string;
  displayName: string;
  lastMessage: string;
}

// ── TEST ────────────────────────────────────────────────────────────

test(`Inbox Follow-up — Board ${BOARD_ID} / @${IG_ACCOUNT}`, async ({ page, context }) => {
  const startTime = Date.now();
  const sinceCutoff = Date.now() - parseSince(SINCE);

  // ── AUTH (Instagram) ── load saved session cookies
  const igFile = fs.existsSync(IG_AUTH_FILE) ? IG_AUTH_FILE
    : fs.existsSync(IG_AUTH_LEGACY) ? IG_AUTH_LEGACY : null;
  if (igFile) {
    const state = JSON.parse(fs.readFileSync(igFile, 'utf-8'));
    if (state.cookies && state.cookies.length > 0) {
      await context.addCookies(state.cookies);
      console.log(`✓ Instagram session loaded for @${IG_ACCOUNT} (${state.cookies.length} cookies)`);
    }
  } else {
    console.log(`⚠ No Instagram session file found for @${IG_ACCOUNT}`);
    console.log(`  Run: npx playwright test tests/e2e/save-instagram-session.spec.ts --headed`);
    return;
  }

  // ── PHASE 1: Fetch leads & scan inbox ──

  console.log(`\n📋 Board: ${BOARD_ID} | Account: @${IG_ACCOUNT} | Since: ${SINCE}`);
  console.log(`   Write-back: ${WRITE_BACK ? 'ON' : 'OFF'} | Limit: ${LIMIT}\n`);

  const apiClient = new LeadgenApiClient(TOKEN, BOARD_ID);

  // Fetch lead map
  console.log('📊 Fetching lead map...');
  const leadMap = await apiClient.getLeadMapFull();
  console.log(`   ${leadMap.size} leads indexed\n`);

  // Scan inbox
  console.log('📬 Scanning Instagram inbox...');
  const provider = new InstagramInboxProvider();
  const result = await provider.discover(page, context, {
    targetUrl: 'https://www.instagram.com/direct/inbox/',
    limit: LIMIT,
    scrollAttempts: Math.ceil(LIMIT / 10) + 3,
    scrollDelay: 2000,
  });
  console.log(`   ${result.profiles.length} conversations scanned (${Math.round(result.durationMs / 1000)}s)\n`);

  // ── PHASE 1: Cross-reference & classify ──

  const replied: MatchedLead[] = [];
  const noResponse: MatchedLead[] = [];
  const unmatched: UnmatchedConvo[] = [];

  for (const profile of result.profiles) {
    const handle = (profile.username || profile.displayName || '').toLowerCase().replace(/^@/, '');
    if (!handle) continue;

    // Try to find in lead map
    const leadInfo = leadMap.get(handle);

    if (!leadInfo) {
      unmatched.push({
        handle,
        displayName: profile.displayName || handle,
        lastMessage: profile.rawMetadata?.lastMessage || '',
      });
      continue;
    }

    // Parse messages to find replies (messages NOT from our account)
    const fullMessages = profile.rawMetadata?.fullMessages || '';
    const lines = fullMessages.split('\n').filter(Boolean);
    const replyMessages: { sender: string; body: string; timestamp: string | null }[] = [];

    for (const line of lines) {
      const parsed = parseMessageLine(line);
      if (!parsed) continue;
      if (isOurMessage(parsed.sender, IG_ACCOUNT, parsed.body)) continue;

      // Check timestamp against `since` cutoff if we have one
      if (parsed.timestamp) {
        const ts = new Date(parsed.timestamp).getTime();
        if (!isNaN(ts) && ts < sinceCutoff) continue; // too old
      }

      replyMessages.push(parsed);
    }

    const entry: MatchedLead = {
      handle,
      leadId: leadInfo.id,
      leadName: leadInfo.name,
      status: replyMessages.length > 0 ? 'replied' : 'no-response',
      replyMessages,
      replyAge: '',
      tagIds: leadInfo.tagIds,
    };

    // Compute age of most recent reply
    if (replyMessages.length > 0) {
      const lastReply = replyMessages[replyMessages.length - 1];
      if (lastReply.timestamp) {
        const ts = new Date(lastReply.timestamp).getTime();
        if (!isNaN(ts)) entry.replyAge = formatAge(Date.now() - ts);
      }
    }

    if (entry.status === 'replied') replied.push(entry);
    else noResponse.push(entry);
  }

  // ── PRINT REPORT ──

  console.log('');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log('  ║  INBOX FOLLOW-UP REPORT                          ║');
  console.log('  ╚══════════════════════════════════════════════════╝');
  console.log(`  Board: ${BOARD_ID}  |  Account: @${IG_ACCOUNT}  |  Since: ${SINCE}`);
  console.log('');

  if (replied.length > 0) {
    console.log(`  REPLIED (${replied.length}):`);
    for (const lead of replied) {
      const lastReply = lead.replyMessages[lead.replyMessages.length - 1];
      const preview = lastReply ? `"${lastReply.body.substring(0, 45)}${lastReply.body.length > 45 ? '...' : ''}"` : '';
      const age = lead.replyAge ? `  ${lead.replyAge}` : '';
      console.log(`    @${lead.handle.padEnd(20)} Lead #${lead.leadId}  ${preview}${age}`);
    }
    console.log('');
  }

  if (noResponse.length > 0) {
    console.log(`  NO RESPONSE (${noResponse.length}):`);
    for (const lead of noResponse) {
      console.log(`    @${lead.handle.padEnd(20)} Lead #${lead.leadId}`);
    }
    console.log('');
  }

  if (unmatched.length > 0) {
    console.log(`  NOT ON BOARD (${unmatched.length}):`);
    for (const convo of unmatched) {
      console.log(`    @${convo.handle.padEnd(20)} (no lead record)`);
    }
    console.log('');
  }

  console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Replied: ${replied.length}  |  No Response: ${noResponse.length}  |  Unmatched: ${unmatched.length}`);
  console.log(`  Total: ${Math.round((Date.now() - startTime) / 1000)}s`);
  console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  // ── DISCORD NOTIFICATIONS ──
  const discordWebhook = process.env.DISCORD_TASK_WEBHOOK_URL ||
    process.env.PLATFORM_UPDATES_DISCORD_CHANNEL_WEBHOOK_URL ||
    'https://discord.com/api/webhooks/1473938540139253834/XXWsRliRH7keLMEKrlnCcPPriR-iniyUhfCZU9MubNBBoZESBOLgvl8GqBAwYdajiEp7';

  // Always send scan summary (even with 0 replies)
  try {
    const scanDuration = Math.round((Date.now() - startTime) / 1000);
    const summaryEmbed = {
      title: replied.length > 0
        ? `📬 Inbox Scan — ${replied.length} ${replied.length === 1 ? 'Reply' : 'Replies'}`
        : `📬 Inbox Scan — No New Replies`,
      color: replied.length > 0 ? 0x10B981 : 0x6B7280,
      fields: [
        { name: 'Replied', value: `${replied.length}`, inline: true },
        { name: 'No Response', value: `${noResponse.length}`, inline: true },
        { name: 'Unmatched', value: `${unmatched.length}`, inline: true },
        { name: 'Account', value: `@${IG_ACCOUNT}`, inline: true },
        { name: 'Conversations', value: `${result.profiles.length}`, inline: true },
        { name: 'Duration', value: `${scanDuration}s`, inline: true },
      ],
      footer: { text: `Board ${BOARD_ID}` },
      timestamp: new Date().toISOString(),
    };
    await fetch(discordWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'SOM Inbox', embeds: [summaryEmbed] }),
    });
    console.log('  Discord scan summary sent');
  } catch (err: any) {
    console.log(`  Discord scan summary failed: ${err.message}`);
  }

  if (replied.length > 0) {
    console.log('  Sending Discord notifications...');
    const fields = replied.slice(0, 10).map(lead => {
      const lastReply = lead.replyMessages[lead.replyMessages.length - 1];
      const preview = lastReply ? lastReply.body.substring(0, 100) : '';
      const crmLink = `https://web.freelabel.net/iris?boardId=${BOARD_ID}&tab=leads&lead=${lead.leadId}`;
      const igLink = `https://instagram.com/${lead.handle}`;
      return {
        name: `@${lead.handle}`,
        value: (preview ? `"${preview}"` : '(replied)') + `\n[View Lead](${crmLink}) · [Open IG](${igLink})`,
        inline: false,
      };
    });

    // Count classifications for summary
    const classificationCounts: Record<string, number> = {};
    for (const lead of replied) {
      const rt = lead.replyMessages.map((m: any) => m.body).join(' ').toLowerCase();
      const hasEmail = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(rt);
      const hasPhone = /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/.test(rt);
      const isPositive = /\b(yes|yea|yeah|bet|lets do it|let's do it|i'm down|im down|interested|for sure|send it|send me|down|absolutely|fasho)\b/i.test(rt);
      const cls = hasEmail ? 'Qualified (email)' : hasPhone ? 'Qualified (phone)' : isPositive ? 'Interested' : 'Follow Up';
      classificationCounts[cls] = (classificationCounts[cls] || 0) + 1;
    }
    const classLine = Object.entries(classificationCounts).map(([k, v]) => `${v} ${k}`).join(', ');

    const embed = {
      title: `🔥 ${replied.length} DM ${replied.length === 1 ? 'Reply' : 'Replies'} — @${IG_ACCOUNT}`,
      description: `Auto-triaged: ${classLine}\nOutreach steps completed. Respond manually in IG DMs.`,
      color: 0x10B981,
      fields,
      footer: { text: `SOM Inbox Scan` },
      timestamp: new Date().toISOString(),
    };

    try {
      const res = await fetch(discordWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'SOM Inbox', embeds: [embed] }),
      });
      console.log(`  Discord notification sent (${res.status})`);
    } catch (err: any) {
      console.log(`  Discord notification failed: ${err.message}`);
    }
  }

  // ── SCRIPTED REPLY PREVIEW (always runs — this is the audit view) ──
  // For each replied lead, resolve the next outreach-strategy step and print
  // the exact message that would be sent. Runs in every mode so the next-step
  // text can be reviewed without writing or sending anything. Results are
  // stashed on each lead for reuse by the write-back send phase below.
  if (replied.length > 0) {
    console.log('  ── SCRIPTED REPLIES ──');
    console.log(`  Mode: ${SEND_REPLIES && !DRY_RUN ? 'SEND (live)' : 'PREVIEW (no send)'}`);
    for (const lead of replied) {
      const replyText = lead.replyMessages.map((m) => m.body).join(' ');
      if (HARD_OPTOUT_RE.test(replyText)) {
        lead.optOut = true;
        console.log(`    @${lead.handle} — opt-out detected → will pause sequence (no auto-reply)`);
        continue;
      }
      let steps: any[] = [];
      try { steps = await apiClient.getSteps(lead.leadId); } catch { steps = []; }
      const next = resolveNextStep(steps);
      lead.nextStep = next;
      if (!next) {
        console.log(`    @${lead.handle} — no scripted step to send (script complete or next step is another channel)`);
        continue;
      }
      const preview = next.instructions.replace(/\n+/g, ' ⏎ ');
      const clipped = preview.length > 140 ? preview.substring(0, 140) + '…' : preview;
      console.log(`    @${lead.handle} → step ${next.order} "${next.title}": "${clipped}"`);
    }
    console.log('');
  }

  // ── PHASE 2: Write-back (notes + tags) ──

  if (!WRITE_BACK) {
    if (replied.length > 0) {
      console.log('  Tip: Run with wb=1 to add notes and tags to leads');
    }
    return;
  }

  if (DRY_RUN) {
    console.log('  [DRY RUN] Would write notes & tags — skipping');
    return;
  }

  console.log('  ── WRITE-BACK ──');

  // Resolve tags
  const tagDefs = [
    { name: 'DM Replied', color: '#10B981' },
    { name: 'No DM Response', color: '#EF4444' },
  ];
  const tagIds = await apiClient.resolveTags(USER_ID, tagDefs);
  const repliedTagId = tagIds[0];
  const noResponseTagId = tagIds[1];

  if (repliedTagId) console.log(`  ✓ Tag "DM Replied" → #${repliedTagId}`);
  if (noResponseTagId) console.log(`  ✓ Tag "No DM Response" → #${noResponseTagId}`);

  let notesAdded = 0;
  let tagsApplied = 0;
  let skippedDuplicates = 0;

  // Scripted-reply sender (reuses the proven outreach DM send path)
  const igDm = new InstagramDmProvider();
  let repliesSent = 0;
  let repliesFailed = 0;

  // Write notes for replied leads
  for (const lead of replied) {
    // Format reply content for note
    const replyText = lead.replyMessages
      .map(m => `${m.sender}: ${m.body}`)
      .join('\n');
    const today = new Date().toISOString().slice(0, 10);
    const noteContent = `[DM Reply] @${lead.handle} replied via Instagram DM:\n---\n${replyText}\n---\nScanned: ${today}`;

    // Check for duplicate notes
    const replyPreview = lead.replyMessages[0]?.body.substring(0, 50) || '';
    const leadResp = await apiClient.getLead(lead.leadId);
    const existingNotes = leadResp.data?.data?.notes || leadResp.data?.notes || [];
    const hasDuplicate = Array.isArray(existingNotes) && existingNotes.some((n: any) =>
      (n.content || '').startsWith('[DM Reply]') && (n.content || '').includes(replyPreview)
    );

    if (hasDuplicate) {
      console.log(`    @${lead.handle} — note already exists, skipping`);
      skippedDuplicates++;
    } else {
      const noteResp = await apiClient.addNote(lead.leadId, noteContent, 'response');
      if (noteResp.success) {
        console.log(`    @${lead.handle} — note added ✓`);
        notesAdded++;
      } else {
        console.log(`    @${lead.handle} — note failed: ${noteResp.message}`);
      }
    }

    // Apply "DM Replied" tag (merge with existing)
    if (repliedTagId && !lead.tagIds.includes(repliedTagId)) {
      const mergedTags = [...new Set([...lead.tagIds, repliedTagId])];
      // Remove "No DM Response" tag if present
      const finalTags = noResponseTagId ? mergedTags.filter(id => id !== noResponseTagId) : mergedTags;
      await apiClient.updateLeadTags(lead.leadId, finalTags);
      tagsApplied++;
    }

    // Auto-triage: classify reply intent and update status accordingly
    const classifyText = lead.replyMessages.map((m: any) => m.body).join(' ').toLowerCase();

    // Classify the reply to determine pipeline stage
    let newStatus = 'Follow Up'; // default
    let classification = 'replied';
    const contactUpdate: Record<string, any> = {};

    // Check for email in reply → Qualified (they gave contact info)
    const emailMatch = classifyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (emailMatch) {
      newStatus = 'Qualified';
      classification = 'gave_email';
      contactUpdate.email = emailMatch[0];
      console.log(`    @${lead.handle} — email detected: ${emailMatch[0]}`);
    }

    // Check for phone number → Qualified
    const phoneMatch = classifyText.match(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/);
    if (phoneMatch && !emailMatch) {
      newStatus = 'Qualified';
      classification = 'gave_phone';
      contactUpdate.phone = phoneMatch[0];
      console.log(`    @${lead.handle} — phone detected: ${phoneMatch[0]}`);
    }

    // Check for positive intent → Interested
    const positivePatterns = /\b(yes|yea|yeah|bet|lets do it|let's do it|i'm down|im down|interested|for sure|send it|send me|sign me up|count me in|down|absolutely|hell yeah|fasho|fa sho)\b/i;
    if (positivePatterns.test(classifyText) && newStatus === 'Follow Up') {
      newStatus = 'Interested';
      classification = 'positive';
    }

    // Check for negative/decline → Not Interested
    const negativePatterns = /\b(no thanks|not interested|stop|unsubscribe|don't message|dont message|leave me alone|nah i'm good|nah im good|pass|no thank you|remove me)\b/i;
    if (negativePatterns.test(classifyText)) {
      newStatus = 'Not Interested';
      classification = 'declined';
    }

    // Update lead status + mark as replied (excludes from automated outreach sequences)
    try {
      const updateData: Record<string, any> = { status: newStatus, has_replied: true };
      // Save extracted contact info
      if (Object.keys(contactUpdate).length > 0) {
        updateData.contact_info = contactUpdate;
      }
      await apiClient.updateLead(lead.leadId, updateData);
      console.log(`    @${lead.handle} — status → ${newStatus} (${classification}), has_replied ✓`);
    } catch { /* best effort */ }

    // ── Scripted reply: advance the outreach sequence by ONE step ──
    if (lead.optOut) {
      // Hard opt-out → stop the sequence: complete all pending steps, no send.
      try {
        const steps = await apiClient.getSteps(lead.leadId);
        let stepsCompleted = 0;
        for (const step of steps) {
          if (!step.is_completed) {
            await apiClient.completeStep(lead.leadId, step.id);
            stepsCompleted++;
          }
        }
        if (stepsCompleted > 0) {
          console.log(`    @${lead.handle} — opt-out: ${stepsCompleted} step(s) completed, sequence stopped`);
        }
      } catch { /* best effort */ }
    } else if (SEND_REPLIES && lead.nextStep) {
      // Send the next scripted message, then complete exactly that one step.
      if (repliesSent >= SEND_CAP) {
        console.log(`    @${lead.handle} — send cap (${SEND_CAP}) reached, skipping send this run`);
      } else {
        const next = lead.nextStep;
        try {
          const res = await igDm.sendToHandle(page, lead.handle, next.instructions);
          if (res.delivered) {
            repliesSent++;
            console.log(`    @${lead.handle} — scripted reply sent (step ${next.order} "${next.title}") ✓`);
            // Advance exactly one step + record the DM (idempotent: re-runs send the NEXT step)
            try { await apiClient.completeStep(lead.leadId, next.id, process.env.STRATEGY); } catch { /* best effort */ }
            apiClient.recordDmSent(lead.leadId, {
              message: next.instructions,
              channel_account: IG_ACCOUNT,
              campaign_name: process.env.STRATEGY,
              bloq_id: BOARD_ID,
              ig_handle: lead.handle,
              step_index: next.order,
            }).catch(() => {});
            apiClient.addNote(lead.leadId, `[SOM AUTO-REPLY] Sent step ${next.order} "${next.title}" to @${lead.handle} via @${IG_ACCOUNT} (reply detected)`, 'outreach').catch(() => {});
            // Human-like pacing between sends
            await page.waitForTimeout(4000 + Math.random() * 6000);
          } else {
            repliesFailed++;
            console.log(`    @${lead.handle} — scripted reply NOT delivered: ${res.error}`);
            apiClient.addNote(lead.leadId, `[SOM FAIL] Auto-reply step ${next.order} to @${lead.handle} via @${IG_ACCOUNT} — ${res.error}`).catch(() => {});
          }
        } catch (err: any) {
          repliesFailed++;
          console.log(`    @${lead.handle} — scripted reply error: ${err.message}`);
        }
      }
    }
    // Note: when SEND_REPLIES is off we intentionally do NOT complete steps —
    // the lead stays at its current step so a future live run can resume it.
  }

  // Apply "No DM Response" tag to non-responders
  for (const lead of noResponse) {
    if (noResponseTagId && !lead.tagIds.includes(noResponseTagId) && !lead.tagIds.includes(repliedTagId)) {
      const mergedTags = [...new Set([...lead.tagIds, noResponseTagId])];
      await apiClient.updateLeadTags(lead.leadId, mergedTags);
      tagsApplied++;
    }
  }

  console.log('');
  console.log(`  ✓ Notes added: ${notesAdded}  |  Duplicates skipped: ${skippedDuplicates}  |  Tags applied: ${tagsApplied}`);
  console.log(`  ✓ Scripted replies — sent: ${repliesSent}  |  failed: ${repliesFailed}  |  send mode: ${SEND_REPLIES ? 'ON' : 'OFF'}`);
  console.log('');
});
