'use strict'

/**
 * What does a lead's reply mean? (#186253)
 *
 * Replaces HARD_OPTOUT_RE (som/inbox-followup.spec.ts), which matched the bare words "pass" and
 * "stop": "I'll pass this to my partner" and "can't stop thinking about it" marked warm leads opted
 * out — and an opted-out lead is never contacted again. The two mistakes do not cost the same:
 *   · a FALSE opt-out loses a lead forever, silently;
 *   · a MISSED opt-out messages someone who said stop — a compliance problem.
 * So, in order:
 *   1. EXPLICIT opt-out phrases are a hard rule — no model, no chance of softening them.
 *   2. Everything else is a typed decision (IRIS Decide, on this machine — the reply never leaves).
 *   3. A model "opt_out" below the confidence bar is HELD for a person: neither contacted nor
 *      opted out. Any other low-confidence answer is held too.
 */

const { decide } = require('./index')

// Unambiguous in any context — each names the SENDER's wish not to be contacted.
const EXPLICIT_OPTOUT_RE = /\b(unsubscribe|remove me|take me off|stop (messaging|texting|emailing|contacting|sending)|do ?n'?t (message|contact|text|email|dm) me|leave me alone|not interested|no thank(s| you),? (i'?m|im) (good|fine|not interested)|please stop|stop it)\b/i

// A reply that is NOTHING BUT a decline is an opt-out too — "no thanks" must not earn a "follow up next
// month". Anchored to the whole message, so "no thanks needed, happy to help!" is not caught.
const BARE_DECLINE_RE = /^\s*(no thanks?|no thank you|nah,? (i'?m|im) good|nope|no,? (i'?m|im) good)[\s.!,🙏]*$/i

const INTENTS = ['interested', 'question', 'not_now', 'opt_out', 'other']
const LABELS = {
  interested: 'interested — wants to go ahead, talk, or learn more',
  question: 'asking a question about the offer',
  not_now: 'not now — busy, later, maybe another time',
  opt_out: 'does not want to be contacted again',
  other: 'something else (unrelated, emoji only, auto-reply)'
}
const MIN_CONFIDENCE = 0.75

/**
 * @param {{reply:string, lastSent?:string}} input
 * @param {{engine?:object, minConfidence?:number}} opts
 * @returns {Promise<{intent:string|null, confidence:number, method:'rule'|'decide', hold:boolean, probabilities?:object}>}
 */
async function classifyReply ({ reply, lastSent = '' }, opts = {}) {
  const text = String(reply ?? '').trim()
  if (!text) return { intent: 'other', confidence: 1, method: 'rule', hold: false }
  if (EXPLICIT_OPTOUT_RE.test(text) || BARE_DECLINE_RE.test(text)) return { intent: 'opt_out', confidence: 1, method: 'rule', hold: false }

  const state = [lastSent ? `OUR LAST MESSAGE: ${lastSent}` : null, `THEIR REPLY: ${text}`].filter(Boolean).join('\n')
  const r = await decide({
    state,
    questions: {
      intent: {
        type: 'choice',
        instructions: 'What does THEIR REPLY mean for whether and how we follow up?',
        options: INTENTS.map(i => LABELS[i])
      }
    }
  }, { engine: opts.engine })
  const a = r.answers.intent
  if (a.value === null) return { intent: null, confidence: 0, method: 'decide', hold: true }
  const intent = INTENTS[INTENTS.map(i => LABELS[i]).indexOf(a.value)]
  const probabilities = Object.fromEntries(INTENTS.map(i => [i, a.probabilities[LABELS[i]]]))
  const bar = opts.minConfidence ?? MIN_CONFIDENCE
  return { intent, confidence: a.confidence, method: 'decide', hold: a.confidence < bar, probabilities }
}

/** Should the follow-up machinery treat this reply as an opt-out right now? Held ≠ opted out. */
function isOptOut (c) { return c.intent === 'opt_out' && !c.hold }

module.exports = { classifyReply, isOptOut, EXPLICIT_OPTOUT_RE, BARE_DECLINE_RE, INTENTS, MIN_CONFIDENCE }
