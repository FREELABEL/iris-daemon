// Gone-quiet list (#192438) — tests against the shipped module (synthetic data, no network).
// Run: node --test som/tests/no-reply.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { timelines, classify, capturedFromLog, summary, toCsv, family, inboundKind } = require('../no-reply');

const NOW = Date.parse('2026-11-03T12:00:00Z');
const d = n => new Date(NOW - n * 86400e3).toISOString();

const dm = (lead_id, daysAgo, extra = {}) => ({ lead_id, direction: 'outbound', status: 'sent', type: 'instagram_dm', channel_account: 'heyiris.io', bloq_id: 38, sent_at: d(daysAgo), metadata: { campaign_name: 'Silent Iris' }, ...extra });
const mail = (lead_id, daysAgo, extra = {}) => ({ lead_id, direction: 'outbound', channel: 'gmail', from_identifier: 'team@heyiris.io', sent_at: d(daysAgo), ...extra });
const reply = (lead_id, daysAgo, body = 'sounds good', channel = 'instagram') => ({ lead_id, direction: 'inbound', channel, body, sent_at: d(daysAgo) });

const run = (src, leads = [], opts = {}) => {
  const byId = new Map(leads.map(l => [l.id, l]));
  return classify(timelines({ ...src, leads }), byId, { now: NOW, days: 45, ...opts });
};

test('messaged inside the window and never answered = silent, "never"', () => {
  const { rows, messaged, replied } = run({ outreach: [dm(1, 3)] });
  assert.strictEqual(messaged, 1);
  assert.strictEqual(replied, 0);
  assert.deepStrictEqual(rows.map(r => [r.lead_id, r.kind, r.days_silent, r.account, r.campaign]), [[1, 'never', 3, 'heyiris.io', 'Silent Iris']]);
});

test('a reply after our latest message takes them off the list', () => {
  const { rows, replied } = run({ outreach: [dm(1, 10)], comms: [reply(1, 9)] });
  assert.strictEqual(rows.length, 0);
  assert.strictEqual(replied, 1);
});

test('replied once, then we wrote again and heard nothing = "went-quiet"', () => {
  const { rows } = run({ outreach: [dm(1, 20), dm(1, 5)], comms: [reply(1, 19)] });
  assert.deepStrictEqual(rows.map(r => [r.kind, r.messages_sent, r.days_silent]), [['went-quiet', 2, 5]]);
});

test('our last message outside the window is not this list', () => {
  assert.strictEqual(run({ outreach: [dm(1, 60)] }).rows.length, 0);
  assert.strictEqual(run({ outreach: [dm(1, 44)] }).rows.length, 1);
});

test('replied_at on the lead counts, has_replied with no date counts, unsubscribed are dropped', () => {
  const leads = [
    { id: 1, replied_at: d(1) },
    { id: 2, has_replied: 1, replied_at: null },
    { id: 3, unsubscribed_at: d(2) },
    { id: 4 },
  ];
  const { rows } = run({ outreach: [dm(1, 3), dm(2, 3), dm(3, 3), dm(4, 3)] }, leads);
  assert.deepStrictEqual(rows.map(r => r.lead_id), [4]);
});

test('a reply the IG capture saw but the lead record missed still counts (#192438 sub-bug)', () => {
  const capturedReplies = new Map([['gumpthaspilla', [{ at: Date.parse(d(1)), kind: 'reply' }]]]);
  const leads = [{ id: 27010, contact_info: { instagram: 'GumpThaSpilla' } }];
  const tl = timelines({ outreach: [dm(27010, 3)], leads, capturedReplies });
  assert.strictEqual(classify(tl, new Map(leads.map(l => [l.id, l])), { now: NOW }).rows.length, 0);
});

test('emails from the comms log count; iMessage, bounces and failed sends do not', () => {
  const { rows } = run({
    outreach: [dm(5, 2, { status: 'failed' })],
    comms: [mail(1, 4), { ...mail(2, 4), channel: 'imessage' }, { ...mail(3, 4), bounced_at: d(4) }, { ...mail(4, 4), channel: 'apple_mail' }],
  });
  assert.deepStrictEqual(rows.map(r => [r.lead_id, r.channel, r.account]), [[1, 'email', 'team@heyiris.io']]);
});

test('one DM logged in both outreach and comms is one send, not two', () => {
  const comms = [{ lead_id: 1, direction: 'outbound', channel: 'instagram', sent_at: d(3), metadata: { channel_account: 'heyiris.io' } }];
  assert.strictEqual(run({ outreach: [dm(1, 3)], comms }).rows[0].messages_sent, 1);
});

test('oldest silence first; summary buckets and CSV quoting', () => {
  const { rows } = run({ outreach: [dm(1, 2), dm(2, 40), dm(3, 10, { channel_account: 'thediscoverpage_' })] });
  assert.deepStrictEqual(rows.map(r => r.lead_id), [2, 3, 1]);
  const s = summary(rows);
  assert.deepStrictEqual(s.by_days, { '31+': 1, '8-14': 1, '0-7': 1 });
  assert.deepStrictEqual(s.by_account, { 'heyiris.io': 2, thediscoverpage_: 1 });
  const csv = toCsv([{ ...rows[0], name: 'Smith, "Jo"' }]);
  assert.match(csv.split('\n')[1], /"Smith, ""Jo"""/);
});

