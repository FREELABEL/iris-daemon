#!/usr/bin/env node
/**
 * Gone-quiet list (#192438) — everyone we reached out to in the last N days who has not
 * written back since our latest message.
 *
 * Nothing joined "what we sent" to "what came back", so a lead who ignored the first DM or
 * email was never seen again. This reads both sides and writes the list; it never sends.
 *
 *   node som/no-reply.js                # build, write ~/.iris/data/no-reply-latest.json + dated CSV
 *
 * Sources (read-only):
 *   - /api/v1/leads/{id}/outreach/messages for every contacted lead on NO_REPLY_BOARDS
 *     (SOM DMs; record-dm into comms is unreliable, #191631)
 *   - /api/v1/atlas/comms, every page (emails, logged DMs, inbound replies on any channel)
 *   - the IG capture log (replies that never reached the lead record)
 *
 * Env:
 *   NO_REPLY_DAYS      default 45
 *   NO_REPLY_BOARDS    default 38,80
 *   NO_REPLY_CHANNELS  outreach channels counted, default instagram,instagram_dm,gmail,other
 *                      (iMessage and apple_mail are left out: personal and client threads, not outreach)
 *   CAPTURE_LOG        default ~/.iris/data/reply-capture.jsonl
 *   IRIS_API_KEY / FL_RAICHU_API_TOKEN, IRIS_FL_API_URL (default https://raichu.heyiris.io)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
// gmail = venue pitches, other = Resend cold email + client invites. apple_mail is left out: on 2026-11-03
// it was recruiters, notes to self and client threads, not outreach. iMessage likewise.
const DEFAULT_CHANNELS = ['instagram', 'instagram_dm', 'gmail', 'other'];
const MAIL_LABEL = { other: 'email (Resend)', gmail: 'email (Gmail)' };

/**
 * What an inbound message actually is. IG gives no text for some items, only a [placeholder]:
 *   [reaction_log_xmat]                 → they reacted (a heart on our DM) — saw it, said nothing
 *   [reachability_settings_one_way_…]   → an Instagram system notice, not them at all
 * Everything else (words, shares, images, voice notes) is a real reply.
 */
function inboundKind(text) {
  const x = String(text || '').trim();
  if (/^\[reaction[a-z_]*\]$/i.test(x)) return 'reaction';
  if (/^\[reachability_settings[a-z_]*\]?$/i.test(x)) return 'system';
  return 'reply';
}

// ── pure: build + classify ────────────────────────────────────────────

