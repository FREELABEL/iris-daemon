#!/usr/bin/env node
/**
 * mention-responder.js — Step 1 of the @heyiris pipeline.
 *
 * Closes the gap between the bridge's instant "CONFIRMED" ack and a real,
 * researched reply. Reads collected @heyiris mentions, uses Claude (headless,
 * read-only tools) running INSIDE the freelabel repo to triage + investigate
 * each one, drafts a client-facing reply, and queues it for human approval.
 * Nothing is sent to a client until you approve it.
 *
 * Pipeline:
 *   collect  ~/.iris/mentions/*.jsonl   (already produced by channels/imessage.js)
 *      |
 *   sweep    classify + research via `claude -p` → draft reply → review queue
 *      |
 *   review   you inspect drafts
 *      |
 *   approve  send via bridge POST /api/imessage/direct-send  (live to client)
 *
 * Usage:
 *   node mention-responder.js sweep [--limit N] [--since YYYY-MM-DD] [--client <substr>] [--dry-run]
 *   node mention-responder.js review [--all]
 *   node mention-responder.js show <id>
 *   node mention-responder.js approve <id|all>
 *   node mention-responder.js reject <id>
 *   node mention-responder.js reset <id>            # re-queue (clears processed mark)
 *
 * Env:
 *   BRIDGE_URL        default http://localhost:3200
 *   FREELABEL_REPO    default /Users/AlexMayo/Sites/freelabel
 *   CLAUDE_MODEL      optional --model override for claude
 *   CLAUDE_MAX_TURNS  default 15
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const MENTIONS_DIR = path.join(os.homedir(), '.iris', 'mentions')
const STATE_DIR = path.join(os.homedir(), '.iris', 'mention-responder')
const PROCESSED = path.join(STATE_DIR, 'processed.json')
const QUEUE = path.join(STATE_DIR, 'queue.jsonl')
const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:3200'
const REPO = process.env.FREELABEL_REPO || '/Users/AlexMayo/Sites/freelabel'
const MAX_TURNS = process.env.CLAUDE_MAX_TURNS || '15'

fs.mkdirSync(STATE_DIR, { recursive: true })

// ── tiny utils ──────────────────────────────────────────────────────────────
const c = {
  dim: s => `\x1b[90m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`,
  g: s => `\x1b[92m${s}\x1b[0m`, y: s => `\x1b[93m${s}\x1b[0m`,
  r: s => `\x1b[91m${s}\x1b[0m`, cy: s => `\x1b[96m${s}\x1b[0m`,
}
const keyOf = m => crypto.createHash('sha1')
  .update(`${m.ts}|${m.sender}|${m.text || ''}`).digest('hex').slice(0, 12)

function loadProcessed () {
  try { return new Set(JSON.parse(fs.readFileSync(PROCESSED, 'utf8'))) }
  catch { return new Set() }
}
function saveProcessed (set) {
  fs.writeFileSync(PROCESSED, JSON.stringify([...set], null, 0))
}
function loadQueue () {
  try {
    return fs.readFileSync(QUEUE, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}
function rewriteQueue (rows) {
  fs.writeFileSync(QUEUE, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
}
function appendQueue (row) { fs.appendFileSync(QUEUE, JSON.stringify(row) + '\n') }

function readMentions ({ since, client } = {}) {
  if (!fs.existsSync(MENTIONS_DIR)) return []
  const files = fs.readdirSync(MENTIONS_DIR).filter(f => f.endsWith('.jsonl')).sort()
  const out = []
  for (const f of files) {
    if (since && f.slice(0, 10) < since) continue
    for (const line of fs.readFileSync(path.join(MENTIONS_DIR, f), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const m = JSON.parse(line)
        if (!m.text || !m.text.trim()) continue
        if (client && !(`${m.lead_name || ''} ${m.sender || ''}`.toLowerCase().includes(client.toLowerCase()))) continue
        out.push(m)
      } catch { /* skip malformed */ }
    }
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : 1))
}

function arg (flag, def = null) {
  const i = process.argv.indexOf(flag)
  if (i === -1) return def
  const v = process.argv[i + 1]
  return (v && !v.startsWith('--')) ? v : true
}

