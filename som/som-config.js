/**
 * SOM Campaign Config — Three-tier resolution
 *
 *   1. disk cache  (.som-campaigns-cache.json, written by syncFromApi)
 *   2. inline baked-in defaults (offline fallback)
 *
 * Phase 1A: API-aware via on-demand sync. Run `npm run som:sync` (or call
 * syncFromApi() directly) to refresh the cache from fl-api. Consumers stay
 * synchronous — they read the cache or the inline fallback at require time.
 *
 * Used by: som.js, som-all.js, task-executor.js, inbox-followup
 */

const path = require('path')
const fs = require('fs')

const sessionDir = __dirname
const cacheFile = path.join(__dirname, '.som-campaigns-cache.json')

// ─── INLINE FALLBACK (baked-in defaults — used when cache is missing) ─────────
const inlineCampaigns = {
  courses:      { boardId: '38',  strategy: 'AI Course | V3',                   igAccount: 'heyiris.io',         twAccount: 'freelabelnet', active: true,  label: 'AI Course Outreach',    color: '\x1b[36m' },
  creators:     { boardId: '80',  strategy: 'Creator Outreach | V1',            igAccount: 'thediscoverpage_',   twAccount: 'freelabelnet', active: true,  label: 'Creator Outreach',      color: '\x1b[35m' },
  beatbox:      { boardId: '224', strategy: 'DJ Outreach | V2',                 igAccount: 'thebeatbox__',       twAccount: 'freelabelnet', active: true,  label: 'DJ Outreach',           color: '\x1b[33m' },
  mayo:         { boardId: '176', strategy: 'Mayo Outreach | V2',               igAccount: 'hourdemayo',         twAccount: 'freelabelnet', active: true,  label: 'Mayo Outreach',         color: '\x1b[32m' },
  venues:       { boardId: '292', strategy: 'Venue Partnership | V1',           igAccount: 'freelabelnet',       twAccount: 'freelabelnet', active: true,  label: 'Venue Partnership',     color: '\x1b[31m' },
  freelabelnet: { boardId: '355', strategy: 'Artist Outreach | FFAT V1',        igAccount: 'freelabelnet',       twAccount: 'freelabelnet', active: true,  label: 'FFAT Artists (Austin)', color: '\x1b[34m' },
  atxbeauty:    { boardId: '283', strategy: 'Beauty & Wellness Outreach | V1',  igAccount: 'atxbeautylab.lisa',  twAccount: 'freelabelnet', active: false, label: 'ATX Beauty Outreach',   color: '\x1b[95m' },
  gooddeals:    { boardId: '302', strategy: 'LinkedIn Founder Outreach | V1',   igAccount: null,                 twAccount: null,           active: false, label: 'Good Deals Outreach',   color: '\x1b[32m' },
}

// ─── RESOLVE: prefer cache, fall back to inline ──────────────────────────────
function loadCampaigns () {
  try {
    if (fs.existsSync(cacheFile)) {
      const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      if (raw && raw.campaigns && Object.keys(raw.campaigns).length) {
        return raw.campaigns
      }
    }
  } catch (e) {
    // fall through to inline
  }
  return inlineCampaigns
}

const campaigns = loadCampaigns()

// Derive session file path from igAccount
for (const c of Object.values(campaigns)) {
  c.sessionFile = c.igAccount ? path.join(sessionDir, `instagram-auth-${c.igAccount}.json`) : null
}

// ─── SYNC FROM API ───────────────────────────────────────────────────────────
/**
 * Fetch the live campaign registry from fl-api and write the disk cache.
 * Caller must `await` this. After a successful sync, the next require of this
 * module will pick up the new data.
 *
 * @param {object} opts
 * @param {string} [opts.apiUrl=https://raichu.heyiris.io]
 * @param {string} [opts.token=process.env.IRIS_API_KEY]
 * @returns {Promise<{campaigns: object, count: number}>}
 */
