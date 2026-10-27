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
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

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
 * Summarise capture runs for a window ending at `now`.
 * - waiting: per account, the LATEST run's threads whose newest message is theirs
 *   (state now, not a sum of every run), newest first.
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
  for (const run of latest.values()) {
    for (const t of run.threads || []) {
      if (t.waitingOnUs) waiting.push({ ...t, account: run.account, boardId: run.boardId });
    }
  }
  waiting.sort((a, b) => Date.parse(b.lastActivityAt || 0) - Date.parse(a.lastActivityAt || 0));

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

  return { waiting, newPeople, repliedToday, notChecked, runs, read, accounts: [...latest.keys()] };
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

function subjectLine(s) {
  const parts = [`${s.waiting.length} waiting on you`];
  if (s.newPeople.length) parts.push(`${s.newPeople.length} new ${s.newPeople.length === 1 ? 'person' : 'people'}`);
  if (s.notChecked.length) parts.push(`${s.notChecked.length} account${s.notChecked.length === 1 ? '' : 's'} not checked`);
  return `Inbox triage: ${parts.join(' · ')}`;
}

// ── drafts ────────────────────────────────────────────────────────────

async function draftReply(thread, { apiKey, model, fetchImpl = fetch } = {}) {
  if (!apiKey) return '';
  const voice = VOICES[thread.account] || VOICES.thediscoverpage_;
  const convo = (thread.recent || []).map(l => l.replace(/\s*\[[^\]]+\]\s*$/, '').replace(/^me: /, 'US: ').replace(/^[^:]+: /, m => (m === 'US: ' ? m : 'THEM: '))).join('\n');
  const res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.6,
      max_tokens: 120,
      messages: [
        { role: 'system', content: `${voice}\nWrite ONE Instagram DM reply to the last THEM message: 1–2 short sentences, answer what they actually said, no hashtags, no emojis unless they used one, no numbers or claims you were not given. Reply with the message text only.` },
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
  ${rest.length ? `<tr><td style="padding:8px 0 6px;font:700 16px ${sans};color:#fff">Also waiting</td></tr>${rest.map(t => `<tr><td style="padding:4px 0;font:14px ${sans};color:#d4d4d4"><a href="https://www.instagram.com/${esc(t.handle)}/" style="color:#fff">@${esc(t.handle)}</a> <span style="font:12px ${mono};color:#737373">@${esc(t.account)} · ${esc(waited(t.lastActivityAt, now))}</span> — ${esc(lastTheirLine(t).slice(0, 90))}</td></tr>`).join('')}` : ''}
  ${s.newPeople.length ? `<tr><td style="padding:18px 0 6px;font:700 16px ${sans};color:#fff">New people (added as leads)</td></tr><tr><td style="font:14px/1.7 ${sans};color:#d4d4d4">${s.newPeople.map(p => `@${esc(p.handle)} <span style="font:12px ${mono};color:#737373">via @${esc(p.account)}</span>`).join('<br>')}</td></tr>` : ''}
  <tr><td style="padding:26px 0 0;font:12px/1.6 ${mono};color:#737373">${s.runs} checks across ${s.accounts.map(a => '@' + esc(a)).join(', ') || 'no accounts'} in the last day · ${s.read} conversations read in the latest check · drafts are suggestions; nothing was sent</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    subjectLine(s), '',
    ...(s.notChecked.length ? [`Not checked: ${s.notChecked.map(a => '@' + a).join(', ')}`, ''] : []),
    ...top.flatMap(t => [`@${t.handle} (@${t.account}, waiting ${waited(t.lastActivityAt, now)}): "${lastTheirLine(t)}"`, ...(drafts[t.handle] ? [`  draft: ${drafts[t.handle]}`] : []), '']),
    ...(rest.length ? ['Also waiting: ' + rest.map(t => '@' + t.handle).join(', '), ''] : []),
    ...(s.newPeople.length ? ['New people: ' + s.newPeople.map(p => '@' + p.handle).join(', ')] : []),
  ].join('\n');

  return { subject: subjectLine(s), html, text };
}

// ── main ──────────────────────────────────────────────────────────────

async function main() {
  const home = os.homedir();
  const logFile = process.env.CAPTURE_LOG || path.join(home, '.iris', 'data', 'reply-capture.jsonl');
  const expected = (process.env.CAPTURE_ACCOUNTS || '').split(',').map(p => p.trim().split(':')[0].replace(/^@/, '')).filter(Boolean);
  const dry = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
  const s = summarise(readLog(logFile), { expected });

  const drafts = {};
  const apiKey = process.env.OPENROUTER_API_KEY || '';
  const model = process.env.DIGEST_MODEL || 'openai/gpt-4o-mini';
  for (const t of s.waiting.slice(0, 5)) {
    try { drafts[t.handle] = await draftReply(t, { apiKey, model }); } catch { drafts[t.handle] = ''; }
  }

  const email = renderEmail(s, drafts);
  console.log(email.subject);
  console.log(`  ${s.runs} runs · ${s.waiting.length} waiting · ${s.newPeople.length} new · drafts ${Object.values(drafts).filter(Boolean).length}/${Math.min(5, s.waiting.length)}`);

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

module.exports = { summarise, renderEmail, subjectLine, waited, lastTheirLine, readLog, draftReply, VOICES };

if (require.main === module) {
  main().catch(err => { console.error(`reply-digest failed: ${err.message}`); process.exit(1); });
}
