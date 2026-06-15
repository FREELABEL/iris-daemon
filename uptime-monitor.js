#!/usr/bin/env node
/**
 * uptime-monitor.js — local early-warning watcher for the freelabel-eco production stack.
 *
 * WHY THIS EXISTS
 * ---------------
 * On Jun 8, 2026 the Railway account was suspended for non-payment at ~12AM. Everything
 * went down for ~12 hours. Worse: even after billing was resolved at 11:50AM, the Redis
 * service came back with NO deployment (latestDeployment:null), so redis.railway.internal
 * stopped resolving and iris-api (cache+sessions) kept returning 500 on every client site.
 * We had zero automated warning on either failure. This watcher closes that gap.
 *
 * It deliberately runs LOCALLY (on Alex's Mac, via launchd) so it is independent of Railway —
 * if the whole account is suspended, this process is still alive to tell us.
 *
 * WHAT IT CHECKS (every run)
 *   1. HTTP health of the public endpoints below. A 5xx / timeout / connection refused = DOWN.
 *   2. `railway status --json` for ANY service whose latestDeployment is null/!=SUCCESS.
 *      This is the exact signature of the Jun 8 Redis death.
 *
 * ALERTS (only on state TRANSITIONS, so it doesn't spam)
 *   - Discord webhook  (PLATFORM_UPDATES_DISCORD_CHANNEL_WEBHOOK_URL)
 *   - macOS notification banner (always, zero-config)
 *   - iMessage to ALERT_IMESSAGE_HANDLE (optional — set in .env to your own number/email)
 *
 * USAGE
 *   node uptime-monitor.js            # one cycle, then exit (designed for launchd StartInterval)
 *   node uptime-monitor.js --loop     # run forever, checking every CHECK_INTERVAL_MS
 *   node uptime-monitor.js --once     # alias for the default single-cycle behaviour
 *   node uptime-monitor.js --test     # send a test alert to all channels and exit
 *
 * State is persisted to .uptime-monitor-state.json so single-cycle runs remember what was
 * already DOWN and only alert on changes (down -> up, up -> down).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');

// ----------------------------------------------------------------------------- config
const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, '.uptime-monitor-state.json');
const ENV_FILE = path.join(ROOT, '.env');

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // --loop cadence
const HTTP_TIMEOUT_MS = 20 * 1000;
const FAILS_BEFORE_ALERT = 2; // consecutive failed cycles before we declare DOWN (avoid cold-start blips)

// Public endpoints. healthPath 200 = healthy. Anything else (incl. 5xx) = failing.
const ENDPOINTS = [
  { name: 'iris-api (freelabel.net)', url: 'https://freelabel.net/api/health', expect: 200 },
  { name: 'fl-api (raichu)', url: 'https://raichu.heyiris.io/api/health', expect: 200 },
  { name: 'web frontend', url: 'https://web.heyiris.io', expect: 200 },
  // CDN assets. The Jun 5–8 DO account suspension 403'd every client image with zero warning.
  // Probing a known public asset catches a CDN outage in 5 min — and, while DO is suspended,
  // the recovery alert is our cue that we can finally export/mirror the bucket.
  { name: 'CDN asset (DO Spaces)', url: ENV.CDN_DO_PROBE_URL || 'https://iris-cdn.sfo3.cdn.digitaloceanspaces.com/assets/moody-beauty/logo.png', expect: 200 },
];

// Once cdn.heyiris.io (Cloudflare R2) is live, set CDN_PROBE_URL to a known asset there
// and it joins the watch list automatically.
if (ENV.CDN_PROBE_URL) {
  ENDPOINTS.push({ name: 'CDN asset (cdn.heyiris.io)', url: ENV.CDN_PROBE_URL, expect: 200 });
}

// Railway services we never expect to be deployment-less. Empty = check ALL services.
const RAILWAY_ENV = 'production';

// ----------------------------------------------------------------------------- env loader (no dep on dotenv being present)
function loadEnv() {
  const env = { ...process.env };
  try {
    const raw = fs.readFileSync(ENV_FILE, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && env[m[1]] === undefined) {
        env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch (_) { /* .env optional */ }
  return env;
}
const ENV = loadEnv();
const DISCORD_WEBHOOK = ENV.PLATFORM_UPDATES_DISCORD_CHANNEL_WEBHOOK_URL || ENV.ALERT_DISCORD_WEBHOOK_URL || '';
const IMESSAGE_HANDLE = ENV.ALERT_IMESSAGE_HANDLE || '';

