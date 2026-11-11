#!/usr/bin/env node
/**
 * Daily reply triage (#191273) — who wrote back, who is new, the five to answer first.
 *
 * Reads the log capture-replies.spec.ts appends after every live run (one JSON line per
 * account), summarises the last 24 hours, drafts an answer for each of the top five in the
 * voice of the account they wrote to, and emails it. It never sends a DM: the drafts are for
 * a person to approve and send.
 *
 *   node som/reply-digest.js                 # build + email
 *   DRY_RUN=1 node som/reply-digest.js       # build, write the HTML to ~/.iris/data, send nothing
 *
 * Env:
 *   CAPTURE_LOG        default ~/.iris/data/reply-capture.jsonl
 *   CAPTURE_ACCOUNTS   "heyiris.io:38,thediscoverpage_:80" — accounts expected to have been checked
 *   DIGEST_TO          default alex@freelabel.net
 *   DIGEST_FROM        default IRIS <team@heyiris.io>
 *   RESEND_KEY_FILE    default ~/.iris/keys/resend-newsletter.key
 *   OPENROUTER_API_KEY drafts; without it the email still goes, with no drafts
 *   DIGEST_MODEL       default openai/gpt-4o-mini
 *   NO_REPLY_FILE      default ~/.iris/data/no-reply-latest.json — the gone-quiet list (som/no-reply.js, #192438)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { inboundKind } = require('./no-reply');

const DAY_MS = 24 * 60 * 60 * 1000;

/** What each account is for, so a draft sounds like the account it answers from. */
const VOICES = {
  'heyiris.io': 'You are IRIS (heyiris.io), an AI workspace people hand whole projects to. The offer: download IRIS free at heyiris.io and upgrade later. Mention the link only if they asked for it or said yes.',
  freelabelnet: 'You are FREELABEL, scouting independent artists and creative talent to feature. The offer: get featured, and a free Creator OS account (the "Signed" plan) to run their music career. Ask about their work before pitching.',
  thediscoverpage_: 'You are The Discover Page, an account that features creators and new things worth seeing. Be friendly and curious; keep it about them.',
};

// ── pure: parse + summarise ───────────────────────────────────────────

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

/**
 * What came back since our last message in a thread: 'reaction' when every line of theirs since
 * then is a reaction (a heart, no words), 'system' when it is only an Instagram notice, else 'reply'.
 */
function sinceOurLast(thread) {
  const recent = thread.recent || [];
  let i = recent.length - 1;
  while (i >= 0 && !/^me: /.test(recent[i])) i--;
  const kinds = recent.slice(i + 1).map(l => inboundKind(l.replace(/^[^:]+: /, '').replace(/\s*\[[^\]]+\]\s*$/, '')));
  if (!kinds.length || kinds.includes('reply')) return 'reply';
  return kinds.includes('reaction') ? 'reaction' : 'system';
}

/**
 * Summarise capture runs for a window ending at `now`.
 * - waiting: per account, the LATEST run's threads whose newest message is theirs
 *   (state now, not a sum of every run), newest first.
 * - reacted: threads where all they did since our last message is react — nothing to answer,
 *   but they saw it and liked it, so they get a nudge instead. System notices are dropped.
 * - newPeople: every lead created from a reply inside the window, once.
 * - notChecked: expected accounts with no successful run inside the window.
 */
function summarise(entries, { now = Date.now(), windowMs = DAY_MS, expected = [] } = {}) {
  const inWindow = entries.filter(e => now - Date.parse(e.at) <= windowMs && Date.parse(e.at) <= now);
  const latest = new Map();
  for (const e of inWindow) {
    const prev = latest.get(e.account);
    if (!prev || Date.parse(e.at) > Date.parse(prev.at)) latest.set(e.account, e);
  }

  const waiting = [];
  const reacted = [];
  for (const run of latest.values()) {
    for (const t of run.threads || []) {
      if (!t.waitingOnUs) continue;
      const kind = sinceOurLast(t);
      if (kind === 'system') continue;
      (kind === 'reaction' ? reacted : waiting).push({ ...t, account: run.account, boardId: run.boardId });
    }
  }
  const newest = (a, b) => Date.parse(b.lastActivityAt || 0) - Date.parse(a.lastActivityAt || 0);
  waiting.sort(newest);
  reacted.sort(newest);

  const seenNew = new Set();
  const newPeople = [];
  for (const e of inWindow) {
    for (const l of e.createdLeads || []) {
      const key = String(l.handle || l.id).toLowerCase();
      if (seenNew.has(key)) continue;
      seenNew.add(key);
      newPeople.push({ ...l, account: e.account });
    }
  }

  const repliedToday = waiting.filter(t => now - Date.parse(t.lastActivityAt || 0) <= windowMs).length;
  const notChecked = expected.filter(a => !latest.has(a));
  const runs = inWindow.length;
  const read = [...latest.values()].reduce((n, e) => n + (e.read || 0), 0);

  return { waiting, reacted, newPeople, repliedToday, notChecked, runs, read, accounts: [...latest.keys()] };
}

