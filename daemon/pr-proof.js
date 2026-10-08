'use strict'

/**
 * Proof video on the PR (#188292).
 *
 * A change is not done until a reviewer can watch it working. A Hive coding task on a web app
 * ends by recording the changed flow with headless Playwright (no virtual display — Playwright
 * records video headless), uploading the video to the CDN with the node's own `iris
 * cloud:upload`, and posting ONE comment on the pull request through the GitHub REST API.
 *
 * Three rules from the ticket shape this file:
 *  - The comment goes through a direct REST call, not the `gh` CLI (T3 Code cut their GitHub
 *    rate-limit use by 75% doing this). We read X-RateLimit-Remaining off the response.
 *  - We never poll the PR. One POST; if it is rate-limited we report the reset time and stop.
 *  - The token is one the user configured: GITHUB_TOKEN / GH_TOKEN in the environment, or the
 *    user's own `gh auth token`. Nothing here reads a .env file or invents a credential.
 *
 * The pure parts (rule text, comment body, upload parsing, rate-limit handling, PR refs) are
 * exported separately so they can be tested without a browser, a CDN or GitHub.
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const COMMENT_MARKER = '<!-- iris-hive-proof-video -->'
// Below this many remaining core requests we still post, but say so: the next task on the same
// token is about to be refused, and a caller who sees it can back off instead of finding out.
const LOW_RATE_LIMIT = 50

/**
 * The default rule every Hive coding task carries. It names the command by absolute path so the
 * agent does not have to find it, and says plainly what to skip when there is nothing to record.
 */
function proofRule (scriptPath) {
  const cmd = `node ${scriptPath}`
  return [
    '## Hive rule: prove it on the PR',
    'After every change: open the app · test it · record a video · attach it to the PR.',
    '1. Start the app locally and open the flow you changed. Check it works before recording.',
    `2. Once the change is pushed and the PR exists, run: \`${cmd} --url <http://localhost:PORT/path> --pr <owner/repo#N>\``,
    '   Add `--steps steps.json` to click/fill through the flow (a JSON list of',
    '   {"action":"click|fill|goto|press|wait","selector":"…","value":"…","ms":…}).',
    '   It records the flow in headless Chromium, uploads the video to the CDN and posts one PR comment.',
    '3. Put the video link it prints in your final summary. If it fails, say why — do not claim it is attached.',
    'Skip this only when the change has no UI to show (a library, a migration, a CLI), and say that you skipped it.'
  ].join('\n')
}

/**
 * Append the rule to a coding prompt. PHI tasks get nothing: their recordings must stay on the
 * node (#187918), so they must never be told to upload one. Opt out with config.proof_video=false.
 */
function withProofRule (prompt, { scriptPath, phi = false, enabled = true } = {}) {
  const p = String(prompt || '')
  if (!enabled || phi || !scriptPath) return p
  if (p.includes('## Hive rule: prove it on the PR')) return p
  return `${p}\n\n${proofRule(scriptPath)}`
}

/** The CLI the rule points at, beside this file in the installed daemon. */
const PROOF_SCRIPT = path.join(__dirname, '..', 'scripts', 'pr-proof.js')

/**
 * The prompt a coding task's agent actually receives: the task's prompt plus the default rule.
 * One place, so every runtime that runs a code_generation task carries the same rule.
 */
function promptForCodingTask (task, { phi = false } = {}) {
  const enabled = !(task && task.config && task.config.proof_video === false)
  return withProofRule(task && task.prompt, { scriptPath: PROOF_SCRIPT, phi, enabled })
}

/**
 * Accepts `owner/repo#12`, `owner/repo 12` (via separate repo), or a PR URL.
 * Returns { owner, repo, number } or null.
 */
function parsePrRef (ref, repoHint) {
  const s = String(ref || '').trim()
  let m = s.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i)
  if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, ''), number: Number(m[3]) }
  m = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/)
  if (m) return { owner: m[1], repo: m[2], number: Number(m[3]) }
  m = s.match(/^#?(\d+)$/)
  if (m && repoHint) {
    const r = parseRepoSlug(repoHint)
    if (r) return { ...r, number: Number(m[1]) }
  }
  return null
}