test('capture log: only THEIR lines, with their timestamps', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nr-')), 'cap.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ threads: [{ handle: 'Them', recent: ['me: hi [2026-11-01T00:00:00Z]', 'them: yo [2026-11-02T00:00:00Z]', 'them: [reaction_log_xmat] [2026-11-02T01:00:00Z]'] }] }),
    JSON.stringify({ threads: [{ handle: 'only_us', recent: ['me: hi [2026-11-01T00:00:00Z]'] }] }),
    'not json',
  ].join('\n'));
  const m = capturedFromLog(f);
  assert.deepStrictEqual([...m.keys()], ['them']);
  assert.deepStrictEqual(m.get('them'), [{ at: Date.parse('2026-11-02T00:00:00Z'), kind: 'reply' }, { at: Date.parse('2026-11-02T01:00:00Z'), kind: 'reaction' }]);
});

test('a Resend email is labelled by its subject, without the logging prefix', () => {
  const { rows } = run({ comms: [{ ...mail(1, 2), channel: 'other', from_identifier: null, subject: 'Email (Resend) from Alex Mayo: Before tax season hits' }] });
  assert.deepStrictEqual([rows[0].account, rows[0].campaign], ['email (Resend)', 'Before tax season hits']);
});

test('channel families', () => {
  assert.deepStrictEqual(['instagram_dm', 'instagram', 'gmail', 'apple_mail', 'other', 'imessage'].map(family), ['instagram', 'instagram', 'email', 'email', 'email', 'imessage']);
});

// ── reactions (#192438) ──

test('inbound kinds: a reaction, a system notice, and everything else is a reply', () => {
  assert.deepStrictEqual(
    ['[reaction_log_xmat]', '[reachability_settings_one_way_send_xmat]', '[reachability_settings_one_way_send_xmat', '[message_inline_share]', '[images]', 'lol yes', ''].map(inboundKind),
    ['reaction', 'system', 'system', 'reply', 'reply', 'reply', 'reply'],
  );
});

test('a heart on our DM and no words = "reacted", still on the list, with the date', () => {
  const { rows, replied } = run({ outreach: [dm(1, 5)], comms: [reply(1, 4, '[reaction_log_xmat]')] });
  assert.strictEqual(replied, 0);
  assert.deepStrictEqual(rows.map(r => [r.kind, r.reacted_on]), [['reacted', d(4).slice(0, 10)]]);
});

test('reacted, then wrote words = replied; wrote before, reacted to our latest = reacted', () => {
  assert.strictEqual(run({ outreach: [dm(1, 5)], comms: [reply(1, 4, '[reaction_log_xmat]'), reply(1, 3, 'tell me more')] }).rows.length, 0);
  const { rows } = run({ outreach: [dm(1, 20), dm(1, 5)], comms: [reply(1, 19, 'hey'), reply(1, 4, '[reaction_log_xmat]')] });
  assert.strictEqual(rows[0].kind, 'reacted');
});

test('a reaction to an OLD message does not make a newer silence "reacted"', () => {
  const { rows } = run({ outreach: [dm(1, 20), dm(1, 5)], comms: [reply(1, 19, '[reaction_log_xmat]')] });
  assert.strictEqual(rows[0].kind, 'never');
});

test('an Instagram system notice is not a reply', () => {
  const { rows } = run({ outreach: [dm(1, 5)], comms: [reply(1, 4, '[reachability_settings_one_way_send_xmat]')] });
  assert.strictEqual(rows[0].kind, 'never');
});

test('replied_at set by a reaction does not hide them when the message itself says reaction', () => {
  const leads = [{ id: 1, replied_at: d(4), has_replied: 1, contact_info: { instagram: 'hearter' } }];
  const capturedReplies = new Map([['hearter', [{ at: Date.parse(d(4)), kind: 'reaction' }]]]);
  const tl = timelines({ outreach: [dm(1, 5)], leads, capturedReplies });
  const { rows } = classify(tl, new Map(leads.map(l => [l.id, l])), { now: NOW });
  assert.strictEqual(rows[0].kind, 'reacted');
  // with no message content to go on, replied_at still counts as a reply
  const tl2 = timelines({ outreach: [dm(1, 5)], leads });
  assert.strictEqual(classify(tl2, new Map(leads.map(l => [l.id, l])), { now: NOW }).rows.length, 0);
});

test('summary counts reacted separately', () => {
  const { rows } = run({ outreach: [dm(1, 5), dm(2, 5)], comms: [reply(1, 4, '[reaction_log_xmat]')] });
  const s = summary(rows);
  assert.deepStrictEqual([s.silent, s.reacted, s.never, s.went_quiet], [2, 1, 1, 0]);
});
