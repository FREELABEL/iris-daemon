'use strict'
// Instagram: comment a keyword, get a DM (FL-CO-47, #190735).
//
// Runs som/instagram-keyword-dm.spec.ts once, when a person asks (iris instagram keyword-dm).
// No schedule and no polling: background browser jobs need the user's visible consent, and SOM
// outreach is paused, so this route is the only way it runs.
//
//   POST /api/instagram/keyword-dm   {postUrl, keyword, message, account?, send?, max?, handles?}
//     Dry run unless send is literally true (not "1", not "yes"). `handles` is the list a person
//     confirmed from a dry run; a send reaches no one outside it.
//   GET  /api/instagram/keyword-dm/ledger?postUrl=
//
// Both sit behind the global bridgeAuth (X-Bridge-Key) that index.js installs before any route.
// `spawn` and the file locations are injectable so tests/keyword-dm-route.test.js can drive the
// routes over HTTP without Playwright or an Instagram session.

const fs = require('fs')
const path = require('path')
const childProcess = require('child_process')
const keywordDm = require('../som/helpers/keyword-dm')

const DEFAULT_ACCOUNTS = ['instagram-auth-thediscoverpage_.json', 'instagram-auth-freelabelnet.json', 'instagram-auth-hourdemayo.json', 'instagram-auth.json']

function findInstagramSession (rootDir, account) {
  const dirs = [path.join(rootDir, 'som'), path.join(rootDir, '..', 'tests', 'e2e')]
  const candidates = account ? [`instagram-auth-${account}.json`] : DEFAULT_ACCOUNTS
  for (const f of candidates) {
    for (const dir of dirs) {
      const p = path.join(dir, f)
      if (fs.existsSync(p)) return { file: p, candidates }
    }
  }
  return { file: null, candidates }
}

/** Sends wait ~45s ±40% between DMs; give the run room for that plus reading the comments. */
function runTimeoutMs (dry, max) {
  return dry ? 10 * 60 * 1000 : Math.max(10 * 60 * 1000, max * 2 * 60 * 1000 + 5 * 60 * 1000)
}

function mountKeywordDm (app, opts = {}) {
  const rootDir = opts.rootDir || path.join(__dirname, '..')
  const spawn = opts.spawn || childProcess.spawn
  const ledgerFile = opts.ledgerFile || keywordDm.DEFAULT_LEDGER_FILE
  const somLockFile = opts.somLockFile || '/tmp/som_batch.lock'
  const log = opts.log || ((m) => console.log(m))
  let current = null // { pid, startedAt, postUrl } while a run is in flight — one at a time

  app.post('/api/instagram/keyword-dm', (req, res) => {
    const built = keywordDm.buildRunEnv(req.body, { ledgerFile })
    if (built.error) return res.status(400).json({ error: built.error })
    const { env, dry, max } = built

    if (current) {
      return res.status(409).json({ error: `a keyword DM run is already in progress (pid ${current.pid}, ${current.postUrl})` })
    }
    // A SOM batch drives the same Instagram sessions; two browsers on one account invite a challenge.
    try {
      const lock = JSON.parse(fs.readFileSync(somLockFile, 'utf-8'))
      if (require('../som/som-lock').lockVerdict(lock) === 'busy') {
        return res.status(409).json({ error: `a SOM batch is running (pid ${lock.pid}); try again when it finishes` })
      }
    } catch { /* no lock file */ }

    const session = findInstagramSession(rootDir, env.IG_ACCOUNT)
    if (!session.file) {
      return res.status(404).json({
        error: 'No Instagram session found. Save one: iris hive credentials save-session --platform instagram',
        candidates: session.candidates
      })
    }
    if (!env.IG_ACCOUNT) {
      const base = path.basename(session.file).replace(/^instagram-auth-?/, '').replace(/\.json$/, '')
      if (base) env.IG_ACCOUNT = base
    }

    const timeoutMs = runTimeoutMs(dry, max)
    const args = ['playwright', 'test', 'som/instagram-keyword-dm.spec.ts', '--config', 'som/playwright.config.ts',
      '--reporter=line', '--workers=1', `--timeout=${timeoutMs}`]
    const childEnv = { ...process.env, ...env, BROWSER_SESSION_FILE: session.file }
    if (process.platform === 'linux' && !process.env.DISPLAY) childEnv.HEADLESS = '1'

    log(`[keyword-dm] ${dry ? 'DRY RUN' : 'SEND'} ${env.POST_URL} keyword=${env.KEYWORD} max=${max} account=@${env.IG_ACCOUNT}`)
    let stdout = ''
    let stderr = ''
    let finished = false
    // detached: its own process group, so stopping it reaches npx, playwright and the browser.
    const proc = spawn('npx', args, { cwd: rootDir, env: childEnv, detached: true })
    current = { pid: proc.pid, startedAt: Date.now(), postUrl: env.POST_URL }
    const stop = () => { try { process.kill(-proc.pid, 'SIGTERM') } catch { try { proc.kill('SIGTERM') } catch {} } }
    const timer = setTimeout(stop, timeoutMs + 60000)
    if (timer.unref) timer.unref()
    const done = () => { finished = true; clearTimeout(timer); current = null }

    // The person who asked went away (Ctrl-C in the CLI): stop rather than keep messaging people
    // nobody is watching. The ledger already holds every DM sent before this point.
    res.on('close', () => {
      if (!finished) {
        log('[keyword-dm] client disconnected — stopping the run')
        stop()
      }
    })

    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('error', (err) => {
      done()
      if (!res.headersSent) res.status(500).json({ error: `could not start playwright: ${err.message}` })
    })
    proc.on('close', (code) => {
      done()
      if (res.headersSent || res.writableEnded) return
      const summary = keywordDm.parseResultLine(stdout)
      if (!summary) {
        return res.status(500).json({ error: `keyword DM run produced no result (exit ${code})`, output: (stderr || stdout).slice(-2000) })
      }
      res.status(summary.ok ? 200 : 502).json({ ...summary, exitCode: code })
    })
  })

  app.get('/api/instagram/keyword-dm/ledger', (req, res) => {
    const postUrl = (req.query.postUrl || '').toString().trim()
    const key = keywordDm.postKey(postUrl)
    if (!key) return res.status(400).json({ error: 'postUrl must be an instagram.com /p/ or /reel/ URL' })
    const entries = keywordDm.ledgerEntries(keywordDm.readLedger(ledgerFile), postUrl)
    res.json({
      postUrl,
      key,
      entries,
      sent: entries.filter(e => !e.dry && e.status === 'sent').length,
      running: current ? { ...current } : null
    })
  })

  return { isRunning: () => !!current }
}

module.exports = { mountKeywordDm, findInstagramSession, runTimeoutMs }