/** "3 h", "2 d" — how long someone has been waiting. */
function waited(lastActivityAt, now = Date.now()) {
  const ms = now - Date.parse(lastActivityAt || 0);
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 3600e3) return `${Math.max(1, Math.round(ms / 60e3))} min`;
  if (ms < DAY_MS) return `${Math.round(ms / 3600e3)} h`;
  return `${Math.round(ms / DAY_MS)} d`;
}

/** Their newest line, without the "<handle>: " prefix and the [timestamp] suffix. */
function lastTheirLine(thread) {
  const lines = (thread.recent || []).filter(l => !/^me: /.test(l));
  const last = lines[lines.length - 1] || '';
  return last.replace(/^[^:]+: /, '').replace(/\s*\[[^\]]+\]\s*$/, '').trim();
}

/**
 * The gone-quiet list written by no-reply.js. Missing or older than `maxAgeMs` → { stale: true }
 * so the email says it was not refreshed instead of showing yesterday's numbers as today's.
 */
function loadQuiet(file, { now = Date.now(), maxAgeMs = 36 * 3600e3, nudgeAfterDays = 3 } = {}) {
  if (!file || !fs.existsSync(file)) return { stale: true, reason: 'not built' };
  let j; try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { stale: true, reason: 'unreadable' }; }
  const age = now - Date.parse(j.summary?.generated_at || 0);
  if (!Number.isFinite(age) || age > maxAgeMs) return { stale: true, reason: `last built ${j.summary?.generated_at || 'never'}` };
  // warmest first: people who talked to us once, most recently silent first — but give them
  // NUDGE_AFTER_DAYS to answer before suggesting a nudge
  // reacted (saw it, liked it) before went-quiet (talked once), then most recently silent first
  const rank = { reacted: 0, 'went-quiet': 1 };
  const warm = (j.rows || []).filter(r => r.kind in rank && r.days_silent >= nudgeAfterDays).sort((a, b) => rank[a.kind] - rank[b.kind] || a.days_silent - b.days_silent);
  return { stale: false, summary: j.summary, warm, file };
}

function subjectLine(s) {
  const parts = [`${s.waiting.length} waiting on you`];
  if (s.reacted?.length) parts.push(`${s.reacted.length} reacted`);
  if (s.newPeople.length) parts.push(`${s.newPeople.length} new ${s.newPeople.length === 1 ? 'person' : 'people'}`);
  if (s.notChecked.length) parts.push(`${s.notChecked.length} account${s.notChecked.length === 1 ? '' : 's'} not checked`);
  if (s.quiet && !s.quiet.stale) parts.push(`${s.quiet.summary.silent} gone quiet`);
  return `Inbox triage: ${parts.join(' · ')}`;
}

// ── drafts ────────────────────────────────────────────────────────────

/** They reacted, so they liked it — the nudge turns that into a first step (outreach rule 2026-10-30). */
const REACTION_NUDGE = 'They only reacted to our message, so there is nothing to answer. Do not mention the reaction or thank them for it. Suggest ONE concrete first thing they could hand to IRIS for what they do, and end with the plain link heyiris.io (no https, no tracking).';

