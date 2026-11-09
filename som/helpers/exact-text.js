'use strict'
// Send the approved text, word for word (#192413).
//
// "Vary It" rewrites a strategy's step through a model before every DM. On 2026-11-02 the approved
// "Saw you're into AI..." went out as "Noticed your interest in AI... Getting started is free": same
// pitch, words nobody approved. Exact mode skips Vary It (and Personalize) and sends the step's own text.
//
// Opt in, either:
//   per run       SOM_EXACT_TEXT=1
//   per strategy  the step's `verbatim` flag (outreach_strategy_template_steps.verbatim, already in the
//                 API: "send the instructions as written; no model rewrites them")
// Default (neither set) is unchanged: the batch varies every message.
//
// Merge fields are the one thing exact mode still fills in, from the lead itself, so "{first_name}" never
// reaches a person. A token it cannot fill stops the lead: nothing is sent rather than a broken message.

const truthy = v => v === true || v === 1 || /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim())

/** Exact mode for this run/step, and which setting turned it on. */
function exactTextMode ({ env = process.env, step = null } = {}) {
  if (truthy(env.SOM_EXACT_TEXT)) return { exact: true, source: 'SOM_EXACT_TEXT' }
  if (step && truthy(step.verbatim)) return { exact: true, source: 'strategy step verbatim' }
  return { exact: false, source: '' }
}

/** The steps of the named strategy in send order, or [] when it is not on the board. */
function strategySteps (templates, name) {
  const strat = (Array.isArray(templates) ? templates : []).find(t => t && t.name === name)
  const steps = strat && Array.isArray(strat.steps) ? [...strat.steps] : []
  return steps.sort((a, b) => (Number(a && a.order) || 0) - (Number(b && b.order) || 0))
}

const TOKEN = /\{([a-z][a-z0-9_]{1,39})\}/g

function leadFields (lead = {}) {
  const ci = lead.contact_info || {}
  const handle = String(lead.handle || ci.instagram || ci.social_handle || lead.nickname || '').replace(/^@/, '')
  const name = String(lead.name || '').trim()
  // A handle is not a first name: "Hey savvy_karan" reads as a bot. Only a name with a space is split.
  const first = name && name.includes(' ') ? name.split(/\s+/)[0] : ''
  return {
    name,
    first_name: first,
    company: String(lead.company || ci.company || '').trim(),
    instagram: handle,
    social_handle: handle,
  }
}

/**
 * The text to send for an approved script. ok=false (with the tokens) when a merge field has no value
 * for this lead, so the caller skips the lead instead of sending "{first_name}" or "Hey ,".
 */
function renderExact (script, lead = {}) {
  const text = String(script || '').trim()
  if (!text) return { ok: false, text: '', unresolved: [], reason: 'the strategy step has no text' }
  const fields = leadFields(lead)
  const unresolved = []
  const out = text.replace(TOKEN, (whole, key) => {
    const v = Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : ''
    if (!v) { unresolved.push(whole); return whole }
    return v
  })
  if (unresolved.length) return { ok: false, text: out, unresolved: [...new Set(unresolved)], reason: `no value for ${[...new Set(unresolved)].join(', ')}` }
  return { ok: true, text: out, unresolved: [], reason: '' }
}

module.exports = { exactTextMode, strategySteps, renderExact, leadFields }
