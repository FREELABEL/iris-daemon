// Daily reply triage — tests against the shipped module (synthetic data, no network).
// Run: node --test som/tests/reply-digest.test.js
const test = require('node:test');
const assert = require('node:assert');
const { summarise, renderEmail, subjectLine, waited, lastTheirLine, draftReply, sinceOurLast } = require('../reply-digest');

const NOW = Date.parse('2026-10-28T09:00:00Z');
const h = n => new Date(NOW - n * 3600e3).toISOString();

const thread = (handle, waitingOnUs, hoursAgo, last = 'tell me more') => ({
  handle, name: '', waitingOnUs, lastActivityAt: h(hoursAgo),
  recent: [`me: hey [${h(hoursAgo + 1)}]`, `${handle}: ${last} [${h(hoursAgo)}]`],
});

const log = [
  // an older run of the same account: superseded by the later one
  { at: h(5), account: 'heyiris.io', boardId: 38, read: 100, threads: [thread('stale_one', true, 6)], createdLeads: [{ id: 1, handle: 'newbie' }] },
  { at: h(1), account: 'heyiris.io', boardId: 38, read: 181, threads: [thread('answered', false, 2), thread('fresh', true, 1, 'send me the link'), thread('older', true, 40)], createdLeads: [{ id: 1, handle: 'newbie' }, { id: 2, handle: 'second' }] },
  // outside the 24h window entirely
  { at: h(30), account: 'freelabelnet', boardId: 80, read: 50, threads: [thread('ancient', true, 31)], createdLeads: [{ id: 9, handle: 'tooold' }] },
];

test('waiting is the LATEST run per account, theirs-last only, newest first', () => {
  const s = summarise(log, { now: NOW });
  assert.deepStrictEqual(s.waiting.map(t => t.handle), ['fresh', 'older']);
  assert.ok(!s.waiting.some(t => t.handle === 'stale_one'), 'superseded run not counted');
  assert.ok(!s.waiting.some(t => t.handle === 'answered'), 'our message last = not waiting');
});

test('runs outside the window are ignored, including their new people', () => {
  const s = summarise(log, { now: NOW });
  assert.ok(!s.waiting.some(t => t.handle === 'ancient'));
  assert.ok(!s.newPeople.some(p => p.handle === 'tooold'));
});

test('new people are listed once across runs', () => {
  const s = summarise(log, { now: NOW });
  assert.deepStrictEqual(s.newPeople.map(p => p.handle), ['newbie', 'second']);
});

test('an expected account with no run in the window is reported, not silently missing', () => {
  const s = summarise(log, { now: NOW, expected: ['heyiris.io', 'freelabelnet', 'thediscoverpage_'] });
  assert.deepStrictEqual(s.notChecked, ['freelabelnet', 'thediscoverpage_']);
  assert.match(subjectLine(s), /2 accounts not checked/);
});

test('repliedToday counts only waiting threads with activity inside the day', () => {
  assert.strictEqual(summarise(log, { now: NOW }).repliedToday, 1);
});

test('lastTheirLine strips the handle and timestamp; waited reads like a person', () => {
  assert.strictEqual(lastTheirLine(thread('x', true, 1, 'sure, send it')), 'sure, send it');
  assert.strictEqual(waited(h(3), NOW), '3 h');
  assert.strictEqual(waited(h(50), NOW), '2 d');
});

test('the email escapes what people wrote and says nothing was sent', () => {
  const s = summarise([{ at: h(1), account: 'heyiris.io', boardId: 38, read: 1, threads: [thread('evil', true, 1, '<script>x</script>')], createdLeads: [] }], { now: NOW });
  const { html, text } = renderEmail(s, { evil: 'hi <b>there</b>' }, NOW);
  assert.ok(!html.includes('<script>x</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('hi &lt;b&gt;there&lt;/b&gt;'));
  assert.match(html, /nothing was sent/);
  assert.match(text, /draft: hi <b>there<\/b>/);
});

test('draftReply uses the voice of the account the person wrote to, and no key means no draft', async () => {
  assert.strictEqual(await draftReply(thread('a', true, 1), { apiKey: '' }), '');
  let sent;
  const fakeFetch = async (_url, opts) => { sent = JSON.parse(opts.body); return { ok: true, json: async () => ({ choices: [{ message: { content: '"glad to hear it"' } }] }) }; };
  const out = await draftReply({ ...thread('a', true, 1), account: 'freelabelnet' }, { apiKey: 'k', model: 'm', fetchImpl: fakeFetch });
  assert.strictEqual(out, 'glad to hear it');
  assert.match(sent.messages[0].content, /scouting independent artists/);
  assert.match(sent.messages[1].content, /THEM: tell me more/);
  assert.match(sent.messages[1].content, /US: hey/);
});

// ── gone-quiet section (#192438) ──
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadQuiet } = require('../reply-digest');

const quietFile = (generated_at, rows) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'q-')), 'no-reply-latest.json');
  fs.writeFileSync(f, JSON.stringify({ summary: { generated_at, window_days: 45, messaged: 10, silent: rows.length, never: rows.filter(r => r.kind === 'never').length, went_quiet: rows.filter(r => r.kind === 'went-quiet').length, by_account: { 'heyiris.io': rows.length }, by_days: { '0-7': rows.length } }, rows }));
  return f;
};
const qrows = [
  { lead_id: 1, instagram: 'cold_one', kind: 'never', account: 'heyiris.io', days_silent: 3 },
  { lead_id: 2, instagram: 'warm_old', kind: 'went-quiet', account: 'heyiris.io', days_silent: 20 },
  { lead_id: 3, instagram: null, name: 'Reeves Snyder LLP', kind: 'went-quiet', account: 'other', days_silent: 4 },
  { lead_id: 4, instagram: 'just_messaged', kind: 'went-quiet', account: 'heyiris.io', days_silent: 1 },
  { lead_id: 5, instagram: 'hearted_it', kind: 'reacted', account: 'heyiris.io', days_silent: 6 },
];