// ----------------------------------------------------------------------------- helpers
function nowIso() {
  // Date is fine here (real process, not a replayable workflow)
  return new Date().toISOString();
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    return { components: {}, lastRun: null };
  }
}
function writeState(state) {
  state.lastRun = nowIso();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function httpCheck(endpoint) {
  return new Promise((resolve) => {
    const lib = endpoint.url.startsWith('https') ? https : http;
    const started = Date.now();
    const req = lib.get(endpoint.url, { timeout: HTTP_TIMEOUT_MS }, (res) => {
      // drain
      res.on('data', () => {});
      res.on('end', () => {
        const ms = Date.now() - started;
        const ok = res.statusCode === endpoint.expect;
        resolve({ ok, status: res.statusCode, ms, detail: `${res.statusCode} in ${ms}ms` });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, ms: HTTP_TIMEOUT_MS, detail: `timeout >${HTTP_TIMEOUT_MS}ms` }); });
    req.on('error', (e) => { resolve({ ok: false, status: 0, ms: Date.now() - started, detail: e.code || e.message }); });
  });
}

function railwayStatus() {
  return new Promise((resolve) => {
    execFile('railway', ['status', '--json'], { cwd: process.cwd(), timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const authBroken = /Unauthorized|run `railway login`/i.test(`${err.message}${stderr || ''}`);
        resolve({ ok: false, authBroken, reason: `railway CLI error: ${err.message}`, dead: [] });
        return;
      }
      try {
        const d = JSON.parse(stdout);
        const envs = (d.environments && d.environments.edges) || [];
        const target = envs.find((e) => e.node && e.node.name === RAILWAY_ENV) || envs[0];
        if (!target) { resolve({ ok: false, reason: 'no environments in railway status', dead: [] }); return; }
        const dead = [];
        for (const si of (target.node.serviceInstances.edges || [])) {
          const s = si.node;
          const ld = s.latestDeployment;
          const status = ld ? ld.status : null;
          if (status !== 'SUCCESS') {
            dead.push({ service: s.serviceName, status: status === null ? 'NO_DEPLOYMENT' : status });
          }
        }
        resolve({ ok: dead.length === 0, reason: dead.length ? 'services not SUCCESS' : 'all SUCCESS', dead });
      } catch (e) {
        resolve({ ok: false, reason: `parse error: ${e.message}`, dead: [] });
      }
    });
  });
}

// ----------------------------------------------------------------------------- alerting
function postDiscord(content) {
  return new Promise((resolve) => {
    if (!DISCORD_WEBHOOK) { resolve(false); return; }
    const body = JSON.stringify({ content: content.slice(0, 1900) });
    const u = new URL(DISCORD_WEBHOOK);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode < 300)); });
    req.on('error', () => resolve(false));
    req.write(body); req.end();
  });
}

