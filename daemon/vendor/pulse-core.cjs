/* @heyiris/pulse-core 0.2.0 */
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// src/index.ts
var exports_src = {};
__export(exports_src, {
  zonedAt: () => zonedAt,
  weekOf: () => weekOf,
  unwrap: () => unwrap,
  untilOf: () => untilOf,
  toolsOfRun: () => toolsOfRun,
  toolsOf: () => toolsOf,
  tokensOf: () => tokensOf,
  stripOf: () => stripOf,
  stateSince: () => stateSince,
  stateOf: () => stateOf,
  sortBeats: () => sortBeats,
  silentSince: () => silentSince,
  shortAgo: () => shortAgo,
  sectionsOf: () => sectionsOf,
  scriptFor: () => scriptFor,
  runStop: () => runStop,
  runScript: () => runScript,
  runAt: () => runAt,
  rollupOf: () => rollupOf,
  resetExtensions: () => resetExtensions,
  registerDefault: () => registerDefault,
  readSchedule: () => readSchedule,
  readRun: () => readRun,
  readHeartbeat: () => readHeartbeat,
  queryHeartbeats: () => queryHeartbeats,
  problemsOf: () => problemsOf,
  previewOf: () => previewOf,
  periodOf: () => periodOf,
  partsIn: () => partsIn,
  parseSince: () => parseSince,
  nextFireAt: () => nextFireAt,
  modeOf: () => modeOf,
  mayAct: () => mayAct,
  lineOf: () => lineOf,
  laundered: () => laundered,
  lastRun: () => lastRun,
  lastBeatAt: () => lastBeatAt,
  kindOf: () => kindOf,
  isHeartbeatJob: () => isHeartbeatJob,
  hoursOf: () => hoursOf,
  heldForHours: () => heldForHours,
  formatCount: () => formatCount,
  firesAt: () => firesAt,
  extend: () => extend,
  errorOf: () => errorOf,
  durationOf: () => durationOf,
  cadenceOf: () => cadenceOf,
  cadenceDrift: () => cadenceDrift,
  byDesign: () => byDesign,
  beatSummary: () => beatSummary,
  beatStory: () => beatStory,
  ago: () => ago,
  TIMELINE: () => TIMELINE,
  RUNS_PER_ROW: () => RUNS_PER_ROW,
  LIVE_STATUSES: () => LIVE_STATUSES,
  LATE_AFTER_MS: () => LATE_AFTER_MS,
  HISTORY_KEPT_SINCE: () => HISTORY_KEPT_SINCE,
  BEAT_STATES: () => BEAT_STATES
});
module.exports = __toCommonJS(exports_src);

// src/time.ts
function shortAgo(iso, now) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t))
    return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60)
    return "now";
  if (s < 3600)
    return `${Math.floor(s / 60)}m`;
  if (s < 86400)
    return `${Math.floor(s / 3600)}h`;
  const d = Math.floor(s / 86400);
  return d < 14 ? `${d}d` : d < 365 ? `${Math.floor(d / 7)}w` : `${Math.floor(d / 365)}y`;
}
function ago(iso, now) {
  if (!iso)
    return "never";
  const s = (now - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s))
    return "unknown";
  if (s < 120)
    return "just now";
  if (s < 3600)
    return `${Math.floor(s / 60)} min ago`;
  if (s < 86400)
    return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : d < 14 ? `${d} days ago` : `${Math.floor(d / 7)} weeks ago`;
}