async function syncFromApi ({ apiUrl, token } = {}) {
  apiUrl = apiUrl || process.env.SOM_API_URL || 'https://raichu.heyiris.io'
  token = token || process.env.IRIS_API_KEY || process.env.FL_RAICHU_API_TOKEN
  if (!token) throw new Error('No API token (set IRIS_API_KEY)')

  const url = `${apiUrl.replace(/\/$/, '')}/api/v1/som/campaigns`
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  })
  if (!res.ok) throw new Error(`API ${res.status} ${res.statusText} — ${url}`)
  const body = await res.json()
  const list = body?.data?.campaigns || []

  // Convert API shape → local shape (keyed by name, with strategy as string)
  const next = {}
  for (const c of list) {
    next[c.name] = {
      boardId: String(c.bloq_id),
      strategy: c.strategy_name || null,
      igAccount: c.ig_account,
      twAccount: c.tw_account,
      active: !!c.active,
      label: c.label,
      color: c.color || null,
      // pass-through for future consumers
      _campaignId: c.id,
      _strategyId: c.strategy_template_id,
      _endsAt: c.ends_at,
      _geoTag: c.geo_tag,
    }
  }

  fs.writeFileSync(cacheFile, JSON.stringify({ syncedAt: new Date().toISOString(), campaigns: next }, null, 2))
  return { campaigns: next, count: Object.keys(next).length }
}

// Shell-safe strategy aliases → full names (used by som.js for CLI shorthand)
const strategyAliases = {
  'ai-course-v3': 'AI Course | V3',
  'ai-course':    'AI Course | V3',
  'creator-v1':   'Creator Outreach | V1',
  'creator':      'Creator Outreach | V1',
  'dj-v1':        'DJ Outreach | V1',
  'dj-v2':        'DJ Outreach | V2',
  'dj':           'DJ Outreach | V2',
  'mayo-v1':      'Mayo Outreach | V1',
  'mayo-v2':      'Mayo Outreach | V2',
  'mayo':         'Mayo Outreach | V2',
  'ffat-v1':         'Artist Outreach | FFAT V1',
  'ffat':            'Artist Outreach | FFAT V1',
  'artist-ffat':     'Artist Outreach | FFAT V1',
  'freelabelnet-v1': 'Artist Outreach | FFAT V1',
  'freelabelnet':    'Artist Outreach | FFAT V1',
  'beauty-v1':    'Beauty & Wellness Outreach | V1',
  'beauty':       'Beauty & Wellness Outreach | V1',
  'atxbeauty':    'Beauty & Wellness Outreach | V1',
  'venue':        'Venue Partnership | V1',
  'venues':       'Venue Partnership | V1',
  'venue-v1':     'Venue Partnership | V1',
  'linkedin-founder-v1': 'LinkedIn Founder Outreach | V1',
  'linkedin-founder':    'LinkedIn Founder Outreach | V1',
  'ig-financial-v1':     'Instagram Financial Advisory | V1',
  'ig-financial':        'Instagram Financial Advisory | V1',
  'email-financial-v1':  'Email Financial Advisory | V1',
  'email-financial':     'Email Financial Advisory | V1',
  'gooddeals':           'LinkedIn Founder Outreach | V1',
}

// Derived: unique active IG accounts for inbox scanning (deduped by igAccount)
function getActiveAccounts () {
  const seen = new Set()
  const result = {}
  for (const [id, c] of Object.entries(campaigns)) {
    if (!c.active) continue
    if (seen.has(c.igAccount)) continue
    seen.add(c.igAccount)
    result[id] = { id, igAccount: c.igAccount, boardId: c.boardId, label: c.label, sessionFile: c.sessionFile }
  }
  return result
}

// For som.js: campaign config in the format it expects (BOARD_ID, STRATEGY, IG_ACCOUNT, TW_ACCOUNT)
function getSomCampaigns () {
  const result = {}
  for (const [id, c] of Object.entries(campaigns)) {
    result[id] = { BOARD_ID: c.boardId, STRATEGY: c.strategy, IG_ACCOUNT: c.igAccount, TW_ACCOUNT: c.twAccount }
  }
  return result
}

