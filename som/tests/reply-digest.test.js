// Daily reply triage — tests against the shipped module (synthetic data, no network).
// Run: node --test som/tests/reply-digest.test.js
const test = require('node:test');
const assert = require('node:assert');
const { summarise, renderEmail, subjectLine, waited, lastTheirLine, draftReply } = require('../reply-digest');

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