async function draftReply(thread, { apiKey, model, fetchImpl = fetch } = {}) {
  if (!apiKey) return '';
  const voice = VOICES[thread.account] || VOICES.thediscoverpage_;
  const convo = (thread.recent || []).map(l => l.replace(/\s*\[[^\]]+\]\s*$/, '').replace(/^me: /, 'US: ').replace(/^[^:]+: /, m => (m === 'US: ' ? m : 'THEM: ')).replace(/\[reaction[a-z_]*\]/gi, '(reacted to our message, no words)')).join('\n');
  const res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.6,
      max_tokens: 120,
      messages: [
        { role: 'system', content: `${voice}\n${sinceOurLast(thread) === 'reaction' ? REACTION_NUDGE + '\n' : ''}Write ONE Instagram DM reply to the last THEM message: 1–2 short sentences, answer what they actually said, no hashtags, no emojis unless they used one, no numbers or claims you were not given. Reply with the message text only.` },
        { role: 'user', content: convo || 'THEM: (no text)' },
      ],
    }),
  });
  if (!res.ok) return '';
  const j = await res.json().catch(() => null);
  return String(j?.choices?.[0]?.message?.content || '').trim().replace(/^["']|["']$/g, '');
}

// ── render ────────────────────────────────────────────────────────────

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderEmail(s, drafts = {}, now = Date.now()) {
  const top = s.waiting.slice(0, 5);
  const rest = s.waiting.slice(5);
  const mono = "ui-monospace,'SF Mono',Menlo,Consolas,monospace";
  const sans = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
  const card = t => `
    <tr><td style="padding:0 0 14px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#141414;border:1px solid #262626;border-radius:12px">
        <tr><td style="padding:16px 18px">
          <div style="font:600 12px ${mono};color:#a3a3a3;letter-spacing:.04em">@${esc(t.account)} · waiting ${esc(waited(t.lastActivityAt, now))}</div>
          <div style="font:700 17px ${sans};color:#fff;margin:6px 0 2px"><a href="https://www.instagram.com/${esc(t.handle)}/" style="color:#fff;text-decoration:none">@${esc(t.handle)}</a>${t.name ? ` <span style="font-weight:400;color:#a3a3a3">${esc(t.name)}</span>` : ''}</div>
          <div style="font:15px/1.5 ${sans};color:#e5e5e5;margin:6px 0 0">“${esc(lastTheirLine(t)) || '<i>sent media</i>'}”</div>
          ${drafts[t.handle] ? `<div style="margin-top:12px;padding:10px 12px;border-left:3px solid #34d399;background:#0f1f19;font:14px/1.5 ${sans};color:#d1fae5"><span style="font:600 11px ${mono};color:#34d399;letter-spacing:.06em">DRAFT — EDIT, THEN SEND</span><br>${esc(drafts[t.handle])}</div>` : ''}
        </td></tr>
      </table>
    </td></tr>`;
  const html = `<!doctype html><html><body style="margin:0;background:#0a0a0a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a"><tr><td align="center" style="padding:28px 14px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
  <tr><td style="padding:0 0 18px">
    <div style="font:800 20px ${sans};color:#fff;letter-spacing:.02em">IRIS</div>
    <div style="font:600 12px ${mono};color:#737373;letter-spacing:.08em;margin-top:2px">INBOX TRIAGE · ${esc(new Date(now).toISOString().slice(0, 10))}</div>
  </td></tr>
  <tr><td style="padding:0 0 22px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="padding:14px;background:#141414;border:1px solid #262626;border-radius:12px 0 0 12px"><div style="font:700 28px ${mono};color:#fbbf24">${s.waiting.length}</div><div style="font:13px ${sans};color:#a3a3a3">waiting on you</div></td>
      <td style="padding:14px;background:#141414;border:1px solid #262626;border-left:0"><div style="font:700 28px ${mono};color:#fff">${s.repliedToday}</div><div style="font:13px ${sans};color:#a3a3a3">wrote in the last day</div></td>
      <td style="padding:14px;background:#141414;border:1px solid #262626;border-left:0;border-radius:0 12px 12px 0"><div style="font:700 28px ${mono};color:#34d399">${s.newPeople.length}</div><div style="font:13px ${sans};color:#a3a3a3">new people</div></td>
    </tr></table>
  </td></tr>
  ${s.notChecked.length ? `<tr><td style="padding:0 0 18px;font:14px/1.5 ${sans};color:#fca5a5">Not checked in the last day: ${s.notChecked.map(a => '@' + esc(a)).join(', ')}. Their replies are not in this email; the login probably needs renewing.</td></tr>` : ''}
  ${top.length ? `<tr><td style="padding:0 0 10px;font:700 16px ${sans};color:#fff">Answer these first</td></tr>${top.map(card).join('')}` : `<tr><td style="padding:0 0 18px;font:15px ${sans};color:#a3a3a3">Nobody is waiting on you. Nice.</td></tr>`}
  ${s.reacted?.length ? `<tr><td style="padding:18px 0 6px;font:700 16px ${sans};color:#fff">Reacted, no words <span style="font:400 13px ${sans};color:#a3a3a3">— they liked your message; nothing to answer, so nudge them</span></td></tr>${s.reacted.map(t => `<tr><td style="padding:5px 0;font:14px/1.5 ${sans};color:#d4d4d4"><a href="https://www.instagram.com/${esc(t.handle)}/" style="color:#fff">@${esc(t.handle)}</a> <span style="font:12px ${mono};color:#737373">@${esc(t.account)} · reacted ${esc(waited(t.lastActivityAt, now))} ago</span>${drafts[t.handle] ? `<br><span style="font:600 11px ${mono};color:#34d399;letter-spacing:.06em">NUDGE</span> <span style="color:#d1fae5">${esc(drafts[t.handle])}</span>` : ''}</td></tr>`).join('')}` : ''}
  ${rest.length ? `<tr><td style="padding:8px 0 6px;font:700 16px ${sans};color:#fff">Also waiting</td></tr>${rest.map(t => `<tr><td style="padding:4px 0;font:14px ${sans};color:#d4d4d4"><a href="https://www.instagram.com/${esc(t.handle)}/" style="color:#fff">@${esc(t.handle)}</a> <span style="font:12px ${mono};color:#737373">@${esc(t.account)} · ${esc(waited(t.lastActivityAt, now))}</span> — ${esc(lastTheirLine(t).slice(0, 90))}</td></tr>`).join('')}` : ''}
  ${s.newPeople.length ? `<tr><td style="padding:18px 0 6px;font:700 16px ${sans};color:#fff">New people (added as leads)</td></tr><tr><td style="font:14px/1.7 ${sans};color:#d4d4d4">${s.newPeople.map(p => `@${esc(p.handle)} <span style="font:12px ${mono};color:#737373">via @${esc(p.account)}</span>`).join('<br>')}</td></tr>` : ''}
  ${quietHtml(s.quiet, { mono, sans })}
  <tr><td style="padding:26px 0 0;font:12px/1.6 ${mono};color:#737373">${s.runs} checks across ${s.accounts.map(a => '@' + esc(a)).join(', ') || 'no accounts'} in the last day · ${s.read} conversations read in the latest check · drafts are suggestions; nothing was sent</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    subjectLine(s), '',
    ...(s.notChecked.length ? [`Not checked: ${s.notChecked.map(a => '@' + a).join(', ')}`, ''] : []),
    ...top.flatMap(t => [`@${t.handle} (@${t.account}, waiting ${waited(t.lastActivityAt, now)}): "${lastTheirLine(t)}"`, ...(drafts[t.handle] ? [`  draft: ${drafts[t.handle]}`] : []), '']),
    ...(rest.length ? ['Also waiting: ' + rest.map(t => '@' + t.handle).join(', '), ''] : []),
    ...(s.reacted?.length ? [...s.reacted.flatMap(t => [`Reacted, no words: @${t.handle} (@${t.account}, ${waited(t.lastActivityAt, now)} ago)`, ...(drafts[t.handle] ? [`  nudge: ${drafts[t.handle]}`] : [])]), ''] : []),
    ...(s.newPeople.length ? ['New people: ' + s.newPeople.map(p => '@' + p.handle).join(', ')] : []),
    ...quietText(s.quiet),
  ].join('\n');

  return { subject: subjectLine(s), html, text };
}

function who(r) {
  return r.instagram ? `@${r.instagram}` : (r.name || r.email || `lead ${r.lead_id}`);
}

function quietHtml(q, { mono, sans }) {
  if (!q) return '';
  if (q.stale) return `<tr><td style="padding:18px 0 0;font:14px/1.5 ${sans};color:#fca5a5">Gone-quiet list not refreshed (${esc(q.reason)}), so it is not in this email.</td></tr>`;
  const m = q.summary;
  const accounts = Object.entries(m.by_account || {}).sort((a, b) => b[1] - a[1]).map(([a, n]) => `${esc(a)} ${n}`).join(' · ');
  const days = ['0-7', '8-14', '15-30', '31+'].map(k => `${k} d: ${m.by_days?.[k] || 0}`).join(' · ');
  const warm = q.warm.slice(0, 8);
  return `
  <tr><td style="padding:22px 0 6px;font:700 16px ${sans};color:#fff">Gone quiet <span style="font:400 13px ${sans};color:#a3a3a3">— messaged in the last ${m.window_days} days, nothing back since</span></td></tr>
  <tr><td style="font:14px/1.7 ${sans};color:#d4d4d4"><span style="font:700 15px ${mono};color:#fbbf24">${m.silent}</span> of ${m.messaged} people · <span style="font-family:${mono}">${m.reacted || 0}</span> reacted only, <span style="font-family:${mono}">${m.went_quiet}</span> talked to us once, <span style="font-family:${mono}">${m.never}</span> never replied<br><span style="font:12px ${mono};color:#a3a3a3">${accounts}<br>${days}</span></td></tr>
  ${warm.length ? `<tr><td style="padding:10px 0 4px;font:600 14px ${sans};color:#fff">Reacted or talked to us once — nudge these first</td></tr>${warm.map(r => `<tr><td style="padding:3px 0;font:14px ${sans};color:#d4d4d4">${r.instagram ? `<a href="https://www.instagram.com/${esc(r.instagram)}/" style="color:#fff">@${esc(r.instagram)}</a>` : esc(who(r))} <span style="font:12px ${mono};color:#737373">${esc(r.account || r.channel)} · ${r.kind === 'reacted' ? 'reacted, ' : ''}quiet ${r.days_silent} d</span></td></tr>`).join('')}` : ''}
  <tr><td style="padding:6px 0 0;font:12px ${mono};color:#737373">Full list: ${esc(q.file.replace(/latest\.json$/, (m.generated_at || '').slice(0, 10) + '.csv'))} on hive</td></tr>`;
}

function quietText(q) {
  if (!q) return [];
  if (q.stale) return ['', `Gone-quiet list not refreshed (${q.reason}).`];
  const m = q.summary;
  return ['', `Gone quiet (${m.window_days} d): ${m.silent} of ${m.messaged} — ${m.reacted || 0} reacted only, ${m.went_quiet} talked to us once, ${m.never} never replied`,
    ...(q.warm.length ? ['Nudge first: ' + q.warm.slice(0, 8).map(who).join(', ')] : [])];
}

// ── main ──────────────────────────────────────────────────────────────

async function main() {
  const home = os.homedir();
  const logFile = process.env.CAPTURE_LOG || path.join(home, '.iris', 'data', 'reply-capture.jsonl');
  const expected = (process.env.CAPTURE_ACCOUNTS || '').split(',').map(p => p.trim().split(':')[0].replace(/^@/, '')).filter(Boolean);
  const dry = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
  const s = summarise(readLog(logFile), { expected });
  s.quiet = loadQuiet(process.env.NO_REPLY_FILE || path.join(home, '.iris', 'data', 'no-reply-latest.json'));

  const drafts = {};
  const apiKey = process.env.OPENROUTER_API_KEY || '';
  const model = process.env.DIGEST_MODEL || 'openai/gpt-4o-mini';
  for (const t of [...s.waiting.slice(0, 5), ...s.reacted.slice(0, 5)]) {
    try { drafts[t.handle] = await draftReply(t, { apiKey, model }); } catch { drafts[t.handle] = ''; }
  }

  const email = renderEmail(s, drafts);
  console.log(email.subject);
  console.log(`  ${s.runs} runs · ${s.waiting.length} waiting · ${s.reacted.length} reacted · ${s.newPeople.length} new · drafts ${Object.values(drafts).filter(Boolean).length}/${Math.min(5, s.waiting.length) + Math.min(5, s.reacted.length)}`);

  if (dry) {
    const out = path.join(home, '.iris', 'data', 'reply-digest-preview.html');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, email.html);
    console.log(`  [DRY RUN] not sent — preview at ${out}`);
    return;
  }

  const keyFile = process.env.RESEND_KEY_FILE || path.join(home, '.iris', 'keys', 'resend-newsletter.key');
  const key = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '';
  if (!key) throw new Error(`no Resend key at ${keyFile}`);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.DIGEST_FROM || 'IRIS <team@heyiris.io>',
      to: [process.env.DIGEST_TO || 'alex@freelabel.net'],
      subject: email.subject,
      html: email.html,
      text: email.text,
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`);
  console.log(`  sent: ${body.slice(0, 120)}`);
}

module.exports = { sinceOurLast, summarise, renderEmail, subjectLine, waited, lastTheirLine, readLog, draftReply, loadQuiet, VOICES };

if (require.main === module) {
  main().catch(err => { console.error(`reply-digest failed: ${err.message}`); process.exit(1); });
}