// For som-all.js: campaign registry in the format it expects (active, label, color, boardId)
function getCampaignRegistry () {
  const result = {}
  for (const [id, c] of Object.entries(campaigns)) {
    result[id] = { active: c.active, label: c.label, color: c.color, boardId: parseInt(c.boardId, 10), strategy: c.strategy }
  }
  return result
}

// For task-executor.js: campaign configs keyed by campaign id
function getDaemonConfigs () {
  const result = {}
  for (const [id, c] of Object.entries(campaigns)) {
    result[id] = { boardId: c.boardId, strategy: c.strategy, igAccount: c.igAccount }
  }
  return result
}

// Inspect resolution — useful for debugging "why is this campaign behaving differently?"
function getResolutionSource () {
  if (fs.existsSync(cacheFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      return { source: 'cache', file: cacheFile, syncedAt: raw.syncedAt }
    } catch (e) {
      return { source: 'inline', reason: 'cache parse error' }
    }
  }
  return { source: 'inline', reason: 'no cache file' }
}

/**
 * SOM Preflight — check if a campaign board has eligible leads BEFORE launching Chromium.
 * Uses /leads/outreach-funnel API. Returns { eligible, total, skip, reason }.
 *
 * Modes:
 *   - "new" (default): check never_contacted > 0 (first-contact DMs)
 *   - "followup": check pending > 0 on any step (sequence continuation)
 *
 * @param {string} boardId
 * @param {string|null} strategy
 * @param {object} [opts]
 * @param {string} [opts.mode]       "new" | "followup" (default: "new")
 * @param {number} [opts.waitDays]   Min days since last step before follow-up is eligible (default: 2)
 * @param {string} [opts.apiUrl]
 * @param {string} [opts.token]
 * @returns {Promise<{eligible: number, total: number, skip: boolean, reason: string}>}
 */
