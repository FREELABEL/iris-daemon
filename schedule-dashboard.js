#!/usr/bin/env node
/**
 * Schedule Dashboard — live view of all cloud scheduled jobs.
 *
 * Standalone server (does NOT touch the running daemon — no restart needed).
 * Reads scheduled jobs via the IRIS SDK (~/.iris/sdk/.env) and renders an
 * auto-refreshing web UI showing every job, its cadence, next-run countdown,
 * last run/result, retry budget, and currently-running status. Includes
 * Run-now and Cancel controls.
 *
 *   node schedule-dashboard.js            # serves on http://localhost:4500
 *   PORT=4600 node schedule-dashboard.js  # custom port
 */

const http = require('http')
const IRIS = require('./daemon/iris-sdk')

const PORT = parseInt(process.env.PORT || '4500', 10)
const iris = new IRIS()

// Statuses we treat as "live" (still on a schedule). Everything else
// (cancelled/completed/failed/expired) is history.
const LIVE_STATUSES = ['scheduled', 'running', 'completed_pending', 'pending', 'active']

// last_result may be a JSON string or an already-parsed object. Returns the object or null.
function parseResult (lr) {
  if (!lr) return null
  if (typeof lr === 'object') return lr
  if (typeof lr === 'string') { try { return JSON.parse(lr) } catch { return null } }
  return null
}

function pick (j) {
  const lr = parseResult(j.last_result)
  // Did the last run actually succeed? null = unknown (no result yet).
  const success = (lr && typeof lr === 'object' && 'success' in lr) ? !!lr.success : null
  // hive_task_dispatch jobs embed the dispatched node task: { task: { id, node, ... } }.
  // Their schedule status goes green on dispatch, NOT on node-task completion — so the
  // schedule "success" is only "dispatched ok", not "the work ran ok".
  const isDispatch = (j.task_name === 'hive_task_dispatch') ||
    ((j.task_type || j.trigger_type) === 'hive_task_dispatch') ||
    !!(lr && lr.task)
  return {
    id: j.id,
    name: j.task_name || j.workflowName || j.name || `job #${j.id}`,
    prompt: (j.prompt || '').slice(0, 140),
    type: j.task_type || j.trigger_type || j.workflowType || '',
    status: j.status,
    cadence: j.cron_expression || j.recurrence_pattern || j.frequency || '—',
    next_run_at: j.next_run_at || null,
    last_run_at: j.last_run_at || null,
    updated_at: j.updated_at || null,
    last_error: j.last_error || '',
    last_result: typeof j.last_result === 'string' ? j.last_result.slice(0, 120) : (lr ? JSON.stringify(lr).slice(0, 120) : ''),
    success,
    is_dispatch: isDispatch,
    dispatch_task: (lr && lr.task) ? { id: lr.task.id || null, node: lr.task.node || null } : null,
    retry_count: j.retry_count ?? 0,
    max_retries: j.max_retries ?? 0,
    run_count: j.run_count ?? j.execution_count ?? 0,
    max_runs: j.max_runs ?? j.max_executions ?? 0,
    agent_id: j.agent_id || null,
    bloq_id: j.bloq_id || null
  }
}

async function fetchSchedules () {
  const jobs = await iris.schedule.list({ limit: 1000 })
  const arr = Array.isArray(jobs) ? jobs : (jobs.data || [])
  const mapped = arr.map(pick)
  const live = mapped.filter(j => LIVE_STATUSES.includes(j.status))
  live.sort((a, b) => String(a.next_run_at || '9999').localeCompare(String(b.next_run_at || '9999')))
  const counts = {}
  for (const j of mapped) counts[j.status] = (counts[j.status] || 0) + 1
  return { live, counts, total: mapped.length, server_now: new Date().toISOString() }
}

function json (res, code, body) {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) })
  res.end(s)
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`)

    if (url.pathname === '/api/schedules') {
      return json(res, 200, await fetchSchedules())
    }

    // Run a job now
    let m = url.pathname.match(/^\/api\/run\/(\d+)$/)
    if (m && req.method === 'POST') {
      try { await iris.schedule.run(parseInt(m[1], 10)); return json(res, 200, { ok: true }) } catch (e) { return json(res, 500, { ok: false, error: e.message }) }
    }

    // Cancel (delete) a job
    m = url.pathname.match(/^\/api\/cancel\/(\d+)$/)
    if (m && req.method === 'POST') {
      try { await iris.schedule.delete(parseInt(m[1], 10)); return json(res, 200, { ok: true }) } catch (e) { return json(res, 500, { ok: false, error: e.message }) }
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(PAGE)
    }

    json(res, 404, { error: 'not found' })
  } catch (e) {
    json(res, 500, { error: e.message })
  }
})

server.listen(PORT, () => {
  console.log(`\n  ◈ Schedule Dashboard`)
  console.log(`  ────────────────────────────────────────`)
  console.log(`  User:  ${iris.userId}   API: ${iris.apiUrl}`)
  console.log(`  Open:  http://localhost:${PORT}\n`)
})