const t = s => (s ? Date.parse(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z')) : NaN);

/** Channel family for display and dedup: every IG type is "instagram", every mail type is "email". */
function family(channel) {
  const c = String(channel || '').toLowerCase();
  if (c.startsWith('instagram')) return 'instagram';
  if (['gmail', 'email', 'apple_mail', 'other', 'resend'].includes(c)) return 'email';
  return c;
}

/**
 * Fold every source into one timeline per lead.
 * @returns Map<leadId, { out: [{at, channel, account, campaign, board}], in: [at] }>
 */
function timelines({ outreach = [], comms = [], leads = [], capturedReplies = new Map(), channels = DEFAULT_CHANNELS }) {
  const tl = new Map();
  const get = id => { if (!tl.has(id)) tl.set(id, { out: [], in: [] }); return tl.get(id); };
  const allowed = new Set(channels);

  for (const m of outreach) {
    if (!m.lead_id) continue;
    if (m.direction === 'inbound') { get(m.lead_id).in.push({ at: t(m.sent_at || m.created_at), kind: inboundKind(m.message), src: 'msg' }); continue; }
    if (!['sent', 'delivered'].includes(m.status) || !m.sent_at) continue;
    get(m.lead_id).out.push({ at: t(m.sent_at), channel: family(m.type), account: m.channel_account || null, campaign: m.metadata?.campaign_name || null, board: m.bloq_id || null });
  }
  for (const c of comms) {
    if (!c.lead_id) continue;
    const at = t(c.sent_at || c.created_at);
    if (c.direction === 'inbound') { get(c.lead_id).in.push({ at, kind: inboundKind(c.body), src: 'msg' }); continue; }
    if (!allowed.has(c.channel) || c.bounced_at) continue;
    const subject = String(c.subject || '').replace(/^Email \(Resend\) from [^:]+:\s*/, '').slice(0, 80) || null;
    get(c.lead_id).out.push({ at, channel: family(c.channel), account: c.metadata?.channel_account || c.from_identifier || MAIL_LABEL[c.channel] || c.channel, campaign: c.metadata?.campaign || subject, board: c.bloq_id || null });
  }
  for (const l of leads) {
    if (!tl.has(l.id)) continue;
    const handle = String(l.contact_info?.instagram || '').toLowerCase();
    if (handle && capturedReplies.has(handle)) get(l.id).in.push(...capturedReplies.get(handle).map(e => ({ ...e, src: 'msg' })));
    // replied_at carries no content: a reaction sets it too. Use it only when no message says what came back.
    if (l.replied_at && !get(l.id).in.some(e => e.src === 'msg')) get(l.id).in.push({ at: t(l.replied_at), kind: 'reply', src: 'flag' });
  }
  return tl;
}

/**
 * Who is silent: our latest outreach is inside the window and no WORDS came back after it.
 * "reacted"    = they reacted to our message since, but wrote nothing — warmest of the three;
 * "went-quiet" = they wrote to us once, not since our last message; "never" = never wrote at all.
 * System notices are ignored. A lead flagged has_replied with no reply date counts as replied.
 */
function classify(tl, leadsById = new Map(), { now = Date.now(), days = 45 } = {}) {
  const cutoff = now - days * DAY_MS;
  const rows = [];
  let messaged = 0, replied = 0;
  for (const [id, ev] of tl) {
    const out = ev.out.filter(o => Number.isFinite(o.at)).sort((a, b) => a.at - b.at);
    if (!out.length) continue;
    const last = out[out.length - 1];
    if (last.at < cutoff || last.at > now) continue;
    messaged++;
    const lead = leadsById.get(id) || {};
    if (lead.unsubscribed_at) continue;
    const ins = ev.in.filter(e => Number.isFinite(e.at) && e.kind !== 'system');
    const words = ins.filter(e => e.kind === 'reply');
    const flaggedUndated = (lead.has_replied && !lead.replied_at) && !ins.length;
    if (flaggedUndated || words.some(e => e.at >= last.at)) { replied++; continue; }
    const reactedAt = ins.filter(e => e.kind === 'reaction' && e.at >= last.at).map(e => e.at);
    // same message logged twice (outreach + comms) within a minute is one send
    const sends = out.filter((o, i) => i === 0 || o.at - out[i - 1].at > 60e3 || o.channel !== out[i - 1].channel);
    const ci = lead.contact_info || {};
    rows.push({
      lead_id: id,
      name: lead.name || null,
      instagram: ci.instagram || null,
      email: lead.email || null,
      kind: reactedAt.length ? 'reacted' : words.length ? 'went-quiet' : 'never',
      reacted_on: reactedAt.length ? new Date(Math.max(...reactedAt)).toISOString().slice(0, 10) : null,
      channel: last.channel,
      account: last.account,
      board: last.board || (lead.bloq_ids || [])[0] || null,
      campaign: last.campaign,
      messages_sent: sends.length,
      first_sent: new Date(out[0].at).toISOString().slice(0, 10),
      last_sent: new Date(last.at).toISOString().slice(0, 10),
      days_silent: Math.floor((now - last.at) / DAY_MS),
      status: lead.status || null,
    });
  }
  rows.sort((a, b) => b.days_silent - a.days_silent);
  return { rows, messaged, replied };
}

/** Handle → [{at, kind}] for THEIR lines in the capture log. */
function capturedFromLog(file) {
  const map = new Map();
  if (!file || !fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    for (const th of e.threads || []) {
      const theirs = (th.recent || []).filter(r => !/^me: /.test(r)).map(r => {
        const stamp = (r.match(/\s*\[([^\]]+)\]\s*$/) || [])[1];
        const text = r.replace(/^[^:]+: /, '').replace(/\s*\[[^\]]+\]\s*$/, '');
        return { at: t(stamp), kind: inboundKind(text) };
      }).filter(e => Number.isFinite(e.at));
      if (!theirs.length) continue;
      const k = String(th.handle).toLowerCase();
      map.set(k, [...(map.get(k) || []), ...theirs]);
    }
  }
  return map;
}

function bucket(d) { return d <= 7 ? '0-7' : d <= 14 ? '8-14' : d <= 30 ? '15-30' : '31+'; }

function summary(rows, extra = {}) {
  const count = f => rows.reduce((m, r) => ((m[f(r)] = (m[f(r)] || 0) + 1), m), {});
  return {
    silent: rows.length,
    never: rows.filter(r => r.kind === 'never').length,
    went_quiet: rows.filter(r => r.kind === 'went-quiet').length,
    reacted: rows.filter(r => r.kind === 'reacted').length,
    by_account: count(r => r.account || r.channel),
    by_channel: count(r => r.channel),
    by_days: count(r => bucket(r.days_silent)),
    ...extra,
  };
}