test('gone quiet: fresh list is in the subject, the email, and the text, warmest first', () => {
  const quiet = loadQuiet(quietFile(new Date(NOW - 3600e3).toISOString(), qrows), { now: NOW });
  assert.strictEqual(quiet.stale, false);
  assert.deepStrictEqual(quiet.warm.map(r => r.lead_id), [5, 3, 2], 'reacted first, then talked-once by recency');
  const s = { ...summarise(log, { now: NOW }), quiet };
  assert.match(subjectLine(s), /5 gone quiet/);
  const e = renderEmail(s, {}, NOW);
  assert.match(e.html, /Gone quiet/);
  assert.match(e.html, /@warm_old/);
  assert.ok(!/@cold_one/.test(e.html), 'never-replied people are counted, not listed');
  assert.ok(!/@just_messaged/.test(e.html), 'too soon to nudge someone we wrote to yesterday');
  assert.match(e.text, /Nudge first: @hearted_it, Reeves Snyder LLP, @warm_old/);
  assert.match(e.html, /reacted, quiet 6 d/);
});

test('gone quiet: a stale or missing list says so and stays out of the subject', () => {
  for (const quiet of [loadQuiet(quietFile(new Date(NOW - 48 * 3600e3).toISOString(), qrows), { now: NOW }), loadQuiet('/nope/x.json', { now: NOW })]) {
    assert.strictEqual(quiet.stale, true);
    const s = { ...summarise(log, { now: NOW }), quiet };
    assert.ok(!/gone quiet/.test(subjectLine(s)));
    assert.match(renderEmail(s, {}, NOW).html, /Gone-quiet list not refreshed/);
  }
});

test('gone quiet: no list wired at all leaves the email exactly as before', () => {
  const s = summarise(log, { now: NOW });
  assert.ok(!/Gone/.test(renderEmail(s, {}, NOW).html));
});

// ── reactions (#192438) ──
const rthread = (handle, lines, hoursAgo = 2) => ({ handle, name: '', waitingOnUs: true, lastActivityAt: h(hoursAgo), recent: lines.map(l => `${l} [${h(hoursAgo)}]`) });

test('sinceOurLast: only reactions since our message = reaction; any words = reply; a notice = system', () => {
  assert.strictEqual(sinceOurLast(rthread('a', ['me: hey', 'a: [reaction_log_xmat]'])), 'reaction');
  assert.strictEqual(sinceOurLast(rthread('a', ['a: hi', 'me: hey', 'a: [reaction_log_xmat]'])), 'reaction', 'words BEFORE our message do not count');
  assert.strictEqual(sinceOurLast(rthread('a', ['me: hey', 'a: [reaction_log_xmat]', 'a: ok cool'])), 'reply');
  assert.strictEqual(sinceOurLast(rthread('a', ['me: hey', 'a: [message_inline_share]'])), 'reply', 'a shared post is a real reply');
  assert.strictEqual(sinceOurLast(rthread('a', ['me: hey', 'a: [reachability_settings_one_way_send_xmat]'])), 'system');
});

test('reacted threads leave "waiting on you" for their own section; system notices vanish', () => {
  const runs = [{ at: h(1), account: 'heyiris.io', boardId: 38, read: 10, threads: [
    rthread('talker', ['me: hey', 'talker: send the link']),
    rthread('hearter', ['me: hey', 'hearter: [reaction_log_xmat]']),
    rthread('notice', ['me: hey', 'notice: [reachability_settings_one_way_send_xmat]']),
  ] }];
  const s = summarise(runs, { now: NOW });
  assert.deepStrictEqual(s.waiting.map(t => t.handle), ['talker']);
  assert.deepStrictEqual(s.reacted.map(t => t.handle), ['hearter']);
  assert.match(subjectLine(s), /1 waiting on you · 1 reacted/);
  const e = renderEmail(s, { hearter: 'Glad it landed! Want the link?' }, NOW);
  assert.match(e.html, /Reacted, no words/);
  assert.match(e.html, /NUDGE<\/span> <span[^>]*>Glad it landed! Want the link\?/);
  assert.ok(!/@notice/.test(e.html));
  assert.match(e.text, /Reacted, no words: @hearter[\s\S]*nudge: Glad it landed/);
});

test('the nudge draft tells the model they only reacted', async () => {
  let sent;
  const fetchImpl = async (_u, o) => { sent = JSON.parse(o.body); return { ok: true, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) }; };
  await draftReply({ ...rthread('hearter', ['me: hey', 'hearter: [reaction_log_xmat]']), account: 'heyiris.io' }, { apiKey: 'k', model: 'm', fetchImpl });
  assert.match(sent.messages[1].content, /THEM: \(reacted to our message, no words\)/);
  assert.ok(!/reaction_log_xmat/.test(sent.messages[1].content));
  assert.match(sent.messages[0].content, /Do not mention the reaction[\s\S]*heyiris\.io/);
  await draftReply({ ...rthread('talker', ['me: hey', 'talker: send it']), account: 'heyiris.io' }, { apiKey: 'k', model: 'm', fetchImpl });
  assert.ok(!/Do not mention the reaction/.test(sent.messages[0].content), 'a real reply gets the normal prompt');
});