// src/heartbeats.ts
var HISTORY_KEPT_SINCE = Date.parse("2026-10-13T00:16:00Z");
var LATE_AFTER_MS = 15 * 60000;
var UNITS = {
  minute: [60000, "minute"],
  minutes: [60000, "minute"],
  hour: [3600000, "hour"],
  hours: [3600000, "hour"],
  day: [86400000, "day"],
  days: [86400000, "day"],
  week: [604800000, "week"],
  weeks: [604800000, "week"]
};
var NAMED = {
  hourly: [3600000, "Every hour"],
  daily: [86400000, "Every day"],
  weekly: [604800000, "Every week"],
  weekdays: [86400000, "Weekdays"],
  monthly: [2592000000, "Every month"],
  once: [0, "Once"]
};
function cadenceOf(frequency) {
  if (!frequency)
    return "No schedule";
  const f = frequency.toLowerCase();
  if (NAMED[f])
    return NAMED[f][1];
  const m = /^every_(\d+)_([a-z]+)$/.exec(f);
  if (m && UNITS[m[2]]) {
    const n = Number(m[1]);
    const unit = UNITS[m[2]][1];
    return n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
  }
  return frequency.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
var t = (iso) => iso ? Date.parse(iso) : NaN;
function periodOf(frequency) {
  if (!frequency)
    return null;
  const f = frequency.toLowerCase();
  if (NAMED[f])
    return NAMED[f][0] || null;
  if (/^daily_/.test(f))
    return 86400000;
  const m = /^every_(\d+)_([a-z]+)$/.exec(f);
  if (m && UNITS[m[2]])
    return Number(m[1]) * UNITS[m[2]][0];
  return null;
}
var PARTS = new Map;
function fmt(tz) {
  let f = PARTS.get(tz);
  if (!f) {
    const o = {
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    };
    try {
      f = new Intl.DateTimeFormat("en-US", { ...o, timeZone: tz });
    } catch {
      f = new Intl.DateTimeFormat("en-US", { ...o, timeZone: "UTC" });
    }
    PARTS.set(tz, f);
  }
  return f;
}
function partsIn(ms, tz) {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    dow: String(p.weekday).slice(0, 3).toLowerCase(),
    minutes: Number(p.hour) * 60 + Number(p.minute),
    y: Number(p.year),
    mo: Number(p.month),
    d: Number(p.day)
  };
}
function zonedAt(y, mo, d, minutes, tz) {
  const wall = Date.UTC(y, mo - 1, d, 0, minutes);
  const off = (ms) => {
    const p = partsIn(ms, tz);
    return Date.UTC(p.y, p.mo - 1, p.d, 0, p.minutes) - Math.floor(ms / 60000) * 60000;
  };
  let guess = wall - off(wall);
  guess = wall - off(guess);
  return guess;
}
var hm = (s) => {
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
function mayAct(r, ms) {
  const sc = r.schedule;
  if (!sc)
    return true;
  const { dow, minutes } = partsIn(ms, sc.timezone);
  if (sc.days.length && !sc.days.includes(dow))
    return false;
  if (sc.hours && (minutes < hm(sc.hours.start) || minutes >= hm(sc.hours.end)))
    return false;
  return true;
}
function firesAt(r, ms) {
  const sc = r.schedule;
  if (!sc || mayAct(r, ms))
    return ms;
  const start = sc.hours ? hm(sc.hours.start) : 0;
  for (let i = 0;i <= 8; i++) {
    const p = partsIn(ms + i * 86400000, sc.timezone);
    if (sc.days.length && !sc.days.includes(p.dow))
      continue;
    const open = zonedAt(p.y, p.mo, p.d, start, sc.timezone);
    if (open > ms)
      return open;
  }
  return ms;
}
var byDesign = (reason) => !!reason && /^Outside (working days|active hours)/i.test(reason);
var runAt = (x) => t(x.startedAt ?? x.completedAt);
var ERROR_REPLY = /^\s*(?:Error:|AI API error)/i;
function laundered(x) {
  if (x.status === "failed" || x.status === "error" || x.error)
    return false;
  return ERROR_REPLY.test(x.response ?? x.preview ?? "");
}
function kindOf(x) {
  if (x.status === "running" || x.status === "pending")
    return "run";
  return failed(x) ? "fail" : "ok";
}
function errorOf(x) {
  if (x.error)
    return oneLine(x.error);
  if (laundered(x))
    return oneLine((x.response ?? x.preview ?? "").replace(/^\s*Error:\s*/i, "").replace(/\s*-\s*\{[\s\S]*$/, ""));
  return null;
}
function lastRun(r) {
  return r.runs.find((x) => x.status !== "running" && x.status !== "pending");
}
function lastBeatAt(r) {
  const x = lastRun(r);
  return x?.completedAt ?? x?.startedAt ?? null;
}
function silentSince(r, now = Date.now()) {
  if (!r.runsMeasured)
    return null;
  const beatIso = lastBeatAt(r);
  const beat = t(beatIso);
  const skip = r.lastSkip;
  if (skip && Number.isFinite(t(skip.at)) && !(t(skip.at) <= beat)) {
    return byDesign(skip.reason) ? null : beatIso ?? "never";
  }
  const period = periodOf(r.frequency) ?? 86400000;
  const since = Math.max(Number.isFinite(beat) ? beat : -Infinity, HISTORY_KEPT_SINCE);
  if (now > HISTORY_KEPT_SINCE && firesAt(r, since + period) < now - LATE_AFTER_MS)
    return beatIso ?? "never";
  const woke = t(r.lastRunAt);
  if (!Number.isFinite(woke))
    return null;
  const from = Number.isFinite(beat) ? beat : woke - 7 * 86400000;
  if (woke - from <= Math.max(LATE_AFTER_MS, Number.isFinite(beat) ? period / 2 : 0))
    return null;
  for (let k = woke, n = 0;k > from + LATE_AFTER_MS && n < 2000; k -= period, n++)
    if (mayAct(r, k))
      return beatIso ?? "never";
  return null;
}
function cadenceDrift(r) {
  const a = r.settingsFrequency;
  if (!a || !r.frequency || a === r.frequency)
    return null;
  if (/^daily(_|$)/.test(a) && r.frequency === "daily")
    return null;
  return a;
}
function hoursOf(r) {
  const sc = r.schedule;
  if (!sc)
    return null;
  const order = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const days = order.filter((d) => sc.days.includes(d));
  const label = (d) => d[0].toUpperCase() + d.slice(1);
  const dayTxt = !days.length || days.length === 7 ? "Every day" : days.length === 5 && days.join() === "mon,tue,wed,thu,fri" ? "Weekdays" : days.every((d, i) => i === 0 || order.indexOf(d) === order.indexOf(days[i - 1]) + 1) && days.length > 2 ? `${label(days[0])}–${label(days[days.length - 1])}` : days.map(label).join(", ");
  const tz = sc.timezone === "America/New_York" ? "ET" : sc.timezone === "UTC" ? "UTC" : sc.timezone.split("/").pop().replace(/_/g, " ");
  return sc.hours ? `${dayTxt} · ${sc.hours.start}–${sc.hours.end} ${tz}` : `${dayTxt} · ${tz}`;
}
var failed = (x) => x.status === "failed" || x.status === "error" || !!x.error || ERROR_REPLY.test(x.response ?? x.preview ?? "");
function stateOf(r, now) {
  if (r.status === "paused")
    return "paused";
  if (r.status === "running" || r.runs[0]?.status === "running")
    return "running";
  const next = t(r.nextRunAt);
  if (r.status === "scheduled" && Number.isFinite(next) && now - firesAt(r, next) > LATE_AFTER_MS)
    return "late";
  if (silentSince(r, now))
    return "silent";
  const last = lastRun(r);
  if (r.status === "failed" || (last ? failed(last) : r.lastOk === false))
    return "failing";
  return "ok";
}
function problemsOf(r, now) {
  const out = [];
  const s = stateOf(r, now);
  if (s === "late")
    out.push({
      kind: "late",
      text: `Missed its beat — due ${ago(r.nextRunAt, now)}`,
      fix: "The scheduler has not picked it up, though it still says scheduled. Run it now; if it stays late, pause and resume it to reschedule."
    });
  const quiet = silentSince(r, now);
  const why = r.lastSkip && !byDesign(r.lastSkip.reason) ? r.lastSkip.reason : null;
  if (s === "silent" && quiet)
    out.push({
      kind: "silent",
      text: (quiet === "never" ? `Wakes up but has never done anything — woke ${ago(r.lastSkip?.at ?? r.lastRunAt, now)}` : `Wakes up but does nothing — last real beat ${ago(quiet, now)}`) + (why ? ` · ${oneLine(why)}` : ""),
      fix: why ? r.lastSkip?.kind === "circuit_breaker" ? "It was paused after repeated failures. Fix the cause in its last failed beat, then Run now to resume." : "That is the reason the platform gave for its last skipped wake." : "Its schedule moves on, but no run is recorded during its working hours: the beats are being skipped (gated, or no projects to watch). Run now shows the reason; the platform records it once #189113 lands."
    });
  const drift = cadenceDrift(r);
  if (drift)
    out.push({
      kind: "config",
      text: `Its settings say ${cadenceOf(drift).toLowerCase()}; it actually wakes ${cadenceOf(r.frequency).toLowerCase()}`,
      fix: "The heartbeat editor shows one cadence and the scheduler fires on another (#189170). Save the schedule again in the editor so both agree."
    });
  const last = lastRun(r);
  const fails = r.runs.filter(failed).length;
  if (r.status === "failed")
    out.push({
      kind: "stopped",
      text: "Stopped after failing",
      fix: "fl-api gave up retrying. Read the last error, fix the cause, then Run now."
    });
  else if (last && failed(last))
    out.push({
      kind: "failing",
      text: `Last beat failed${errorOf(last) ? `: ${errorOf(last)}` : ""}`,
      fix: (laundered(last) ? "It was recorded as a success — the model call failed and its error became the reply (#189114). " : "") + (fails > 1 ? `${fails} of the last ${r.runs.length} beats failed.` : "The beat before it worked.")
    });
  else if (!last && r.lastOk === false)
    out.push({ kind: "failing", text: `Last beat failed${r.lastError ? `: ${oneLine(r.lastError)}` : ""}`, fix: "" });
  return out;
}
var oneLine = (s) => {
  const l = s.replace(/\s+/g, " ").trim();
  return l.length > 140 ? `${l.slice(0, 139)}…` : l;
};
function untilOf(iso, now) {
  const at = t(iso);
  if (!Number.isFinite(at))
    return "—";
  const d = at - now;
  if (d <= 0)
    return shortAgo(iso, now) === "now" ? "now" : `${shortAgo(iso, now)} ago`;
  const m = Math.round(d / 60000);
  if (m < 60)
    return `in ${Math.max(1, m)}m`;
  const h = Math.round(m / 60);
  if (h < 48)
    return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}
function nextFireAt(r) {
  const n = t(r.nextRunAt);
  if (!Number.isFinite(n))
    return null;
  return new Date(firesAt(r, n)).toISOString();
}
var heldForHours = (r) => {
  const n = t(r.nextRunAt);
  return Number.isFinite(n) && firesAt(r, n) - n > 60000;
};
function lineOf(r, now) {
  const s = stateOf(r, now);
  const last = lastBeatAt(r);
  const lastTxt = last ? `last beat ${ago(last, now)}` : "never beat";
  if (s === "paused")
    return `Paused · ${lastTxt}`;
  if (s === "running")
    return "Beating now";
  if (s === "late")
    return `Late · due ${ago(r.nextRunAt, now)}`;
  if (s === "silent") {
    const why = r.lastSkip && !byDesign(r.lastSkip.reason) && r.lastSkip.reason ? ` · ${oneLine(r.lastSkip.reason).slice(0, 60)}` : "";
    return `Wakes but does nothing · ${last ? `last real beat ${ago(last, now)}` : "never ran"}${why}`;
  }
  if (s === "failing")
    return `Last beat failed · next ${untilOf(nextFireAt(r), now)}`;
  return `Next ${untilOf(nextFireAt(r), now)}${heldForHours(r) ? " · held for its hours" : ""} · ${lastTxt}`;
}
var RANK = { late: 0, silent: 1, failing: 2, running: 3, ok: 4, paused: 5 };
function sortBeats(rows, now) {
  return [...rows].sort((a, b) => {
    const r = RANK[stateOf(a, now)] - RANK[stateOf(b, now)];
    if (r)
      return r;
    const na = t(a.nextRunAt);
    const nb = t(b.nextRunAt);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb)
      return na - nb;
    return a.agentName.localeCompare(b.agentName);
  });
}
function beatSummary(rows, now) {
  const states = rows.map((r) => stateOf(r, now));
  return {
    total: rows.length,
    beating: states.filter((s) => s === "ok" || s === "running").length,
    attention: states.filter((s) => s === "late" || s === "silent" || s === "failing").length,
    paused: states.filter((s) => s === "paused").length
  };
}
function stripOf(r, n = 12) {
  return r.runs.slice(0, n).reverse().map(kindOf);
}
function modeOf(mode) {
  switch (mode) {
    case "autonomous":
      return "Acts on its own";
    case "reactive":
      return "Reacts to changes";
    case "passive":
      return "Watches and reports";
    case "briefing":
      return "Sends a briefing";
    default:
      return mode ? mode : "—";
  }
}
function durationOf(ms) {
  if (ms == null || !Number.isFinite(ms))
    return "—";
  if (ms < 1000)
    return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s}s` : `${Math.round(s / 60)}m`;
}
function tokensOf(n) {
  if (n == null)
    return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n);
}
function previewOf(text) {
  if (!text)
    return "";
  return text.replace(/```[\s\S]*?```/g, " ").replace(/[*`#>]+/g, "").replace(/^\s*(?:[-•✓✗]\s*)+/gm, "").replace(/\s+/g, " ").trim();
}
var DAY = 86400000;
var DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
var DOW_LABEL = { sun: "Sun", mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat" };
function weekOf(r, now) {
  const end = now;
  const start = now - 7 * DAY;
  const startOfDay = (ms) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const worksDay = (ms) => !r.schedule?.days.length || r.schedule.days.includes(partsIn(ms + 12 * 3600000, r.schedule.timezone).dow);
  const days = [];
  for (let d = startOfDay(start + DAY);d <= end; d += DAY)
    days.push({ at: d, label: DOW_LABEL[DOW[new Date(d).getDay()]], on: worksDay(d) });
  const period = periodOf(r.frequency);
  const next = t(r.nextRunAt);
  const fires = new Set;
  let outside = 0;
  if (period && Number.isFinite(next) && r.status !== "paused") {
    const from = start - 7 * DAY;
    let t2 = next - Math.ceil((next - from) / period) * period;
    for (let n = 0;t2 <= end && n < 2000; n++) {
      const f = firesAt(r, t2);
      if (t2 > start && f !== t2)
        outside++;
      if (f > end)
        break;
      if (f > start)
        fires.add(Math.round(f / 60000) * 60000);
      t2 = f + period;
    }
  }
  const expected = [...fires].sort((a, b) => a - b);
  const beats = r.runs.map((x) => ({ at: runAt(x), kind: kindOf(x), id: x.id })).filter((b) => Number.isFinite(b.at) && b.at >= start && b.at <= end).reverse();
  const newest = Number.isFinite(t(lastBeatAt(r))) ? t(lastBeatAt(r)) : -Infinity;
  const woke = t(r.lastRunAt);
  const near = (period ?? DAY) / 2;
  const late = Number.isFinite(next) && r.status === "scheduled" && now - firesAt(r, next) > LATE_AFTER_MS;
  const upTo = Math.max(Number.isFinite(woke) ? woke + LATE_AFTER_MS : -Infinity, late ? now - LATE_AFTER_MS : -Infinity);
  const noBeat = (e) => !beats.some((b) => Math.abs(b.at - e) <= near);
  const skips = (r.wakes ?? []).filter((k) => k.outcome === "skipped").map((k) => ({ at: t(k.at), reason: k.reason, kind: k.kind, byDesign: byDesign(k.reason) })).filter((k) => Number.isFinite(k.at) && k.at >= start && k.at <= end).reverse();
  const recorded = (e) => skips.some((k) => Math.abs(k.at - e) <= near);
  const missed = expected.filter((e) => r.runsMeasured && noBeat(e) && !recorded(e) && (e > newest + near && e <= upTo || e > HISTORY_KEPT_SINCE && e < now - LATE_AFTER_MS && e > newest + near));
  const unknown = expected.filter((e) => noBeat(e) && e < newest - near && e <= HISTORY_KEPT_SINCE).length;
  const ledger = t(r.ledgerSince ?? null);
  const heldRecorded = (r.wakes ?? []).filter((k) => k.outcome === "held" && t(k.dueAt ?? k.at) >= Math.max(start, ledger)).length;
  const held = Number.isFinite(ledger) && r.wakes ? replayedHeldBefore(r, start, ledger, end) + heldRecorded : outside;
  return { start, end, days, expected, beats, missed, unknown, outside: held, next: Number.isFinite(next) ? next : null, period, skips };
}
function replayedHeldBefore(r, start, before, end) {
  const period = periodOf(r.frequency);
  const next = t(r.nextRunAt);
  if (!period || !Number.isFinite(next) || r.status === "paused" || before <= start)
    return 0;
  let n = 0;
  let k = next - Math.ceil((next - (start - 7 * DAY)) / period) * period;
  for (let i = 0;k <= Math.min(end, before) && i < 2000; i++) {
    const f = firesAt(r, k);
    if (k > start && k < before && f !== k)
      n++;
    if (f > end)
      break;
    k = f + period;
  }
  return n;
}
function rollupOf(r, now) {
  const w = weekOf(r, now);
  const runs = r.runs.filter((x) => Number.isFinite(runAt(x)) && runAt(x) >= w.start);
  const tools = new Map;
  for (const x of runs)
    for (const tool of toolsOfRun(x))
      tools.set(tool.name, (tools.get(tool.name) ?? 0) + 1);
  const cont = runs.map((x) => x.continuity).filter((c) => !!c);
  return {
    expected: w.expected.length,
    beats: runs.filter((x) => kindOf(x) === "ok").length,
    failed: runs.filter((x) => kindOf(x) === "fail").length,
    missed: w.missed.length,
    unknown: w.unknown,
    outside: w.outside,
    outputs: runs.filter((x) => x.itemId || x.deliverableId || x.publicUrl).length,
    tokens: runs.reduce((n, x) => n + (x.tokens ?? 0), 0),
    tools: [...tools.entries()].sort((a, b) => b[1] - a[1]),
    skips: w.skips.filter((k) => !k.byDesign).length,
    remembered: cont.length ? { measured: cont.length, read: cont.filter((c) => c.loaded).length, used: cont.filter((c) => c.referenced).length } : null
  };
}
function sectionsOf(report) {
  if (!report || ERROR_REPLY.test(report))
    return [];
  const text = report.replace(/^\s*(?:TASKS|NEXT_STEPS):\s*\[[^\]]*\]\s*$/gm, "").trim();
  const re = /^\*\*([^*\n]{2,40})\*\*\s*(?:[—:–-]\s*)?/gm;
  const heads = [...text.matchAll(re)];
  if (!heads.length)
    return text ? [{ title: "Report", body: text }] : [];
  const out = [];
  const lead = text.slice(0, heads[0].index).trim();
  if (lead)
    out.push({ title: "Report", body: lead });
  heads.forEach((h, i) => {
    const from = h.index + h[0].length;
    const to = i + 1 < heads.length ? heads[i + 1].index : text.length;
    const title = h[1].replace(/[:\s—–-]+$/, "").trim();
    const body = text.slice(from, to).trim();
    if (title === "Workflow Complete" && !body)
      return;
    out.push({ title, body });
  });
  return out.filter((x) => x.body || x.title !== "Report");
}
function toolsOf(report) {
  if (!report)
    return [];
  const out = [];
  for (const m of report.matchAll(/^\s*[-•]\s*([✓✗])\s*\*\*([^*]+)\*\*\s*:?\s*(.*)$/gm))
    out.push({ ok: m[1] === "✓", name: m[2].trim(), did: m[3].trim() });
  return out;
}
function toolsOfRun(x) {
  if (x.toolCalls?.length)
    return x.toolCalls.map((c) => ({ name: c.tool, did: c.error ? oneLine(c.error) : c.args ?? "", ok: c.ok, ms: c.durationMs, measured: true }));
  return toolsOf(x.response).map((c) => ({ ...c, ms: null, measured: false }));
}
function beatStory(x) {
  const secs = sectionsOf(x.response);
  const pick = (...names) => secs.find((s) => names.some((n) => s.title.toLowerCase() === n.toLowerCase()));
  const used = new Set;
  const take = (...names) => {
    const s = pick(...names);
    if (s)
      used.add(s);
    return s?.body ?? null;
  };
  const happened = take("Status", "Summary", "Report");
  const changed = take("What Changed", "Changes", "What changed since last");
  const did = take("Actions", "What I did", "Actions Taken");
  const numbers = take("Key Numbers", "Numbers", "Metrics");
  take("Tools Used");
  const rest = secs.filter((s) => !used.has(s) && s.title !== "Workflow Complete");
  return { happened, changed, did, numbers, tools: toolsOfRun(x), rest, error: errorOf(x), laundered: laundered(x), continuity: x.continuity ?? null };
}
// src/read.ts
var LIVE_STATUSES = new Set(["scheduled", "running", "paused", "failed"]);
var RUNS_PER_ROW = 50;
var TIMELINE = 10;
var RESPONSE_CAP = 6000;
var num = (v) => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
var str = (v) => typeof v === "string" && v !== "" ? v : null;
function isHeartbeatJob(j) {
  if (!j || j.agent_id == null)
    return false;
  return j.task_name === "heartbeat" || j.data?.type === "heartbeat";
}
function readRun(e, keepResponse = true) {
  const err = str(e?.error_message);
  return {
    id: num(e?.id) ?? 0,
    status: String(e?.status ?? "unknown"),
    startedAt: str(e?.started_at),
    completedAt: str(e?.completed_at),
    durationMs: num(e?.duration_ms) ?? (num(e?.duration_seconds) != null ? num(e?.duration_seconds) * 1000 : null),
    tokens: num(e?.tokens_used),
    model: str(e?.model_used),
    preview: str(e?.response_preview),
    response: keepResponse ? str(e?.response)?.slice(0, RESPONSE_CAP) ?? null : null,
    error: err,
    itemId: num(e?.bloq_item_id),
    deliverableId: num(e?.deliverable_id),
    publicUrl: str(e?.public_url),
    emailSent: typeof e?.email_sent === "boolean" ? e.email_sent : null
  };
}
function readSchedule(sc) {
  if (!sc || typeof sc !== "object" || sc.enabled !== true)
    return null;
  const days = Array.isArray(sc.working_days) ? sc.working_days.map((d) => String(d).slice(0, 3).toLowerCase()) : [];
  const h = sc.active_hours;
  const hours = h && typeof h.start === "string" && typeof h.end === "string" ? { start: h.start, end: h.end } : null;
  return { timezone: str(sc.timezone) ?? "America/New_York", days, hours };
}
function readHeartbeat(j, runs) {
  const agent = j?.agent ?? {};
  const last = j?.last_result && typeof j.last_result === "object" ? j.last_result : null;
  const lastOk = last ? last.success === false ? false : last.success === true ? true : null : null;
  return {
    jobId: num(j?.id) ?? 0,
    agentId: num(j?.agent_id) ?? 0,
    agentName: String(agent.name ?? j?.data?.agent_name ?? j?.workflowName ?? `Agent ${j?.agent_id}`),
    bloqId: num(j?.bloq_id),
    bloqName: str(j?.bloq?.name),
    mode: str(j?.data?.mode) ?? (typeof agent.heartbeat_mode === "string" ? agent.heartbeat_mode : null),
    frequency: str(j?.frequency),
    status: String(j?.status ?? "unknown"),
    agentActive: typeof agent.active === "boolean" ? agent.active : null,
    nextRunAt: str(j?.next_run_at),
    lastRunAt: str(j?.last_run_at),
    runCount: num(j?.run_count) ?? 0,
    consecutiveFailures: num(agent.consecutive_failures) ?? 0,
    lastOk,
    lastError: lastOk === false ? str(last?.error) ?? str(last?.message) ?? null : null,
    reportTo: Array.isArray(j?.data?.report_emails) ? j.data.report_emails.length : 0,
    tools: Array.isArray(j?.data?.required_tools) ? j.data.required_tools.length : 0,
    workingDays: Array.isArray(agent.settings?.heartbeat_working_days) ? agent.settings.heartbeat_working_days.map((d) => String(d).slice(0, 3).toLowerCase()) : null,
    schedule: readSchedule(agent.settings?.schedule),
    settingsFrequency: str(agent.settings?.heartbeat_frequency),
    timezone: str(j?.timezone),
    lastSkip: last && last.skipped === true ? { at: str(last.skipped_at), reason: str(last.skip_reason), kind: str(last.skip_kind) } : null,
    runs: (runs ?? []).map((e, i) => readRun(e, i < TIMELINE)),
    runsMeasured: runs !== null
  };
}
var unwrap = (j) => {
  const d = j?.data ?? j;
  return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
};
// src/query.ts
var BEAT_STATES = ["late", "silent", "failing", "running", "ok", "paused"];
var UNIT_MS = { m: 60000, h: 3600000, d: 86400000, w: 604800000 };
function parseSince(v, now) {
  if (typeof v === "number" && Number.isFinite(v))
    return v;
  const s = String(v).trim();
  const m = /^(\d+)\s*([mhdw])$/i.exec(s);
  if (m)
    return now - Number(m[1]) * UNIT_MS[m[2].toLowerCase()];
  const at = /^\d{4}-\d{2}-\d{2}/.test(s) ? Date.parse(s) : NaN;
  if (Number.isFinite(at))
    return at;
  throw new Error(`since: cannot read "${s}" — use a duration (30m, 24h, 7d, 2w) or an ISO time`);
}
var iso = (ms) => Number.isFinite(ms) ? new Date(ms).toISOString() : null;
function streakStart(r, kind) {
  let first = null;
  for (const x of r.runs) {
    const k = kindOf(x);
    if (k === "run")
      continue;
    if (k !== kind)
      break;
    first = x;
  }
  return first ? first.startedAt ?? first.completedAt : null;
}
function stateSince(r, now) {
  switch (stateOf(r, now)) {
    case "paused":
      return null;
    case "running": {
      const x = r.runs.find((x2) => kindOf(x2) === "run");
      return x ? iso(runAt(x)) : null;
    }
    case "late": {
      const due = firesAt(r, Date.parse(r.nextRunAt ?? ""));
      return iso(due + LATE_AFTER_MS);
    }
    case "silent": {
      const s = silentSince(r, now);
      return s && s !== "never" ? s : null;
    }
    case "failing":
      return streakStart(r, "fail");
    case "ok":
      return streakStart(r, "ok");
  }
}
function queryHeartbeats(rows, q = {}) {
  const now = q.now ?? Date.now();
  for (const s of q.states ?? []) {
    if (!BEAT_STATES.includes(s))
      throw new Error(`state "${s}" does not exist — states are ${BEAT_STATES.join(", ")}`);
  }
  const from = q.since === undefined ? null : parseSince(q.since, now);
  const wanted = q.states?.length ? new Set(q.states) : null;
  const agents = q.agents?.length ? q.agents : null;
  const isAgent = (r) => !agents || agents.some((a) => typeof a === "number" || /^\d+$/.test(a) ? r.agentId === Number(a) : r.agentName.toLowerCase().includes(a.toLowerCase()));
  const counts = Object.fromEntries(BEAT_STATES.map((s) => [s, 0]));
  const matches = [];
  for (const row of sortBeats(rows, now)) {
    const state = stateOf(row, now);
    counts[state]++;
    if (wanted && !wanted.has(state))
      continue;
    if (!isAgent(row))
      continue;
    const since = stateSince(row, now);
    if (from !== null && since !== null && Date.parse(since) < from)
      continue;
    matches.push({ row, state, since, line: lineOf(row, now), problems: problemsOf(row, now) });
  }
  return { now: new Date(now).toISOString(), counts, matches };
}
// src/pulse.ts
function describeError(e) {
  return String(e?.message ?? e).slice(0, 200);
}
async function runStop(stop, query) {
  const label = stop.label ?? stop.source.label;
  const shut = (reason2, error) => ({
    id: stop.id,
    label,
    shut: true,
    reason: reason2,
    floor: false,
    provenance: [],
    output: stop.unavailable(reason2, query),
    ...error ? { error } : {}
  });
  if (stop.source.isAvailable) {
    let avail;
    try {
      avail = await stop.source.isAvailable(query);
    } catch (e) {
      return shut(`${label}: availability check failed — ${describeError(e)}`, describeError(e));
    }
    if (!avail.ok)
      return shut(avail.reason);
  }
  let result;
  try {
    result = await stop.source.read(query);
  } catch (e) {
    return shut(`${label} failed: ${describeError(e)}`, describeError(e));
  }
  const reason = stop.shutReason ? stop.shutReason(result) : result.measured ? null : result.reason ?? "not measured";
  return {
    id: stop.id,
    label,
    shut: reason !== null,
    reason,
    floor: !!result.floor,
    provenance: result.provenance,
    output: stop.extract(result, query)
  };
}
async function runScript(script, query, hooks = {}) {
  if (script.readOnly !== true)
    throw new Error(`pulse script for route "${script.route}" must be readOnly`);
  const stops = hooks.only ? script.stops.filter((s) => hooks.only(s)) : script.stops;
  const out = [];
  if (script.mode === "parallel") {
    for (const stop of stops)
      hooks.onStart?.(stop);
    await Promise.all(stops.map((stop) => runStop(stop, query).then((o) => {
      out.push(o);
      hooks.onOutcome?.(o);
    })));
    return out;
  }
  for (const stop of stops) {
    hooks.onStart?.(stop);
    const o = await runStop(stop, query);
    out.push(o);
    hooks.onOutcome?.(o);
  }
  return out;
}
var defaults = new Map;
var extensions = new Map;
function registerDefault(route, script) {
  if (script.route !== route)
    throw new Error(`script is for route "${script.route}", registered as "${route}"`);
  if (script.readOnly !== true)
    throw new Error(`pulse script for route "${route}" must be readOnly`);
  defaults.set(route, script);
}
function extend(route, ...stops) {
  extensions.set(route, [...extensions.get(route) ?? [], ...stops]);
}
function scriptFor(route) {
  const base = defaults.get(route);
  if (!base)
    throw new Error(`no pulse script registered for route "${route}"`);
  const extra = extensions.get(route) ?? [];
  if (!extra.length)
    return base;
  const stops = [...base.stops];
  for (const stop of extra) {
    const at = stops.findIndex((s) => s.id === stop.id);
    if (at >= 0)
      stops[at] = stop;
    else
      stops.push(stop);
  }
  return { ...base, stops };
}
function resetExtensions(route) {
  if (route)
    extensions.delete(route);
  else
    extensions.clear();
}
function formatCount(outcome, hits) {
  if (outcome.shut)
    return `shut — ${outcome.reason ?? "not measured"}`;
  return outcome.floor ? `${hits}+` : String(hits);
}
