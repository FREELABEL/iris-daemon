/**
 * A dry run changes nothing (#191666).
 *
 * On 2026-10-28 a UI-mode dry run clicked "Apply Strategy" on five real leads. One-step strategies then
 * read as finished and the next real run skipped those people with no DM ever sent. Three layers, so one
 * missed click cannot do that again:
 *   1. applyTargetStrategy: the panel's strategy buttons are never clicked in a dry run.
 *   2. stubApiWrites: every write on LeadgenApiClient is replaced with a log line.
 *   3. installDryRunGuard: the browser cannot POST/PUT/PATCH/DELETE to our API at all, whatever gets clicked.
 */

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const OUR_HOST_SUFFIXES = ['heyiris.io', 'freelabel.net'];
// Stateless AI calls: they return text and save nothing, and the panel needs them to show the message.
const READ_ONLY_POSTS = [/\/ai\/generate-variation\/?$/, /\/ai\/generate-personalized-message\/?$/];

// Every LeadgenApiClient method that writes. tests/dry-run-guard.test.js fails if one is added and not listed.
const API_WRITE_METHODS = [
  'addNote', 'completeStep', 'createLead', 'createLeadsBatch', 'deleteLead', 'enrichLead',
  'generateEmailDraft', 'initializeOutreach', 'logComms', 'quickEnrichInstagram', 'recordDmSent',
  'resolveTags', 'sendEmail', 'updateLead', 'updateLeadTags',
];

function hostMatches (url, suffixes) {
  let host;
  try { host = new URL(url).hostname; } catch { return false; }
  return suffixes.some(s => host === s || host.endsWith(`.${s}`));
}

function isBlockedInDryRun (method, url, { hostSuffixes = OUR_HOST_SUFFIXES } = {}) {
  if (READ_METHODS.has(String(method).toUpperCase())) return false;
  if (!hostMatches(url, hostSuffixes)) return false;
  const path = new URL(url).pathname;
  return !READ_ONLY_POSTS.some(re => re.test(path));
}

/** Refuse every write the browser tries to make to our API for the rest of this context's life. */
async function installDryRunGuard (context, { hostSuffixes = OUR_HOST_SUFFIXES, log = console.log } = {}) {
  await context.route(url => hostMatches(String(url), hostSuffixes), async route => {
    const req = route.request();
    if (isBlockedInDryRun(req.method(), req.url(), { hostSuffixes })) {
      log(`    [DRY RUN] Blocked ${req.method()} ${new URL(req.url()).pathname}`);
      return route.abort('blockedbyclient');
    }
    return route.fallback();
  });
}

/** Replace every write on an API client with a log line. Reads stay real. */
function stubApiWrites (client, { log = console.log } = {}) {
  for (const name of API_WRITE_METHODS) {
    client[name] = async (first, second) => {
      const detail = typeof second === 'string' ? second : JSON.stringify(second ?? '');
      log(`    [DRY] Would ${name} on ${JSON.stringify(first)}: ${String(detail).substring(0, 120)}`);
      return { success: true, message: 'dry run — not written' };
    };
  }
  return client;
}

/**
 * Put the target strategy on the lead whose Outreach panel is open. Only the caller's "fresh" or
 * "has-apply" panels get here; a lead that already has steps must not be re-applied.
 * @returns {Promise<'dry-run'|'applied'|'not-found'|'no-button'>}
 */
async function applyTargetStrategy (page, { dryRun, strategyName, outreachState, log = console.log }) {
  if (dryRun) {
    log(`→ [DRY RUN] Would apply "${strategyName}" (panel: ${outreachState}); nothing clicked, lead unchanged`);
    return 'dry-run';
  }

  if (outreachState === 'fresh') {
    // Fresh lead: "Start with Default Strategy" initializes the panel. This creates default steps,
    // which the target strategy replaces immediately below.
    const startDefault = page.locator('button:has-text("Start with Default Strategy")').first();
    if (await startDefault.isVisible({ timeout: 3000 }).catch(() => false)) {
      log('→ Fresh lead — Start with Default Strategy...');
      await startDefault.click();
      // Poll for the Apply Strategy button (appears once default steps are created)
      for (let aw = 0; aw < 20; aw++) {
        const hasApply = await page.locator('button:has-text("Apply Strategy")').first().isVisible().catch(() => false);
        const hasApplyShort = await page.locator('button:has-text("Apply")').first().isVisible().catch(() => false);
        if (hasApply || hasApplyShort) break;
        await page.waitForTimeout(500);
      }
    }
  }

  const applyBtn = page.locator('button:has-text("Apply Strategy")').first();
  if (!(await applyBtn.isVisible({ timeout: 15000 }).catch(() => false))) return 'no-button';
  log('→ Apply Strategy...');
  await applyBtn.click();

  const strat = page.locator(`button:has-text("${strategyName}")`).first();
  if (!(await strat.isVisible({ timeout: 10000 }).catch(() => false))) return 'not-found';
  log(`→ Selecting ${strategyName}`);
  await strat.click();

  const confirm = page.locator('button.swal2-confirm').first();
  if (await confirm.isVisible({ timeout: 5000 }).catch(() => false)) {
    log('→ Confirming replacement...');
    await confirm.click();
    // Wait for API to create steps + UI to re-render
    for (let pw = 0; pw < 15; pw++) {
      const playCount = await page.locator('button[title="Generate message"]').count().catch(() => 0);
      if (playCount > 0) break;
      await page.waitForTimeout(500);
    }
  }
  return 'applied';
}

module.exports = { API_WRITE_METHODS, isBlockedInDryRun, installDryRunGuard, stubApiWrites, applyTargetStrategy };