// ── Claude research/triage ───────────────────────────────────────────────────
function researchMention (m) {
  const prompt = `You are IRIS, the AI operator for the Freelabel / HeyIRIS platform, triaging a client message that @mentioned you over iMessage. You are running inside the freelabel monorepo at ${REPO} and may read/grep the codebase to investigate before answering.

CLIENT: ${m.lead_name || 'Unknown'} (${m.sender})
SENT: ${m.ts}
MESSAGE:
"""
${m.text}
"""

Steps:
1. Classify. category = bug | feature_request | question | task | status_check | other. severity = low | medium | high. Write a one-line summary.
2. Investigate as needed (read code, grep, check page JSON, etc.) and write concise internal_findings: what's actually going on and what it would take to resolve. Be specific (files, root cause) when you can.
3. Draft client_reply: warm, concise, FIRST PERSON as IRIS, NO markdown, <= 600 chars, address the client by first name. If it's a real bug: acknowledge + what you found + the next step / rough ETA. If it needs a human decision, or you are not confident, set needs_human=true and make client_reply a brief honest holding response (don't fabricate a fix).

Return ONLY a single JSON object, no prose, no code fences:
{"category":"","severity":"","summary":"","internal_findings":"","client_reply":"","needs_human":false}`

  const args = ['-p', prompt, '--output-format', 'json',
    '--allowedTools', 'Read,Grep,Glob', '--max-turns', MAX_TURNS]
  if (process.env.CLAUDE_MODEL) args.push('--model', process.env.CLAUDE_MODEL)

  let raw
  try {
    raw = execFileSync('claude', args, {
      cwd: REPO, encoding: 'utf8', timeout: 300000, maxBuffer: 20 * 1024 * 1024,
    })
  } catch (e) {
    return { error: `claude failed: ${(e.stderr || e.message || '').toString().slice(0, 300)}` }
  }

  // Unwrap the --output-format json envelope, then the model's JSON inside .result
  let text = raw
  try { const env = JSON.parse(raw); if (env && typeof env.result === 'string') text = env.result } catch { /* not enveloped */ }
  const s = text.indexOf('{'); const e = text.lastIndexOf('}')
  if (s === -1 || e === -1) return { error: 'no JSON in claude output', raw: text.slice(0, 400) }
  try {
    const obj = JSON.parse(text.slice(s, e + 1))
    return {
      category: obj.category || 'other',
      severity: obj.severity || 'low',
      summary: obj.summary || '',
      internal_findings: obj.internal_findings || '',
      client_reply: (obj.client_reply || '').trim(),
      needs_human: obj.needs_human !== false,
    }
  } catch (err) {
    return { error: `parse failed: ${err.message}`, raw: text.slice(0, 400) }
  }
}

// ── send via bridge ──────────────────────────────────────────────────────────
function sendReply (handle, text) {
  const body = JSON.stringify({ handle, text })
  const out = execFileSync('curl', ['-s', '-X', 'POST',
    `${BRIDGE}/api/imessage/direct-send`, '-H', 'Content-Type: application/json',
    '--data-binary', '@-'], { input: body, encoding: 'utf8', timeout: 30000 })
  let res; try { res = JSON.parse(out) } catch { throw new Error(`bad bridge response: ${out.slice(0, 200)}`) }
  if (!res.ok) throw new Error(res.error || 'send failed')
  return res
}

// ── commands ─────────────────────────────────────────────────────────────────
function cmdSweep () {
  const dry = process.argv.includes('--dry-run')
  const limit = parseInt(arg('--limit', dry ? '999' : '5'), 10)
  const since = arg('--since')
  const client = arg('--client')
  const includeSelf = process.argv.includes('--include-self')

  const processed = loadProcessed()
  const mentions = readMentions({ since, client })
    .filter(m => includeSelf || !m.is_from_me)
    .filter(m => !processed.has(keyOf(m)))

  console.log(c.b(`\n◈ Mention sweep`) + c.dim(`  (${mentions.length} unprocessed, processing up to ${limit})`))
  if (dry) {
    mentions.slice(0, limit).forEach((m, i) =>
      console.log(`  ${c.dim(String(i + 1).padStart(2))}. ${c.cy(m.lead_name || m.sender)}  ${c.dim(m.ts.slice(0, 16))}\n      ${(m.text || '').replace(/\n+/g, ' ').slice(0, 100)}`))
    console.log(c.y(`\n  dry-run — nothing researched or queued.`))
    return
  }

  let done = 0
  for (const m of mentions.slice(0, limit)) {
    const id = keyOf(m)
    process.stdout.write(`  ${c.cy(m.lead_name || m.sender)} ${c.dim(m.ts.slice(0, 16))} … `)
    const r = researchMention(m)
    if (r.error) { console.log(c.r(`✗ ${r.error}`)); continue }
    appendQueue({
      id, status: 'pending', created: new Date().toISOString(),
      sender: m.sender, lead_id: m.lead_id, lead_name: m.lead_name,
      chat: m.chat, message: m.text,
      category: r.category, severity: r.severity, summary: r.summary,
      internal_findings: r.internal_findings, draft_reply: r.client_reply,
      needs_human: r.needs_human,
    })
    processed.add(id); saveProcessed(processed)
    const flag = r.needs_human ? c.y('needs-human') : c.g('auto-ok')
    console.log(`${c.g('✓')} ${c.dim(`[${r.category}/${r.severity}]`)} ${flag} ${c.dim(id)}`)
    done++
  }
  console.log(c.b(`\n  Queued ${done} draft(s).`) + c.dim(`  Review: node mention-responder.js review\n`))
}