/** `owner/repo`, an https remote or an ssh remote → { owner, repo } */
function parseRepoSlug (s) {
  const str = String(s || '').trim()
  const m = str.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i) || str.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/)
  return m ? { owner: m[1], repo: m[2] } : null
}

/**
 * `iris cloud:upload --json` prints a spinner and log lines on the same stdout as the JSON, and
 * on failure it prints an error and still exits 0 with no JSON at all. So: find the last JSON
 * object in the output that carries a URL, and treat its absence as a failure with the output's
 * tail as the reason — never as "uploaded".
 */
function parseUploadOutput (stdout) {
  const text = String(stdout || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  const candidates = []
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    let depth = 0; let inStr = false; let esc = false
    for (let j = i; j < text.length; j++) {
      const c = text[j]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) {
          try { candidates.push(JSON.parse(text.slice(i, j + 1))) } catch { /* not JSON */ }
          break
        }
      }
    }
  }
  for (let k = candidates.length - 1; k >= 0; k--) {
    const o = candidates[k] && (candidates[k].data || candidates[k])
    const cdn = o && (o.cdn_url || o.url)
    if (typeof cdn === 'string' && /^https?:\/\//.test(cdn)) {
      return { cdn_url: cdn, share_url: o.share_url || null, file_id: o.file_id ?? o.id ?? null }
    }
  }
  const tail = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ')
  throw new Error(`upload produced no CDN URL${tail ? `: ${tail.slice(0, 300)}` : ''}`)
}

function header (headers, name) {
  if (!headers) return null
  if (typeof headers.get === 'function') return headers.get(name)
  const k = Object.keys(headers).find((h) => h.toLowerCase() === name.toLowerCase())
  return k ? headers[k] : null
}

/** X-RateLimit-* → { limit, remaining, reset (epoch s), resetAt (ISO) } — nulls when absent. */
function rateLimitFromHeaders (headers) {
  const n = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v))
  const reset = n(header(headers, 'x-ratelimit-reset'))
  return {
    limit: n(header(headers, 'x-ratelimit-limit')),
    remaining: n(header(headers, 'x-ratelimit-remaining')),
    reset,
    resetAt: reset ? new Date(reset * 1000).toISOString() : null,
    retryAfter: n(header(headers, 'retry-after'))
  }
}

/**
 * Decide what one GitHub response means. Never retries, never polls: a rate-limited post is
 * reported with the time it can be retried, and the caller stops.
 * Returns { ok, rateLimited, rate, url?, error?, warning? }.
 */
function interpretGithubResponse (status, headers, bodyText) {
  const rate = rateLimitFromHeaders(headers)
  let body = null
  try { body = bodyText ? JSON.parse(bodyText) : null } catch { body = null }
  const message = (body && body.message) || String(bodyText || '').slice(0, 200)

  if (status >= 200 && status < 300) {
    const out = { ok: true, rateLimited: false, rate, url: body && body.html_url, id: body && body.id }
    if (rate.remaining !== null && rate.remaining < LOW_RATE_LIMIT) {
      out.warning = `GitHub rate limit low: ${rate.remaining} requests left until ${rate.resetAt || 'reset'}`
    }
    return out
  }
  // Primary limit: 403/429 with remaining 0. Secondary limit: 403/429 with retry-after or a
  // "secondary rate limit" message. Both mean "stop", never "try again in a loop".
  const limited = (status === 403 || status === 429) &&
    (rate.remaining === 0 || rate.retryAfter !== null || /rate limit/i.test(message))
  if (limited) {
    const when = rate.retryAfter !== null ? `in ${rate.retryAfter}s` : (rate.resetAt ? `after ${rate.resetAt}` : 'later')
    return { ok: false, rateLimited: true, rate, error: `GitHub rate limit hit (HTTP ${status}); not retrying — post again ${when}` }
  }
  const hint = status === 401 ? ' — the token is missing, expired or revoked'
    : status === 404 ? ' — the PR does not exist, or the token cannot see this repo'
      : status === 403 ? ' — the token lacks permission to comment on this repo'
        : ''
  return { ok: false, rateLimited: false, rate, error: `GitHub HTTP ${status}: ${message}${hint}` }
}