async function preflightCheck (boardId, strategy, opts = {}) {
  const mode = opts.mode || 'new'
  const waitDays = opts.waitDays ?? 2
  const apiBase = opts.apiUrl || process.env.IRIS_FL_API_URL || 'https://raichu.heyiris.io'
  const apiToken = opts.token || process.env.HEYIRIS_TOKEN || 'ca54cd87e7046098eee99de3b9c98cfd'

  try {
    let url = `${apiBase}/api/v1/leads/outreach-funnel?bloq_id=${boardId}`
    if (strategy && strategy !== 'undefined') url += `&strategy=${encodeURIComponent(strategy)}`

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) {
      // Fallback to /leads/stats if funnel endpoint not available
      const statsUrl = `${apiBase}/api/v1/leads/stats?bloq_id=${boardId}`
      const statsRes = await fetch(statsUrl, {
        headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      })
      if (!statsRes.ok) return { eligible: -1, total: -1, skip: false, reason: 'api_error' }
      const statsJson = await statsRes.json()
      const eng = statsJson.data?.engagement || {}
      const eligible = (eng.never_contacted || 0) + (eng.outreach_pending || 0)
      const total = statsJson.data?.total_leads || 0
      if (eligible === 0) return { eligible: 0, total, skip: true, reason: `All ${total} leads completed` }
      return { eligible, total, skip: false, reason: `${eligible} eligible (fallback)` }
    }

    const json = await res.json()
    const data = json.data || {}
    const total = data.total_leads || 0
    const neverContacted = data.never_contacted || 0
    const steps = data.steps || []

    if (total === 0) {
      return { eligible: 0, total: 0, skip: true, reason: `Board ${boardId} has 0 leads` }
    }

    // Log the funnel for visibility
    if (steps.length > 0) {
      for (const s of steps) {
        console.log(`[preflight]   Step ${s.step} "${s.title}": ${s.completed}/${s.eligible} (${s.conversion}%)`)
      }
    }
    if (neverContacted > 0) {
      console.log(`[preflight]   Never contacted: ${neverContacted}`)
    }

    // ── mode=followup: use per-lead follow-up-ready endpoint ──
    if (mode === 'followup') {
      try {
        const followupUrl = `${apiBase}/api/v1/leads/follow-up-ready?bloq_id=${boardId}&wait_days=${waitDays}&limit=500`
        const followupRes = await fetch(followupUrl, {
          headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(10000),
        })

        if (followupRes.ok) {
          const followupData = await followupRes.json()
          const followupEligible = followupData.total || 0

          if (followupEligible === 0) {
            return {
              eligible: 0, total, skip: true,
              reason: `No leads past ${waitDays}-day wait period`,
            }
          }

          return {
            eligible: followupEligible, total, skip: false,
            reason: `${followupEligible} follow-up leads ready (past ${waitDays}-day wait)`,
          }
        }
      } catch (e) {
        console.log(`[preflight] follow-up-ready API failed: ${e.message} — falling back to funnel`)
      }

      // Fallback to funnel-based estimation if follow-up-ready endpoint fails
      const allPending = steps.reduce((sum, s) => sum + (s.pending || 0), 0)
      if (allPending === 0) {
        return { eligible: 0, total, skip: true, reason: 'No follow-up leads pending' }
      }
      return { eligible: allPending, total, skip: false, reason: `${allPending} follow-up leads (funnel fallback)` }
    }

    // ── mode=new (default): check never_contacted ──
    const pendingOnSteps = steps.filter(s => {
      const pending = s.pending ?? (s.eligible - s.completed)
      return pending > 0
    })
    const totalPending = pendingOnSteps.reduce((sum, s) => sum + (s.pending ?? (s.eligible - s.completed)), 0)

    console.log(`[preflight] Board ${boardId}: never_contacted=${neverContacted}, totalPending=${totalPending}, steps=${steps.length}`)
    if (pendingOnSteps.length > 0) {
      for (const s of pendingOnSteps) {
        const p = s.pending ?? (s.eligible - s.completed)
        console.log(`[preflight]   → Step ${s.step} "${s.title}": ${p} pending (${s.completed}/${s.eligible} done)`)
      }
    }

    if (neverContacted === 0 && totalPending === 0) {
      console.log(`[preflight] SKIP: Board ${boardId} — all ${total} leads fully completed`)
      return {
        eligible: 0, total, skip: true,
        reason: `All ${total} leads fully completed all outreach steps`,
      }
    }

    if (neverContacted === 0 && totalPending > 0) {
      const stepSummary = pendingOnSteps.map(s => `${s.title}: ${s.pending ?? (s.eligible - s.completed)} pending`).join(', ')
      const nextAction = data.next_action
      console.log(`[preflight] ALLOW: Board ${boardId} — 0 new, ${totalPending} pending steps`)
      return {
        eligible: totalPending, total, skip: false,
        reason: `0 new, but ${totalPending} leads need follow-up (${stepSummary})` + (nextAction ? ` — next: ${nextAction.action}` : ''),
      }
    }

    const nextAction = data.next_action
    console.log(`[preflight] ALLOW: Board ${boardId} — ${neverContacted} new leads`)
    return {
      eligible: neverContacted, total, skip: false,
      reason: `${neverContacted} new leads to contact` + (nextAction ? ` (next: ${nextAction.action})` : ''),
    }
  } catch (err) {
    console.log(`[preflight] Preflight failed: ${err.message} — will run anyway`)
    return { eligible: -1, total: -1, skip: false, reason: 'preflight_error' }
  }
}

module.exports = {
  campaigns,
  strategyAliases,
  getActiveAccounts,
  getSomCampaigns,
  getCampaignRegistry,
  getDaemonConfigs,
  getResolutionSource,
  syncFromApi,
  preflightCheck,
}
