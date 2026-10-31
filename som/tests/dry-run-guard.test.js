// #191666: a dry run changes nothing. Run: node --test som/tests/dry-run-guard.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { API_WRITE_METHODS, isBlockedInDryRun, installDryRunGuard, stubApiWrites, applyTargetStrategy } = require('../helpers/dry-run-guard');

const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

/** A panel where every button is on screen, recording what gets clicked. */
function fakePanel () {
  const clicks = [];
  const page = {
    locator: selector => {
      const handle = {
        first: () => handle,
        isVisible: async () => true,
        click: async () => { clicks.push(selector); },
        count: async () => 1,
      };
      return handle;
    },
    waitForTimeout: async () => {},
  };
  return { page, clicks };
}

for (const outreachState of ['fresh', 'has-apply']) {
  test(`dry run clicks nothing on a ${outreachState} panel`, async () => {
    const { page, clicks } = fakePanel();
    const r = await applyTargetStrategy(page, { dryRun: true, strategyName: 'S', outreachState, log: () => {} });
    assert.strictEqual(r, 'dry-run');
    assert.deepStrictEqual(clicks, []);
  });
}

test('a real run still starts the default, applies, selects and confirms, in that order', async () => {
  const { page, clicks } = fakePanel();
  const r = await applyTargetStrategy(page, { dryRun: false, strategyName: 'S', outreachState: 'fresh', log: () => {} });
  assert.strictEqual(r, 'applied');
  assert.deepStrictEqual(clicks, [
    'button:has-text("Start with Default Strategy")',
    'button:has-text("Apply Strategy")',
    'button:has-text("S")',
    'button.swal2-confirm',
  ]);
});

test('the browser may read from our API but not write to it', () => {
  const api = 'https://raichu.heyiris.io/api/v1/leads/1/outreach-steps/initialize-default';
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) assert.ok(isBlockedInDryRun(m, api), m);
  for (const m of ['GET', 'HEAD', 'OPTIONS']) assert.ok(!isBlockedInDryRun(m, api), m);
  assert.ok(isBlockedInDryRun('POST', 'https://web.freelabel.net/x'));
  assert.ok(isBlockedInDryRun('POST', 'https://heyiris.io/x'));
});

test('stateless AI text calls and other sites are left alone; a lookalike host is not ours', () => {
  assert.ok(!isBlockedInDryRun('POST', 'https://raichu.heyiris.io/api/v1/ai/generate-variation'));
  assert.ok(!isBlockedInDryRun('POST', 'https://www.instagram.com/api/x'));
  assert.ok(!isBlockedInDryRun('POST', 'https://evilheyiris.io/x'));
  assert.ok(isBlockedInDryRun('POST', 'https://raichu.heyiris.io/api/v1/leads/1/outreach/generate-dm'));
});

test('the installed guard aborts writes and passes reads', async () => {
  let matcher, handler;
  const context = { route: async (m, h) => { matcher = m; handler = h; } };
  await installDryRunGuard(context, { log: () => {} });
  assert.ok(matcher('https://raichu.heyiris.io/a'));
  assert.ok(!matcher('https://www.instagram.com/a'));
  const run = async (method) => {
    const calls = [];
    await handler({
      request: () => ({ method: () => method, url: () => 'https://raichu.heyiris.io/a' }),
      abort: async () => calls.push('abort'),
      fallback: async () => calls.push('fallback'),
    });
    return calls;
  };
  assert.deepStrictEqual(await run('POST'), ['abort']);
  assert.deepStrictEqual(await run('GET'), ['fallback']);
});