/**
 * The comment. One video link the reviewer clicks, what was recorded, and a marker so a later
 * tool can find the comment without searching by text.
 */
function buildCommentBody ({ videoUrl, shareUrl, flowUrl, steps = [], seconds, node, taskId, note } = {}) {
  if (!videoUrl) throw new Error('buildCommentBody: videoUrl is required')
  const lines = [COMMENT_MARKER, '### Proof video', '', `▶ **[Watch the change working](${videoUrl})**`]
  if (shareUrl && shareUrl !== videoUrl) lines.push(`([share page](${shareUrl}))`)
  lines.push('')
  if (note) lines.push(String(note).trim(), '')
  const recorded = []
  if (flowUrl) recorded.push(`opened \`${flowUrl}\``)
  if (steps.length) recorded.push(`${steps.length} step${steps.length === 1 ? '' : 's'}: ${steps.map(describeStep).join(' → ')}`)
  if (recorded.length) lines.push(`Recorded: ${recorded.join('; ')}.`)
  const meta = []
  if (seconds) meta.push(`${Math.round(seconds * 10) / 10}s`)
  meta.push('headless Chromium (Playwright)')
  if (node) meta.push(`on Hive node \`${node}\``)
  if (taskId) meta.push(`task \`${String(taskId).slice(0, 12)}\``)
  lines.push(`<sub>${meta.join(' · ')}</sub>`)
  return lines.join('\n')
}

function describeStep (s) {
  if (!s || typeof s !== 'object') return String(s)
  const a = s.action || 'step'
  if (a === 'goto') return `goto ${s.url || s.value || ''}`.trim()
  if (a === 'wait') return `wait ${s.ms || s.selector || ''}`.trim()
  if (a === 'fill') return `fill ${s.selector}`
  if (a === 'press') return `press ${s.value || s.key || ''}`.trim()
  return `${a} ${s.selector || ''}`.trim()
}

/**
 * The token the user configured. Environment first (GITHUB_TOKEN, GH_TOKEN), then the user's own
 * `gh auth token`. Returns { token, source } or { token: null }. Never reads a file.
 */
function resolveGithubToken (env = process.env, run = defaultRun) {
  for (const k of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    if (env[k] && String(env[k]).trim()) return { token: String(env[k]).trim(), source: `env ${k}` }
  }
  const r = run('gh', ['auth', 'token'])
  const t = r && r.status === 0 ? String(r.stdout || '').trim() : ''
  if (t) return { token: t, source: 'gh auth token' }
  return { token: null, source: null }
}

function defaultRun (cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf-8', timeout: opts.timeout || 15000, maxBuffer: 16 * 1024 * 1024, env: opts.env || process.env })
}