function toCsv(rows) {
  const cols = ['lead_id', 'name', 'instagram', 'email', 'kind', 'reacted_on', 'channel', 'account', 'board', 'campaign', 'messages_sent', 'first_sent', 'last_sent', 'days_silent', 'status'];
  const q = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...rows.map(r => cols.map(c => q(r[c])).join(','))].join('\n') + '\n';
}

// ── io ────────────────────────────────────────────────────────────────

function client({ base, token, fetchImpl = fetch }) {
  return async function get(p, tries = 4) {
    for (let i = 0; ; i++) {
      try {
        const res = await fetchImpl(`${base}/${p}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
        if (res.ok) return await res.json();
        if (![429, 500, 502, 503, 504].includes(res.status) || i >= tries - 1) throw new Error(`${res.status} ${p}`);
      } catch (err) { if (i >= tries - 1) throw err; }
      await new Promise(r => setTimeout(r, 2000 * 2 ** i));
    }
  };
}

async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch(err => ({ error: err.message })); } }));
  return out;
}

async function main() {
  const home = os.homedir();
  const days = Number(process.env.NO_REPLY_DAYS || 45);
  const boards = (process.env.NO_REPLY_BOARDS || '38,80').split(',').map(Number).filter(Boolean);
  const channels = (process.env.NO_REPLY_CHANNELS || DEFAULT_CHANNELS.join(',')).split(',').map(s => s.trim()).filter(Boolean);
  const outDir = path.join(home, '.iris', 'data');
  const token = process.env.IRIS_API_KEY || process.env.FL_RAICHU_API_TOKEN;
  if (!token) throw new Error('No API token (set IRIS_API_KEY)');
  const get = client({ base: process.env.IRIS_FL_API_URL || 'https://raichu.heyiris.io', token });
  const now = Date.now();

  const leadsById = new Map();
  for (const b of boards) {
    for (let page = 1, last = 1; page <= last; page++) {
      const d = await get(`api/v1/leads?bloq_id=${b}&per_page=200&page=${page}`);
      last = d.last_page;
      for (const l of d.data) if ((l.bloq_ids || []).includes(b)) leadsById.set(l.id, l);
    }
  }
  const contacted = [...leadsById.values()].filter(l => (l.completed_outreach_steps_count || 0) > 0 || (l.outreach_completed_count || 0) > 0);

  const msgs = await pool(contacted, 8, l => get(`api/v1/leads/${l.id}/outreach/messages`));
  const errors = msgs.filter(m => m?.error).length;
  const outreach = msgs.flatMap(m => m?.messages || []);

  const comms = [];
  for (let page = 1, last = 1; page <= last; page++) {
    const d = (await get(`api/v1/atlas/comms?per_page=200&page=${page}`)).data;
    last = d.last_page; comms.push(...d.data);
  }

  // leads only seen in comms (email outreach on other boards): fetch them for name, flags
  const extraIds = [...new Set(comms.filter(c => c.direction === 'outbound' && channels.includes(c.channel) && c.lead_id && !leadsById.has(c.lead_id)).map(c => c.lead_id))];
  for (const r of await pool(extraIds, 8, id => get(`api/v1/leads/${id}`))) {
    const l = r?.data?.lead || r?.data || r?.lead || r;
    if (l?.id) leadsById.set(l.id, l);
  }

  const capturedReplies = capturedFromLog(process.env.CAPTURE_LOG || path.join(outDir, 'reply-capture.jsonl'));
  const tl = timelines({ outreach, comms, leads: [...leadsById.values()], capturedReplies, channels });
  const { rows, messaged, replied } = classify(tl, leadsById, { now, days });
  const s = summary(rows, { generated_at: new Date(now).toISOString(), window_days: days, boards, messaged, replied, errors, leads_scanned: leadsById.size, comms_read: comms.length });

  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date(now).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(outDir, `no-reply-${stamp}.csv`), toCsv(rows));
  const tmp = path.join(outDir, '.no-reply-latest.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify({ summary: s, rows }, null, 1));
  fs.renameSync(tmp, path.join(outDir, 'no-reply-latest.json'));
  console.log(`${stamp} gone quiet: ${s.silent} of ${messaged} messaged in ${days} d (${s.reacted} reacted only, ${s.went_quiet} went quiet, ${s.never} never replied) · replied ${replied} · errors ${errors}`);
  if (errors) process.exitCode = 2;
}

module.exports = { timelines, classify, capturedFromLog, summary, toCsv, family, bucket, inboundKind };

if (require.main === module) {
  main().catch(err => { console.error(`no-reply failed: ${err.message}`); process.exit(1); });
}
