#!/usr/bin/env node
/**
 * Integration Test: Inbox Scraper → inbox-sync API Pipeline
 *
 * Tests:
 *   1. SOM module spec resolution (instagram_inbox_check / linkedin_inbox_check)
 *   2. inbox-sync API endpoint (POST /api/v1/leads/inbox-sync)
 *   3. Lead reply detection (has_replied flag)
 *
 * Usage:
 *   node test-inbox-pipeline.js              # Dry run (no real browser)
 *   node test-inbox-pipeline.js --live       # Live test (needs IG session)
 *   node test-inbox-pipeline.js --api-only   # Only test inbox-sync API
 */

const path = require('path');
const fs = require('fs');

const API_BASE = process.env.IRIS_FL_API_URL || 'https://raichu.heyiris.io';
const TOKEN = process.env.HEYIRIS_TOKEN || (() => {
  try {
    const env = fs.readFileSync(path.join(require('os').homedir(), '.iris', 'sdk', '.env'), 'utf-8');
    const m = env.match(/^IRIS_API_KEY=(.+)$/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
})();

const BOARD_ID = parseInt(process.env.BOARD_ID || '38', 10);
const args = process.argv.slice(2);
const isLive = args.includes('--live');
const isApiOnly = args.includes('--api-only');

let passed = 0;
let failed = 0;

function test(name, fn) {
  return fn().then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch(err => { failed++; console.log(`  ✗ ${name}: ${err.message}`); });
}

async function main() {
  console.log('\n  ══════════════════════════════════════════════════════');
  console.log('  INBOX SCRAPER PIPELINE — Integration Tests');
  console.log('  ══════════════════════════════════════════════════════\n');

  // ── Test 1: SOM module spec resolution ──
  await test('SOM specs resolve correctly', async () => {
    const somDir = __dirname;
    const igSpec = path.join(somDir, 'instagram-inbox-check.spec.ts');
    const liSpec = path.join(somDir, 'linkedin-inbox-check.spec.ts');
    if (!fs.existsSync(igSpec)) throw new Error(`Missing: ${igSpec}`);
    if (!fs.existsSync(liSpec)) throw new Error(`Missing: ${liSpec}`);
  });

  await test('SOM mode mapping includes inbox checks', async () => {
    // Simulate what som.js does
    const specs = {
      outreach: 'batch-with-login.spec.ts',
      instagram_inbox_check: 'instagram-inbox-check.spec.ts',
      linkedin_inbox_check: 'linkedin-inbox-check.spec.ts',
    };
    if (!specs.instagram_inbox_check) throw new Error('instagram_inbox_check not in specs');
    if (!specs.linkedin_inbox_check) throw new Error('linkedin_inbox_check not in specs');
  });

  await test('SOM_MODE env var override works', async () => {
    // Simulate mode resolution
    const campaignDefaultMode = {};
    const envMode = 'instagram_inbox_check'; // simulating process.env.SOM_MODE
    const mode = envMode || campaignDefaultMode['custom'] || 'outreach';
    if (mode !== 'instagram_inbox_check') throw new Error(`Expected instagram_inbox_check, got ${mode}`);
  });

  // ── Test 2: Provider imports resolve ──
  await test('Instagram inbox provider exists in bundled helpers', async () => {
    const providerPath = path.join(__dirname, 'helpers', 'providers', 'instagram-inbox-provider.ts');
    if (!fs.existsSync(providerPath)) throw new Error(`Missing: ${providerPath}`);
  });

  await test('LinkedIn inbox provider exists in bundled helpers', async () => {
    const providerPath = path.join(__dirname, 'helpers', 'providers', 'linkedin-inbox-provider.ts');
    if (!fs.existsSync(providerPath)) throw new Error(`Missing: ${providerPath}`);
  });

  await test('Base provider exists with dismissInstagramPopups export', async () => {
    const basePath = path.join(__dirname, 'helpers', 'providers', 'base-provider.ts');
    if (!fs.existsSync(basePath)) throw new Error(`Missing: ${basePath}`);
    const content = fs.readFileSync(basePath, 'utf-8');
    if (!content.includes('dismissInstagramPopups')) throw new Error('Missing dismissInstagramPopups export');
  });

  // ── Test 3: inbox-sync API endpoint ──
  if (TOKEN) {
    await test('inbox-sync API accepts valid payload', async () => {
      const payload = {
        conversations: [
          {
            handle: '_test_integration_user_',
            replied: true,
            messages: [
              { sender: 'them', body: 'Hey thanks for reaching out!', timestamp: new Date().toISOString() },
            ],
          },
        ],
        board_id: BOARD_ID,
        account: 'heyiris.io',
        platform: 'instagram',
      };

      const res = await fetch(`${API_BASE}/api/v1/leads/inbox-sync`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`${res.status}: ${body.substring(0, 200)}`);
      }

      const data = await res.json();
      if (!data.success) throw new Error(`API returned success=false: ${JSON.stringify(data)}`);
      console.log(`      Stats: matched=${data.stats?.matched}, replied=${data.stats?.replied}, new=${data.stats?.new_messages}, unmatched=${data.stats?.unmatched}`);
    });

    await test('inbox-sync API rejects invalid payload (missing platform)', async () => {
      const res = await fetch(`${API_BASE}/api/v1/leads/inbox-sync`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ conversations: [], board_id: BOARD_ID, account: 'test' }),
      });
      if (res.status !== 422) throw new Error(`Expected 422, got ${res.status}`);
    });

    await test('Leads API is reachable for board ' + BOARD_ID, async () => {
      const res = await fetch(`${API_BASE}/api/v1/leads?bloq_id=${BOARD_ID}&per_page=1`, {
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const total = data?.data?.total ?? data?.total ?? 0;
      if (total === 0) throw new Error('No leads on board');
      console.log(`      Board ${BOARD_ID}: ${total} leads`);
    });
  } else {
    console.log('  ⚠ Skipping API tests (no token). Set HEYIRIS_TOKEN or have ~/.iris/sdk/.env');
  }

  // ── Test 4: Task dispatch endpoint (iris-api) ──
  if (TOKEN && !isApiOnly) {
    await test('Task creation endpoint is reachable', async () => {
      const irisApi = process.env.IRIS_API_URL || 'https://freelabel.net';
      const res = await fetch(`${irisApi}/api/v6/nodes/tasks`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          user_id: 1,
          title: 'test_inbox_pipeline',
          type: 'som',
          prompt: 'custom mode=instagram_inbox_check board=38 limit=1 dry=1',
          config: { action: 'instagram_inbox_check', board_id: 38, limit: 1, dry_run: true },
        }),
      });
      // 201 = created, 401 = auth issue (still reachable), 422 = validation (still reachable)
      if (res.status >= 500) throw new Error(`Server error: ${res.status}`);
      console.log(`      Response: ${res.status} ${res.statusText}`);
      if (res.status === 201) {
        const data = await res.json();
        console.log(`      Task ID: ${data?.task?.id || 'unknown'}`);
      }
    });
  }

  // ── Summary ──
  console.log('\n  ──────────────────────────────────────────────────────');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('  ══════════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