test('every LeadgenApiClient method that writes is stubbed', () => {
  const src = source('helpers/leadgen-api-client.ts');
  const parts = src.split(/\n  async (?=\w+\()/).slice(1);
  const writers = parts
    .filter(p => /method:\s*'(POST|PUT|PATCH|DELETE)'/.test(p) || /this\.createLead\(/.test(p))
    .map(p => p.match(/^\w+/)[0]);
  assert.ok(writers.length > 5, 'parsed the client');
  assert.deepStrictEqual(writers.filter(w => !API_WRITE_METHODS.includes(w)), []);
});

test('stubbing writes leaves reads real and sends nothing', async () => {
  const hits = [];
  const client = { addNote: async () => hits.push('note'), quickEnrichInstagram: async () => hits.push('enrich'), getLead: async () => 'real' };
  stubApiWrites(client, { log: () => {} });
  assert.strictEqual((await client.addNote(1, 'x')).success, true);
  assert.strictEqual((await client.quickEnrichInstagram(1)).success, true);
  assert.strictEqual(await client.getLead(1), 'real');
  assert.deepStrictEqual(hits, []);
});

test('the batch installs the guard and the stubs, and only in a dry run', () => {
  const spec = source('batch-with-login.spec.ts');
  assert.match(spec, /if \(DRY_RUN\) await installDryRunGuard\(context\)/);
  assert.match(spec, /if \(DRY_RUN\) \{[^}]*stubApiWrites\(apiClient\)/);
  assert.match(spec, /applyTargetStrategy\(page, \{ dryRun: DRY_RUN/);
  assert.doesNotMatch(spec, /Start with Default Strategy"\)'\)\.first\(\)/, 'the strategy clicks live in the helper');
});

/** The lines that open the blocks around line i, innermost first. */
function enclosingOpeners (lines, i) {
  const openers = [];
  let depth = 0;
  for (let n = i - 1; n >= 0; n--) {
    const text = lines[n].replace(/'[^']*'|`[^`]*`|"[^"]*"/g, '');
    for (const ch of [...text].reverse()) {
      if (ch === '}') depth++;
      if (ch === '{') {
        if (depth === 0) openers.push(n);
        else depth--;
      }
    }
  }
  return openers;
}

/** True when line i can only run with DRY_RUN off: inside `if (!DRY_RUN)`, or an else of `if (DRY_RUN)`. */
function gatedOnDryRun (lines, i) {
  if (/!DRY_RUN/.test(lines[i])) return true;
  return enclosingOpeners(lines, i).some(n => {
    if (/!DRY_RUN/.test(lines[n])) return true;
    let at = n;
    while (/^\s*\}\s*else/.test(lines[at])) {
      at = enclosingOpeners(lines, at).length ? branchStart(lines, at) : at;
      if (/\bif \(DRY_RUN\)/.test(lines[at])) return true;
    }
    return false;
  });
}

/** The line that opened the branch closed by the `}` at the start of line i. */
function branchStart (lines, i) {
  let depth = 1;
  for (let n = i - 1; n >= 0; n--) {
    const text = lines[n].replace(/'[^']*'|`[^`]*`|"[^"]*"/g, '');
    for (const ch of [...text].reverse()) {
      if (ch === '}') depth++;
      if (ch === '{' && --depth === 0) return n;
    }
  }
  return 0;
}

test('every click that changes something outside the page is gated on DRY_RUN in the batch', () => {
  const lines = source('batch-with-login.spec.ts').split('\n');
  const writes = /\b(followBtn|likeBtn|connectBtn|completeBtn|sendBtn|sentCheckbox|dmInput)\.(click|check|fill)\(/;
  const hits = lines.map((l, i) => [l, i]).filter(([l]) => writes.test(l));
  assert.ok(hits.length >= 8, `found ${hits.length} write clicks`);
  const ungated = hits.filter(([, i]) => !gatedOnDryRun(lines, i));
  assert.deepStrictEqual(ungated.map(([l, i]) => `${i + 1}: ${l.trim()}`), []);
});

test('the DM providers check dry run before they touch the composer', () => {
  for (const [file, dry, typing] of [
    ['helpers/providers/linkedin-dm-provider.ts', 'if (this.dryRun)', 'inputEl.click()'],
    ['helpers/providers/instagram-dm-provider.ts', 'if (dryRun)', 'dmInput.click()'],
  ]) {
    const src = source(file);
    assert.ok(src.indexOf(dry) > 0 && src.indexOf(dry) < src.indexOf(typing), file);
  }
});
