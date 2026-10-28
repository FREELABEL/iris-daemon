// #191275 — a run must not start, or send anything, when its strategy is missing on the board.
// Run: node --test som/tests/strategy-check.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { findStrategyScript, checkStrategy, describeFailure } = require('../helpers/strategy-check');

const templates = [
  { id: 18, name: 'Creator Outreach | V1', steps: [{ order: 1, instructions: 'second' }, { order: 0, instructions: 'Your content caught my eye.' }] },
  { id: 53, name: 'Silent Iris', steps: [{ order: 0, instructions: '   ' }] },
  { id: 47, name: 'Artist Outreach | FFAT V1', steps: [] },
];

test('the exact name on the board returns its FIRST step script', () => {
  const r = findStrategyScript(templates, 'Creator Outreach | V1');
  assert.deepStrictEqual(r, { ok: true, id: 18, script: 'Your content caught my eye.' });
});

test('a name that is not on the board fails and lists the names that are', () => {
  const r = findStrategyScript(templates, 'Custom Campaign');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /does not exist on this board/);
  assert.deepStrictEqual(r.available, ['Creator Outreach | V1', 'Silent Iris', 'Artist Outreach | FFAT V1']);
});

test('names match exactly — a case-only difference fails, with a hint', () => {
  const r = findStrategyScript(templates, 'creator outreach | v1');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /did you mean "Creator Outreach \| V1"/);
});

test('a strategy with no first-step script (blank or no steps) fails', () => {
  assert.strictEqual(findStrategyScript(templates, 'Silent Iris').ok, false);
  assert.strictEqual(findStrategyScript(templates, 'Artist Outreach | FFAT V1').ok, false);
});

test('no name, or no templates, fails', () => {
  assert.strictEqual(findStrategyScript(templates, '').ok, false);
  assert.strictEqual(findStrategyScript(undefined, 'Silent Iris').ok, false);
});

test('checkStrategy: an API error or a network failure is a failure, never a pass', async () => {
  const http500 = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const boom = async () => { throw new Error('ECONNRESET'); };
  assert.strictEqual((await checkStrategy(80, 'Creator Outreach | V1', { fetchImpl: http500, token: 't' })).ok, false);
  const r = await checkStrategy(80, 'Creator Outreach | V1', { fetchImpl: boom, token: 't' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /ECONNRESET/);
});

test('checkStrategy reads data.templates from the board endpoint', async () => {
  let url;
  const ok = async u => { url = u; return { ok: true, json: async () => ({ data: { templates } }) }; };
  const r = await checkStrategy(80, 'Creator Outreach | V1', { fetchImpl: ok, token: 't', apiBase: 'https://api.test' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(url, 'https://api.test/api/v1/bloqs/80/outreach-strategy-templates');
});

test('describeFailure names the board, the reason and the real choices', () => {
  const line = describeFailure(80, findStrategyScript(templates, 'Custom Campaign'));
  assert.match(line, /^Board 80: strategy "Custom Campaign" does not exist on this board\./);
  assert.match(line, /"Silent Iris"/);
});

test('the batch spec no longer carries a generic stand-in message to send', () => {
  const spec = fs.readFileSync(path.join(__dirname, '..', 'batch-with-login.spec.ts'), 'utf8');
  assert.ok(!spec.includes("Noticed you're doing some interesting work"), 'generic filler is back in the batch spec');
  assert.ok(!spec.includes("I saw you're into some cool stuff") && !spec.includes("I saw you\\'re into some cool stuff"), 'UI-path filler is back in the batch spec');
  // Any "msg || '<text>'" is a stand-in a real person would receive.
  assert.ok(!/\bmsg\s*\|\|\s*['"`]/.test(spec), 'a msg || "<text>" fallback is back in the batch spec');
  assert.match(spec, /if \(!msg\) \{[\s\S]{0,400}?results\.failed\+\+; continue;/, 'the empty-message skip after GET MESSAGE is missing');
  assert.match(spec, /checkStrategy\(BOARD_ID, STRATEGY_NAME/);
});