function macNotify(title, message) {
  return new Promise((resolve) => {
    const safe = (s) => s.replace(/["\\]/g, '').replace(/'/g, '');
    const script = `display notification "${safe(message).slice(0, 200)}" with title "${safe(title)}" sound name "Sosumi"`;
    execFile('osascript', ['-e', script], () => resolve(true));
  });
}

function sendIMessage(text) {
  return new Promise((resolve) => {
    if (!IMESSAGE_HANDLE) { resolve(false); return; }
    const safe = text.replace(/["\\]/g, '').replace(/'/g, '');
    const script = `tell application "Messages" to send "${safe.slice(0, 800)}" to buddy "${IMESSAGE_HANDLE}" of (service 1 whose service type is iMessage)`;
    execFile('osascript', ['-e', script], (err) => resolve(!err));
  });
}

async function alert(title, message) {
  const line = `${title}\n${message}`;
  const results = await Promise.all([
    macNotify(title, message),
    postDiscord(`**${title}**\n${message}`),
    sendIMessage(line),
  ]);
  console.log(`[alert] mac=${results[0]} discord=${results[1]} imessage=${results[2]}`);
}

// ----------------------------------------------------------------------------- main cycle
async function runCycle() {
  const state = readState();
  state.components = state.components || {};
  const ts = nowIso();
  const downNow = [];
  const recovered = [];

  // 1) HTTP endpoints — require FAILS_BEFORE_ALERT consecutive failures before declaring DOWN
  for (const ep of ENDPOINTS) {
    const key = `http:${ep.name}`;
    const prev = state.components[key] || { down: false, fails: 0 };
    const r = await httpCheck(ep);
    console.log(`[http] ${ep.name}: ${r.ok ? 'OK' : 'FAIL'} (${r.detail})`);
    if (r.ok) {
      if (prev.down) recovered.push(`✅ ${ep.name} recovered (${r.detail})`);
      state.components[key] = { down: false, fails: 0, lastDetail: r.detail, ts };
    } else {
      const fails = (prev.fails || 0) + 1;
      const isDown = fails >= FAILS_BEFORE_ALERT;
      if (isDown && !prev.down) downNow.push(`🔴 ${ep.name} DOWN (${r.detail}, ${fails} consecutive)`);
      state.components[key] = { down: isDown, fails, lastDetail: r.detail, ts };
    }
  }

  // 2) Railway deployment-loss check (the Redis-death signature)
  const rw = await railwayStatus();
  const key = 'railway:deployments';
  const prev = state.components[key] || { down: false };
  if (rw.dead && rw.dead.length) {
    const list = rw.dead.map((d) => `${d.service}=${d.status}`).join(', ');
    console.log(`[railway] DEAD SERVICES: ${list}`);
    if (!prev.down) downNow.push(`🔴 Railway service(s) lost deployment: ${list} — client sites may 500. Redeploy via GraphQL serviceInstanceDeployV2.`);
    state.components[key] = { down: true, list, ts };
  } else if (rw.ok) {
    console.log('[railway] all services SUCCESS');
    if (prev.down) recovered.push('✅ Railway: all services redeployed and SUCCESS');
    state.components[key] = { down: false, ts };
  } else {
    console.log(`[railway] check inconclusive: ${rw.reason}`);
    // don't flip uptime state on an inconclusive CLI error — but DO warn once if the CLI
    // is logged out, because a broken `railway` CLI is our blind spot + recovery tool.
    const authKey = 'railway:auth';
    const authPrev = state.components[authKey] || { down: false };
    if (rw.authBroken) {
      if (!authPrev.down) downNow.push('⚠️ Railway CLI is logged out (Unauthorized) — deployment-loss detection is BLIND and you cannot redeploy a dead service until you run `railway login`.');
      state.components[authKey] = { down: true, ts };
    } else if (authPrev.down) {
      // a non-auth inconclusive error after auth was broken doesn't prove recovery; leave as-is
    }
  }

  // clear the railway auth warning once the deployment check succeeds again
  if (rw.ok || (rw.dead && rw.dead.length)) {
    const authKey = 'railway:auth';
    if (state.components[authKey] && state.components[authKey].down) {
      recovered.push('✅ Railway CLI re-authenticated — deployment-loss detection restored');
      state.components[authKey] = { down: false, ts };
    }
  }

  writeState(state);

  // 3) fire alerts on transitions
  if (downNow.length) await alert('🚨 IRIS production ALERT', downNow.join('\n'));
  if (recovered.length) await alert('✅ IRIS production recovered', recovered.join('\n'));

  const anyDown = Object.values(state.components).some((c) => c.down);
  console.log(`[cycle] ${ts} — overall: ${anyDown ? 'DEGRADED' : 'healthy'}`);
  return anyDown;
}

// ----------------------------------------------------------------------------- entrypoint
(async () => {
  const args = process.argv.slice(2);
  if (args.includes('--test')) {
    await alert('🧪 IRIS monitor test', `Test alert from uptime-monitor at ${nowIso()}. Discord=${!!DISCORD_WEBHOOK} iMessage=${!!IMESSAGE_HANDLE}`);
    process.exit(0);
  }
  if (args.includes('--loop')) {
    console.log(`[uptime-monitor] loop mode, every ${CHECK_INTERVAL_MS / 1000}s`);
    /* eslint-disable no-constant-condition */
    while (true) {
      try { await runCycle(); } catch (e) { console.error('[cycle error]', e.message); }
      await new Promise((r) => setTimeout(r, CHECK_INTERVAL_MS));
    }
  } else {
    try { await runCycle(); process.exit(0); } catch (e) { console.error('[fatal]', e.message); process.exit(1); }
  }
})();