/** One POST. No retries, no polling. */
async function postPrComment ({ owner, repo, number, body, token, fetchImpl = globalThis.fetch, apiBase = 'https://api.github.com' }) {
  if (!token) return { ok: false, rateLimited: false, rate: rateLimitFromHeaders(null), error: 'no GitHub token: set GITHUB_TOKEN (or GH_TOKEN), or sign in with `gh auth login`' }
  const res = await fetchImpl(`${apiBase}/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'iris-hive-proof-video'
    },
    body: JSON.stringify({ body })
  })
  const text = await res.text()
  return interpretGithubResponse(res.status, res.headers, text)
}

/** Validate a steps file's contents. Returns the list or throws with the offending index. */
function normalizeSteps (raw) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.steps) ? raw.steps : null)
  if (!list) throw new Error('steps must be a JSON array (or {"steps": [...]})')
  const allowed = ['click', 'fill', 'goto', 'press', 'wait', 'hover', 'scroll']
  return list.map((s, i) => {
    if (!s || !allowed.includes(s.action)) throw new Error(`step ${i}: action must be one of ${allowed.join(', ')}`)
    if (['click', 'fill', 'hover'].includes(s.action) && !s.selector) throw new Error(`step ${i}: ${s.action} needs a selector`)
    if (s.action === 'goto' && !(s.url || s.value)) throw new Error(`step ${i}: goto needs a url`)
    return s
  })
}

/**
 * Record the flow with headless Playwright. Returns { file, seconds }. The recording keeps
 * running a beat after the last step so the result of the change is on screen when it ends.
 */
async function recordFlow ({ url, steps = [], outDir, name, width = 1280, height = 720, holdMs = 1500, timeoutMs = 30000, playwright }) {
  const pw = playwright || require('playwright')
  fs.mkdirSync(outDir, { recursive: true })
  const browser = await pw.chromium.launch({ headless: true })
  let started = Date.now()
  let video
  try {
    const context = await browser.newContext({ viewport: { width, height }, recordVideo: { dir: outDir, size: { width, height } } })
    started = Date.now() // the video starts with the context, not the browser launch
    const page = await context.newPage()
    video = page.video()
    page.setDefaultTimeout(timeoutMs)
    await page.goto(url, { waitUntil: 'load' })
    await page.waitForTimeout(800)
    for (const s of steps) {
      if (s.action === 'click') await page.click(s.selector)
      else if (s.action === 'fill') await page.fill(s.selector, String(s.value ?? ''))
      else if (s.action === 'hover') await page.hover(s.selector)
      else if (s.action === 'press') await page.keyboard.press(String(s.value || s.key))
      else if (s.action === 'goto') await page.goto(new URL(s.url || s.value, url).toString(), { waitUntil: 'load' })
      else if (s.action === 'scroll') await page.mouse.wheel(0, Number(s.value || 600))
      else if (s.action === 'wait') {
        if (s.selector) await page.waitForSelector(s.selector)
        else await page.waitForTimeout(Number(s.ms || 1000))
      }
      await page.waitForTimeout(Number(s.pause_ms ?? 600))
    }
    await page.waitForTimeout(holdMs)
    await context.close() // the video file is finalised on context close
  } finally {
    await browser.close()
  }
  const seconds = (Date.now() - started) / 1000
  // Playwright names the file page@<hash>.webm; give it a name a reviewer can read in a URL.
  const raw = await video.path()
  const file = path.join(path.dirname(raw), `${name || 'pr-proof'}-${Date.now()}.webm`)
  fs.renameSync(raw, file)
  return { file, seconds }
}

/**
 * WebM → MP4 (H.264, faststart) when ffmpeg is present, so the link plays on phones and Safari.
 * Falls back to the WebM unchanged — the video is still the proof.
 */
function toMp4 (file, run = defaultRun) {
  const out = file.replace(/\.webm$/i, '') + '.mp4'
  const r = run('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', out], { timeout: 120000 })
  if (r && r.status === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) return out
  return file
}

/** The video's own duration (ffprobe), or null. Wall-clock time overstates it by seconds. */
function probeSeconds (file, run = defaultRun) {
  const r = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
  const n = r && r.status === 0 ? Number(String(r.stdout).trim()) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Upload with the node's own `iris cloud:upload` (the genesis-motion publish path). */
function uploadVideo (file, { title, run = defaultRun, irisBin = 'iris' } = {}) {
  const args = ['cloud:upload', file, '--json']
  if (title) args.push('--title', title)
  const r = run(irisBin, args, { timeout: 180000 })
  if (r && r.error) throw new Error(`could not run ${irisBin}: ${r.error.message}`)
  return parseUploadOutput(`${(r && r.stdout) || ''}\n${(r && r.stderr) || ''}`)
}

module.exports = {
  COMMENT_MARKER,
  LOW_RATE_LIMIT,
  PROOF_SCRIPT,
  proofRule,
  withProofRule,
  promptForCodingTask,
  parsePrRef,
  parseRepoSlug,
  parseUploadOutput,
  rateLimitFromHeaders,
  interpretGithubResponse,
  buildCommentBody,
  resolveGithubToken,
  postPrComment,
  normalizeSteps,
  recordFlow,
  toMp4,
  probeSeconds,
  uploadVideo
}
