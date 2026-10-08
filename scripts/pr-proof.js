#!/usr/bin/env node
'use strict'

/**
 * Record the changed flow, upload the video to the CDN, and post it on the PR (#188292).
 *
 *   node scripts/pr-proof.js --url http://localhost:5173/checkout --pr owner/repo#128
 *   node scripts/pr-proof.js --url http://localhost:3000 --pr 128            (repo from git origin)
 *   node scripts/pr-proof.js --url … --pr … --steps steps.json --note "Fixes the checkout button"
 *   node scripts/pr-proof.js --url … --dry-run      (record + upload, print the comment, post nothing)
 *   node scripts/pr-proof.js --video film.mp4 --pr …  (skip recording; attach an existing video)
 *
 * Token: GITHUB_TOKEN / GH_TOKEN in the environment, else the user's own `gh auth token`.
 * One REST POST to the PR; never polls it. Prints a JSON line with the result.
 * Exit codes: 0 posted (or dry run) · 1 failed · 3 rate-limited (do not retry before reset).
 */

const os = require('os')
const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')
const P = require('../daemon/pr-proof')

function parseArgs (argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { out._.push(a); continue }
    const [k, inline] = a.slice(2).split('=', 2)
    if (['dry-run', 'no-mp4', 'help'].includes(k)) { out[k] = true; continue }
    out[k] = inline !== undefined ? inline : argv[++i]
  }
  return out
}

function gitOrigin () {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf-8' })
  return r.status === 0 ? r.stdout.trim() : null
}

function emit (obj, code) {
  process.stdout.write(JSON.stringify(obj) + '\n')
  process.exit(code)
}

async function main () {
  const a = parseArgs(process.argv.slice(2))
  if (a.help || (!a.url && !a.video)) {
    process.stdout.write(fs.readFileSync(__filename, 'utf-8').split('*/')[0].split('/**')[1].replace(/^ \* ?/gm, '') + '\n')
    process.exit(a.help ? 0 : 1)
  }

  const pr = a.pr ? P.parsePrRef(a.pr, a.repo || gitOrigin()) : null
  if (!a['dry-run'] && !pr) emit({ ok: false, error: `--pr is required (owner/repo#N, a PR URL, or N inside a git checkout); got ${JSON.stringify(a.pr || null)}` }, 1)

  // Resolve the token BEFORE recording so a missing token fails in a second, not after a render.
  const tok = a['dry-run'] ? { token: null, source: null } : P.resolveGithubToken()
  if (!a['dry-run'] && !tok.token) emit({ ok: false, error: 'no GitHub token: set GITHUB_TOKEN (or GH_TOKEN), or sign in with `gh auth login`' }, 1)

  let steps = []
  if (a.steps) steps = P.normalizeSteps(JSON.parse(fs.readFileSync(a.steps, 'utf-8')))

  let file = a.video
  let seconds = null
  if (!file) {
    const outDir = a.out || fs.mkdtempSync(path.join(os.tmpdir(), 'pr-proof-'))
    const name = pr ? `pr-proof-${pr.repo}-${pr.number}`.replace(/[^A-Za-z0-9._-]/g, '-') : 'pr-proof'
    const rec = await P.recordFlow({ url: a.url, steps, outDir, name, width: Number(a.width || 1280), height: Number(a.height || 720) })
    file = rec.file
    seconds = rec.seconds
    if (!a['no-mp4']) file = P.toMp4(file)
    seconds = P.probeSeconds(file) || seconds
  }
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) emit({ ok: false, error: `no video at ${file}` }, 1)

  const title = a.title || (pr ? `PR proof ${pr.owner}/${pr.repo}#${pr.number}` : `PR proof ${path.basename(file)}`)
  const up = P.uploadVideo(file, { title })

  const body = P.buildCommentBody({
    videoUrl: up.cdn_url,
    shareUrl: up.share_url,
    flowUrl: a.url,
    steps,
    seconds,
    node: os.hostname(),
    taskId: process.env.TASK_ID,
    note: a.note
  })

  if (a['dry-run']) emit({ ok: true, dry_run: true, video: file, cdn_url: up.cdn_url, share_url: up.share_url, comment: body }, 0)

  const r = await P.postPrComment({ ...pr, body, token: tok.token })
  const result = {
    ok: r.ok,
    pr: `${pr.owner}/${pr.repo}#${pr.number}`,
    cdn_url: up.cdn_url,
    share_url: up.share_url,
    comment_url: r.url || null,
    token_source: tok.source,
    rate_limit_remaining: r.rate.remaining,
    rate_limit_reset: r.rate.resetAt
  }
  if (r.warning) result.warning = r.warning
  if (!r.ok) result.error = r.error
  emit(result, r.ok ? 0 : (r.rateLimited ? 3 : 1))
}

main().catch((e) => emit({ ok: false, error: String(e && e.message ? e.message : e).replace(/\x1b\[[0-9;]*m/g, '') }, 1))
