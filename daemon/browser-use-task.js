/**
 * browser_use — structured browser checks run with browser-use in a THROWAWAY headless Chrome.
 *
 * The V6 tool `hiveBrowserUse` dispatches these. The prompt is `"<function> key=value ..."`
 * (V6ToolRegistry::buildHivePrompt); config.args, when present, wins over the prompt.
 *
 * Deliberately NOT "run this Python": a model choosing code to execute on someone's machine is
 * a different product with a different review. Every function here is a fixed script with
 * validated parameters, and the same script is what the `browser-use` skill runs by hand —
 * one implementation, two callers, so they cannot drift.
 *
 * Result contract (task.result.data):
 *   { function, measured, ok, failures[], screenshots[{filename,url}], ...script fields }
 * A page with failures is a SUCCESSFUL check (status completed, ok:false). Only a check that
 * could not measure is a failed task — the three states stay three.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

const FUNCTIONS = new Set(['render_check'])

// Screenshots are uploaded to a public CDN bucket. A URL that carries its own credential opens
// a gated page to a browser with no session — `?atlas_token=` is known to bypass the page gate —
// so capturing it would publish what the gate exists to keep private. Refuse, and say why.
const CREDENTIAL_PARAMS = /^(atlas_token|atlas_session|token|access_token|auth|otp|code|key|api_key|apikey|sig|signature|session|password|jwt)$/i

const VIEWPORTS_RE = /^[a-z]+:\d{3,4}x\d{3,4}(,[a-z]+:\d{3,4}x\d{3,4}){0,3}$/
const SCHEMES = new Set(['light', 'dark'])

function scriptPath () {
  const candidates = [
    process.env.IRIS_BROWSER_USE_SCRIPT,
    path.join(__dirname, '..', 'scripts', 'browser-use', 'render-check.sh'),
    path.join(os.homedir(), '.iris', 'bridge', 'scripts', 'browser-use', 'render-check.sh')
  ].filter(Boolean)
  return candidates.find(p => fs.existsSync(p)) || null
}

function parsePrompt (prompt) {
  const text = String(prompt || '').trim()
  const firstSpace = text.search(/\s/)
  const fn = (firstSpace === -1 ? text : text.slice(0, firstSpace)).trim()
  const args = {}
  const rest = firstSpace === -1 ? '' : text.slice(firstSpace + 1)
  for (const part of rest.split(/\s+(?=[a-z_]+=)/i)) {
    const eq = part.indexOf('=')
    if (eq > 0) args[part.slice(0, eq).trim()] = part.slice(eq + 1).trim() // first '=' only: URLs carry more
  }
  return { fn, args }
}

/** Returns { args } or throws with a message the agent can act on. */
function validate (fn, raw) {
  if (!FUNCTIONS.has(fn)) {
    throw new Error(`browser_use has no function "${fn}". Available: ${[...FUNCTIONS].join(', ')}`)
  }
  let url
  try { url = new URL(String(raw.url || '')) } catch {
    throw new Error(`render_check needs a full http(s) url, got "${raw.url || ''}"`)
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error(`render_check only checks http(s) pages, got ${url.protocol}`)
  if (url.username || url.password) throw new Error('refusing a url with embedded credentials — screenshots are uploaded to a public CDN')
  const cred = [...url.searchParams.keys()].find(k => CREDENTIAL_PARAMS.test(k))
  if (cred) {
    throw new Error(
      `refusing to screenshot a url carrying "${cred}=" — it can open a gated page, and screenshots ` +
      'are uploaded to a public CDN. Check the public url, or verify gated pages by hand.'
    )
  }
  const viewports = String(raw.viewports || 'desktop:1280x900,mobile:390x844').replace(/\s+/g, '').toLowerCase()
  if (!VIEWPORTS_RE.test(viewports)) {
    throw new Error(`viewports must look like "desktop:1280x900,mobile:390x844" (max 4), got "${raw.viewports}"`)
  }
  const schemes = String(raw.schemes || 'light').replace(/\s+/g, '').toLowerCase().split(',').filter(Boolean)
  if (!schemes.length || schemes.some(s => !SCHEMES.has(s))) {
    throw new Error(`schemes must be light, dark or light,dark — got "${raw.schemes}"`)
  }
  return { url: url.toString(), viewports, schemes: schemes.join(',') }
}

function runScript (script, args, outDir, timeoutMs) {
  return new Promise((resolve) => {
    execFile('bash', [script, args.url, '--out', outDir, '--viewports', args.viewports, '--schemes', args.schemes], {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, BH_TELEMETRY: '0' }
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, killed: !!(err && err.killed), stdout, stderr })
    })
  })
}

/**
 * Run one browser_use task. Never throws: returns the payload for cloud.submitResult.
 * `upload(files)` → [{filename,url}] — injected so tests run without a cloud.
 */
async function runBrowserUseTask (task, { upload, timeoutMs = 180000 } = {}) {
  const started = Date.now()
  const fail = (error, extra = {}) => ({ status: 'failed', error, duration_ms: Date.now() - started, metadata: { browser_use: true, ...extra } })

  if (process.platform === 'win32') {
    return fail('browser_use is not supported on Windows nodes yet — dispatch to a macOS or Linux node.')
  }

  const parsed = parsePrompt(task.prompt)
  const fn = (task.config && task.config.function) || parsed.fn
  const rawArgs = { ...parsed.args, ...((task.config && task.config.args) || {}) }

  let args
  try { args = validate(fn, rawArgs) } catch (e) { return fail(e.message, { function: fn }) }

  const script = scriptPath()
  if (!script) return fail('render-check.sh is missing from this node — update the IRIS bridge.', { function: fn })

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-browser-use-'))
  try {
    const run = await runScript(script, args, outDir, timeoutMs)
    const line = String(run.stdout || '').trim().split('\n').filter(l => l.startsWith('{')).pop()
    let data
    try { data = JSON.parse(line) } catch {
      const why = run.killed ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `exit ${run.code}`
      return fail(`render_check produced no result (${why}): ${String(run.stderr || run.stdout || '').slice(-600)}`, { function: fn })
    }
    data.function = fn

    if (data.measured === false) {
      return { ...fail(`could not measure ${args.url}: ${data.error}`, { function: fn }), data, output: JSON.stringify(data) }
    }

    const shots = (data.screenshots || []).filter(p => fs.existsSync(p))
    data.screenshots = shots.map(p => ({ filename: path.basename(p) }))
    if (shots.length && upload) {
      try {
        const urls = await upload(shots.map(p => ({
          filename: path.basename(p),
          content_base64: fs.readFileSync(p).toString('base64'),
          content_type: 'image/png'
        })))
        const byName = new Map((urls || []).map(u => [u.filename, u.url]))
        data.screenshots = shots.map(p => ({ filename: path.basename(p), url: byName.get(path.basename(p)) || null }))
        data.screenshots_uploaded = data.screenshots.every(s => s.url)
      } catch (e) {
        // The verdict stands without pictures; say the pictures are missing rather than drop them silently.
        data.screenshots_uploaded = false
        data.upload_error = e.message
      }
    } else {
      data.screenshots_uploaded = false
    }

    const summary = data.ok
      ? `render_check passed: ${args.url}`
      : `render_check found ${data.failures.length} problem(s) on ${args.url}: ${data.failures.join('; ')}`
    return {
      status: 'completed',
      data,
      output: summary,
      duration_ms: Date.now() - started,
      metadata: { browser_use: true, function: fn, ok: data.ok }
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true })
  }
}

module.exports = { runBrowserUseTask, parsePrompt, validate, FUNCTIONS }