const PAGE = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IRIS — Scheduled Jobs</title>
<style>
  :root { --bg:#0d1117; --card:#161b22; --line:#21262d; --muted:#8b949e; --fg:#e6edf3;
          --green:#2ea043; --amber:#d29922; --red:#da3633; --blue:#388bfd; --purple:#8957e5; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
  header { padding:16px 20px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:16px; flex-wrap:wrap; position:sticky; top:0; background:var(--bg); z-index:5; }
  h1 { font-size:16px; margin:0; font-weight:600; }
  .pill { padding:2px 8px; border-radius:10px; font-size:12px; border:1px solid var(--line); color:var(--muted); }
  .live { color:var(--green); }
  .counts { color:var(--muted); font-size:12px; }
  .right { margin-left:auto; display:flex; gap:10px; align-items:center; }
  label { color:var(--muted); font-size:12px; cursor:pointer; user-select:none; }
  table { width:100%; border-collapse:collapse; }
  th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); padding:10px 12px; border-bottom:1px solid var(--line); position:sticky; top:57px; background:var(--bg); }
  td { padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
  tr:hover td { background:#11161d; }
  .name { font-weight:600; }
  .sub { color:var(--muted); font-size:12px; max-width:380px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .badge { padding:2px 8px; border-radius:6px; font-size:11px; font-weight:600; display:inline-block; }
  .b-scheduled { background:rgba(56,139,253,.15); color:var(--blue); }
  .b-running { background:rgba(46,160,67,.18); color:var(--green); }
  .b-completed_pending { background:rgba(218,54,51,.18); color:var(--red); }
  .b-paused { background:rgba(139,148,158,.2); color:var(--muted); }
  .b-pending { background:rgba(56,139,253,.12); color:var(--blue); }
  .cd { font-variant-numeric:tabular-nums; font-weight:600; }
  .cd.soon { color:var(--amber); }
  .cd.now { color:var(--green); }
  .cd.overdue { color:var(--red); }
  .err { color:var(--red); font-size:12px; max-width:340px; white-space:normal; }
  .retry-bad { color:var(--red); font-weight:600; }
  .cadence { color:var(--purple); }
  button { background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:4px 10px; font:inherit; font-size:12px; cursor:pointer; }
  button:hover { border-color:var(--muted); }
  button.run:hover { border-color:var(--green); color:var(--green); }
  button.cancel:hover { border-color:var(--red); color:var(--red); }
  .dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--green); margin-right:6px; animation:pulse 1.6s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
  .muted { color:var(--muted); }
  .stuck { background:var(--red); color:#fff; padding:1px 6px; border-radius:5px; font-size:10px; font-weight:700; margin-left:6px; }
  .ok { color:var(--green); font-weight:600; }
  .fail { color:var(--red); font-weight:600; }
  .unknown { color:var(--muted); }
  .agent { color:var(--muted); font-size:11px; }
  .dispatch { color:var(--amber); font-size:11px; }
  .runs { color:var(--muted); font-variant-numeric:tabular-nums; }
  tr.row-stuck td { background:rgba(218,54,51,.06); }
</style></head>
<body>
<header>
  <span class="dot"></span><h1>Scheduled Jobs</h1>
  <span class="pill live" id="liveCount">…</span>
  <span class="counts" id="counts"></span>
  <div class="right">
    <label><input type="checkbox" id="autorefresh" checked> auto-refresh</label>
    <span class="muted" id="updated"></span>
    <button onclick="load()">↻ refresh</button>
  </div>
</header>
<table>
  <thead><tr>
    <th>Job</th><th>Cadence</th><th>Next run</th><th>Last run</th><th>Result</th><th>Runs</th><th>Retries</th><th>Status</th><th></th>
  </tr></thead>
  <tbody id="rows"><tr><td colspan="9" class="muted">Loading…</td></tr></tbody>
</table>
<script>
let DATA = []
const fmtRel = (iso) => {
  if (!iso) return '<span class="muted">never</span>'
  const d = (Date.now() - new Date(iso).getTime())/1000
  if (d < 0) return 'in ' + fmtDur(-d)
  if (d < 60) return Math.floor(d)+'s ago'
  if (d < 3600) return Math.floor(d/60)+'m ago'
  if (d < 86400) return Math.floor(d/3600)+'h ago'
  return Math.floor(d/86400)+'d ago'
}
const fmtDur = (s) => {
  s = Math.floor(s)
  if (s < 60) return s+'s'
  if (s < 3600) return Math.floor(s/60)+'m '+(s%60)+'s'
  if (s < 86400) return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m'
  return Math.floor(s/86400)+'d '+Math.floor((s%86400)/3600)+'h'
}
function countdown(iso) {
  if (!iso) return { txt:'—', cls:'' }
  const left = (new Date(iso).getTime() - Date.now())/1000
  if (left <= -120) return { txt:'overdue '+fmtDur(-left), cls:'overdue' }
  if (left <= 0) return { txt:'due now', cls:'now' }
  if (left < 300) return { txt:'in '+fmtDur(left), cls:'soon' }
  return { txt:'in '+fmtDur(left), cls:'' }
}
// A job is STUCK (not merely overdue) when its next run is in the past AND nothing has
// touched it since its last run (updated_at <= last_run_at). That's the completed_pending
// orphan signature — it ran, then froze, never re-armed.
function isStuck(j) {
  if (j.status === 'running') return false
  if (!j.next_run_at) return false
  // >10 min overdue (scheduler runs every minute, so this isn't just a pickup lag)
  if (new Date(j.next_run_at).getTime() >= Date.now() - 600000) return false
  if (!j.last_run_at || !j.updated_at) return j.status === 'completed_pending'
  return new Date(j.updated_at).getTime() <= new Date(j.last_run_at).getTime() + 1000
}
function resultBadge(j) {
  if (j.is_dispatch) return '<span class="dispatch" title="hive_task_dispatch: schedule goes green on dispatch, not on the node task finishing">⇒ dispatched</span>'
  if (j.success === true) return '<span class="ok">✓ ok</span>'
  if (j.success === false) return '<span class="fail">✗ failed</span>'
  return '<span class="unknown">—</span>'
}
function render() {
  const rows = DATA.map(j => {
    const cd = countdown(j.next_run_at)
    const retryBad = j.max_retries && j.retry_count >= j.max_retries
    const stuck = isStuck(j)
    const sub = j.prompt || j.type || ('agent '+(j.agent_id||'?'))
    const agentTag = j.agent_id ? '<span class="agent"> · agent '+j.agent_id+'</span>' : ''
    const dispatchInfo = (j.is_dispatch && j.dispatch_task && j.dispatch_task.id)
      ? '<div class="dispatch">node task '+esc(String(j.dispatch_task.id).slice(0,12))+' — result not tracked here</div>' : ''
    const err = j.last_error ? '<div class="err">⚠ '+esc(j.last_error)+'</div>' : ''
    const runs = j.max_runs ? (j.run_count+'/'+j.max_runs) : String(j.run_count)
    return '<tr class="'+(stuck?'row-stuck':'')+'">'
      + '<td><div class="name">'+esc(j.name)+(stuck?'<span class="stuck">STUCK</span>':'')+'</div>'
        + '<div class="sub">'+esc(sub)+agentTag+'</div>'+dispatchInfo+err+'</td>'
      + '<td class="cadence">'+esc(j.cadence)+'</td>'
      + '<td class="cd '+cd.cls+'" data-next="'+(j.next_run_at||'')+'">'+cd.txt+'</td>'
      + '<td>'+fmtRel(j.last_run_at)+'</td>'
      + '<td>'+resultBadge(j)+'</td>'
      + '<td class="runs">'+runs+'</td>'
      + '<td class="'+(retryBad?'retry-bad':'')+'">'+j.retry_count+'/'+j.max_retries+(retryBad?' ✗':'')+'</td>'
      + '<td><span class="badge b-'+j.status+'">'+j.status+'</span></td>'
      + '<td style="white-space:nowrap"><button class="run" onclick="run('+j.id+')">▶ run</button> '
      + '<button class="cancel" onclick="cancel('+j.id+',\\''+esc(j.name).replace(/'/g,"")+'\\')">✕</button></td>'
      + '</tr>'
  }).join('')
  document.getElementById('rows').innerHTML = rows || '<tr><td colspan="9" class="muted">No live jobs.</td></tr>'
}
function tick() {
  document.querySelectorAll('.cd[data-next]').forEach(el => {
    const cd = countdown(el.getAttribute('data-next'))
    el.textContent = cd.txt; el.className = 'cd ' + cd.cls
  })
}
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
async function load() {
  try {
    const r = await fetch('/api/schedules'); const d = await r.json()
    DATA = d.live
    document.getElementById('liveCount').textContent = d.live.length + ' live'
    document.getElementById('counts').textContent = Object.entries(d.counts).map(([k,v])=>k+':'+v).join('  ')
    document.getElementById('updated').textContent = 'updated ' + new Date().toLocaleTimeString()
    render()
  } catch (e) { document.getElementById('rows').innerHTML = '<tr><td colspan="7" class="err">'+e.message+'</td></tr>' }
}
async function run(id) {
  const r = await fetch('/api/run/'+id, {method:'POST'}); const d = await r.json()
  if (d.ok) { flash('Triggered job '+id); setTimeout(load, 1200) } else alert('Failed: '+(d.error||'?'))
}
async function cancel(id, name) {
  if (!confirm('Cancel (delete) schedule: '+name+'?\\nThis removes the recurring job.')) return
  const r = await fetch('/api/cancel/'+id, {method:'POST'}); const d = await r.json()
  if (d.ok) { flash('Cancelled job '+id); setTimeout(load, 800) } else alert('Failed: '+(d.error||'?'))
}
function flash(msg){ const u=document.getElementById('updated'); u.textContent=msg; }
setInterval(tick, 1000)
setInterval(() => { if (document.getElementById('autorefresh').checked) load() }, 7000)
load()
</script>
</body></html>`
