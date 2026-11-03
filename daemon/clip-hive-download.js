// clip_cutter with download=hive (#191214).
//
// YouTube answers Railway's IPs with "Sign in to confirm you're not a bot", so a scheduled clip's
// video can no longer be downloaded where the clip is cut. This node does the one step YouTube
// blocks there: fl-api picks a fresh video and returns a pre-signed R2 upload URL; this downloads
// just the clip's section with yt-dlp, PUTs it to R2, and tells fl-api it is ready. Cutting,
// branding and posting stay on fl-api (upload-post keys, brand assets). No Google login is used.
const { execFileSync, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

/** "0:10" / "1:02:03" / "90" / "90s" -> seconds. */
function toSeconds (v) {
  const s = String(v ?? '').trim().replace(/s$/, '')
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  const parts = s.split(':').map(n => parseInt(n, 10))
  if (!parts.length || parts.some(n => Number.isNaN(n))) throw new Error(`not a time: ${v}`)
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

/** yt-dlp --download-sections value for the clip window. */
function sectionArg (start, duration) {
  const a = toSeconds(start)
  return `*${a}-${a + toSeconds(duration)}`
}

/**
 * Which formats to ask for. Plain https (DASH) first: on some videos YouTube's best video is an
 * HLS (m3u8) stream, and cutting a section out of it with --download-sections yields NO video
 * frames, only the audio. That was a 1.5 MB audio-only file uploaded as the clip source, and
 * FFmpeg then failed with code 234 on fl-api: 7 of 28 clip jobs, 2026-11-02/03 (#192315).
 * The old selector stays as the last resort, and the video check below catches what it lets by.
 */
const FORMAT = 'bv*[height<=1080][protocol=https]+ba[protocol=https]/b[height<=1080][protocol=https]/bv*[height<=1080]+ba/b'

/**
 * true / false: does the file have a video stream. null: no ffprobe on this node, so unknown.
 * Never upload a file we know has no picture.
 */
function hasVideo (file, env = process.env) {
  const probe = env.FFPROBE_PATH || 'ffprobe'
  const r = spawnSync(probe, ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=codec_type',
    '-of', 'csv=p=0', file], { encoding: 'utf8', timeout: 60000 })
  if (r.error) return null
  return /video/.test(r.stdout || '')
}

/** [cmd, ...prefixArgs] for yt-dlp: $YTDLP_PATH, then yt-dlp on PATH, then python3 -m yt_dlp. */
function resolveYtDlp (env = process.env, has = commandWorks) {
  if (env.YTDLP_PATH) return [env.YTDLP_PATH]
  if (has('yt-dlp', ['--version'])) return ['yt-dlp']
  if (has('python3', ['-m', 'yt_dlp', '--version'])) return ['python3', '-m', 'yt_dlp']
  return null
}

function commandWorks (cmd, args) {
  try {
    return spawnSync(cmd, args, { stdio: 'ignore', timeout: 20000 }).status === 0
  } catch { return false }
}

async function call (api, token, method, route, body, timeoutMs) {
  const res = await fetch(api + route, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  if (!res.ok) throw new Error(`${method} ${route} -> HTTP ${res.status}: ${text.slice(0, 300)}`)
  return json
}

async function run ({ api, token, body, log = console.log }) {
  const ytdlp = resolveYtDlp()
  if (!ytdlp) throw new Error('yt-dlp not found on this node (set YTDLP_PATH, or: python3 -m pip install --user yt-dlp)')

  // 1. Pick. Synchronous on fl-api: selection + scoring of the few fresh videos.
  const pick = await call(api, token, 'POST', '/api/v1/clips/cut-scheduled', { ...body, hive_download: true }, 240000)
  if (!pick.job_id) {
    log('[clip_cutter] ' + (pick.message || 'nothing selected'))
    return { job_id: null, message: pick.message }
  }
  log(`[clip_cutter] job #${pick.job_id}: ${pick.title || pick.youtube_url} (${pick.start} +${pick.duration})`)

  // 2. Download only the clip's section, <=1080p, from this node.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-hive-'))
  const file = path.join(dir, `job-${pick.job_id}.mp4`)
  const t0 = Date.now()
  try {
    execFileSync(ytdlp[0], [...ytdlp.slice(1), '--no-warnings', '--no-playlist',
      '-f', FORMAT, '--merge-output-format', 'mp4',
      '--download-sections', sectionArg(pick.start, pick.duration), '--force-keyframes-at-cuts',
      '-o', file, pick.youtube_url], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 })
  } catch (e) {
    const out = String(e.stderr || e.stdout || e.message)
    throw new Error(`download failed for job #${pick.job_id}${/not a bot/.test(out) ? ' (YouTube bot check on this node too)' : ''}: ${out.trim().split('\n').pop()}`)
  }
  if (!fs.existsSync(file)) throw new Error(`yt-dlp produced no file for job #${pick.job_id}`)
  const bytes = fs.statSync(file).size
  log(`[clip_cutter] downloaded ${(bytes / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  const video = hasVideo(file)
  if (video === false) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw new Error(`job #${pick.job_id}: the download has no video track (audio only), so nothing was uploaded`)
  }
  if (video === null) log('[clip_cutter] no ffprobe on this node; the video track was not checked')

  // 3. Upload straight to R2 with the pre-signed URL (never through the API).
  const up = pick.upload
  const put = await fetch(up.upload_url, {
    method: up.method || 'PUT', headers: up.headers || { 'Content-Type': 'video/mp4' },
    body: fs.readFileSync(file), signal: AbortSignal.timeout(300000)
  })
  if (!put.ok) throw new Error(`R2 upload for job #${pick.job_id} -> HTTP ${put.status}: ${(await put.text()).slice(0, 200)}`)
  fs.rmSync(dir, { recursive: true, force: true })

  // 4. Hand it back; fl-api verifies the object and queues the cut + post.
  const ready = await call(api, token, 'POST', `/api/v1/clips/${pick.job_id}/source-ready`, {}, 60000)
  log(`[clip_cutter] job #${pick.job_id} queued for cutting (${ready.status})`)
  return { job_id: pick.job_id, title: pick.title, bytes, status: ready.status }
}

module.exports = { toSeconds, sectionArg, resolveYtDlp, hasVideo, FORMAT, run }