function cmdReview () {
  const all = process.argv.includes('--all')
  const rows = loadQueue().filter(r => all || r.status === 'pending')
  if (!rows.length) { console.log(c.dim('  No drafts.' + (all ? '' : ' (use --all to see sent/rejected)'))); return }
  console.log(c.b(`\n◈ Review queue`) + c.dim(`  (${rows.length})\n`))
  for (const r of rows) {
    const st = r.status === 'pending' ? c.y('PENDING') : r.status === 'sent' ? c.g('SENT') : c.r(r.status.toUpperCase())
    console.log(`  ${c.b(r.id)}  ${st}  ${c.cy(r.lead_name || r.sender)}  ${c.dim(`[${r.category}/${r.severity}]`)}${r.needs_human ? c.y(' ⚑human') : ''}`)
    console.log(`    ${c.dim('msg:')} ${(r.message || '').replace(/\n+/g, ' ').slice(0, 90)}`)
    console.log(`    ${c.dim('reply:')} ${r.draft_reply.replace(/\n+/g, ' ').slice(0, 110)}`)
    console.log('')
  }
  console.log(c.dim(`  show <id> · approve <id|all> · reject <id>\n`))
}

function cmdShow (id) {
  const r = loadQueue().find(x => x.id === id)
  if (!r) { console.log(c.r(`  No draft ${id}`)); return }
  console.log(`\n${c.b('id')}       ${r.id}   ${c.dim(r.status)}`)
  console.log(`${c.b('client')}   ${r.lead_name || ''} (${r.sender})  lead #${r.lead_id || '—'}`)
  console.log(`${c.b('class')}    ${r.category} / ${r.severity}${r.needs_human ? c.y('  ⚑ needs human') : ''}`)
  console.log(`${c.b('summary')}  ${r.summary}`)
  console.log(`\n${c.cy('— message —')}\n${r.message}`)
  console.log(`\n${c.cy('— internal findings —')}\n${r.internal_findings}`)
  console.log(`\n${c.cy('— draft reply —')}\n${c.g(r.draft_reply)}\n`)
}

function cmdApprove (id) {
  const rows = loadQueue()
  const targets = id === 'all'
    ? rows.filter(r => r.status === 'pending' && !r.needs_human)
    : rows.filter(r => r.id === id)
  if (!targets.length) {
    console.log(c.y(id === 'all' ? '  Nothing auto-approvable (needs-human drafts must be approved by id).' : `  No draft ${id}`))
    return
  }
  for (const r of targets) {
    if (r.status === 'sent') { console.log(c.dim(`  ${r.id} already sent`)); continue }
    try {
      const res = sendReply(r.sender, r.draft_reply)
      r.status = 'sent'; r.sent_at = new Date().toISOString(); r.send_method = res.method
      console.log(`  ${c.g('✓ sent')} → ${c.cy(r.lead_name || r.sender)} ${c.dim(`(${res.method || 'ok'})`)}`)
    } catch (e) {
      console.log(`  ${c.r('✗')} ${r.id}: ${e.message}`)
    }
  }
  rewriteQueue(rows)
}

function cmdReject (id) {
  const rows = loadQueue(); const r = rows.find(x => x.id === id)
  if (!r) { console.log(c.r(`  No draft ${id}`)); return }
  r.status = 'rejected'; rewriteQueue(rows); console.log(c.dim(`  ${id} rejected`))
}

function cmdReset (id) {
  const processed = loadProcessed(); processed.delete(id); saveProcessed(processed)
  const rows = loadQueue().filter(r => r.id !== id); rewriteQueue(rows)
  console.log(c.dim(`  ${id} reset — will be re-swept`))
}

// ── dispatch ─────────────────────────────────────────────────────────────────
const [cmd, a1] = process.argv.slice(2).filter(x => !x.startsWith('--'))
switch (cmd) {
  case 'sweep': cmdSweep(); break
  case 'review': case 'list': cmdReview(); break
  case 'show': cmdShow(a1); break
  case 'approve': cmdApprove(a1); break
  case 'reject': cmdReject(a1); break
  case 'reset': cmdReset(a1); break
  default:
    console.log(`mention-responder — @heyiris triage + drafted replies (approval-gated)

  sweep   [--limit N] [--since YYYY-MM-DD] [--client <substr>] [--dry-run] [--include-self]
  review  [--all]
  show    <id>
  approve <id|all>     (all = pending & not needs-human)
  reject  <id>
  reset   <id>

  bridge: ${BRIDGE}   repo: ${REPO}`)
}
