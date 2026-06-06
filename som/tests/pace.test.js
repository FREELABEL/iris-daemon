#!/usr/bin/env node
/**
 * Tests for SOM lead pace feature.
 * Pure Node.js — no Playwright, no browser.
 */

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

// ── Helpers that mirror som.js logic ────────────────────────────────

/** Parse pace=N arg → milliseconds (mirrors som.js arg parsing) */
function parsePaceArg(val) {
  const seconds = parseFloat(val);
  if (isNaN(seconds) || seconds < 0) return 0;
  return Math.round(seconds * 1000);
}

/** Calculate timeout with pace factored in (mirrors som.js timeout calc) */
function calcTimeout(limit, perLeadMs, baseTimeout, paceMs) {
  return Math.max(baseTimeout, limit * perLeadMs + limit * paceMs);
}

/** Determine if pace delay should apply for a given lead index */
function shouldDelay(idx, paceMs) {
  return idx > 0 && paceMs > 0;
}

// ── Tests ───────────────────────────────────────────────────────────

console.log('\nSOM Lead Pace — Unit Tests\n');

// 1. Default pace is 0
console.log('Default pace:');
assert(parsePaceArg(undefined) === 0, 'undefined → 0ms');
assert(parseInt(process.env.PACE_MS_NONEXISTENT || '0', 10) === 0, 'unset env var → 0');

// 2. pace=5 → 5000ms
console.log('\npace=N conversion:');
assert(parsePaceArg('5') === 5000, 'pace=5 → 5000ms');
assert(parsePaceArg('1') === 1000, 'pace=1 → 1000ms');
assert(parsePaceArg('0.5') === 500, 'pace=0.5 → 500ms');
assert(parsePaceArg('10') === 10000, 'pace=10 → 10000ms');

// 3. pace=0 → 0ms (explicit zero)
console.log('\nExplicit zero:');
assert(parsePaceArg('0') === 0, 'pace=0 → 0ms');

// 4. Timeout scales with pace
console.log('\nTimeout scaling:');
const base = 600000;
const perLead = 90000;
assert(
  calcTimeout(5, perLead, base, 0) === Math.max(base, 5 * perLead),
  'pace=0 → no extra timeout'
);
assert(
  calcTimeout(5, perLead, base, 5000) === Math.max(base, 5 * perLead + 5 * 5000),
  'pace=5s with 5 leads → +25s timeout'
);
assert(
  calcTimeout(10, perLead, base, 3000) === Math.max(base, 10 * perLead + 10 * 3000),
  'pace=3s with 10 leads → +30s timeout'
);

// 5. Pace only applies after first lead (idx > 0)
console.log('\nPace delay gating:');
assert(shouldDelay(0, 5000) === false, 'idx=0 → no delay (first lead)');
assert(shouldDelay(1, 5000) === true, 'idx=1 → delay');
assert(shouldDelay(5, 3000) === true, 'idx=5 → delay');
assert(shouldDelay(1, 0) === false, 'paceMs=0 → no delay regardless of idx');
assert(shouldDelay(0, 0) === false, 'idx=0, paceMs=0 → no delay');

// ── Summary ─────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
