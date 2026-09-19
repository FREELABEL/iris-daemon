'use strict'

// #186253 — reply intent. Unit layer (fake engine, runs anywhere) + a labelled set on the real
// local model (skips loudly without it). Zero false opt-outs is the bar.

const { test } = require('node:test')
const assert = require('node:assert')
const { classifyReply, isOptOut, EXPLICIT_OPTOUT_RE } = require('../decide/reply-intent')

const OLD_REGEX = /\b(no thanks|not interested|stop|unsubscribe|don't message|dont message|leave me alone|nah i'm good|nah im good|pass|no thank you|remove me)\b/i

test('explicit opt-outs are a hard rule — no model is asked', async () => {
  const boom = { name: 'x', model: 'x', complete: async () => { throw new Error('model must not be called') } }
  for (const r of ['Unsubscribe', 'please remove me from this list', 'stop messaging me', "don't message me again", 'not interested, thanks', 'leave me alone', 'no thanks', 'Nah im good.', 'no thank you!', 'nope']) {
    const c = await classifyReply({ reply: r }, { engine: boom })
    assert.strictEqual(c.intent, 'opt_out', r)
    assert.strictEqual(c.method, 'rule')
    assert.ok(isOptOut(c))
  }
})

test("the old regex's false opt-outs are NOT caught by the hard rule", () => {
  for (const r of ["I'll pass this to my partner", "can't stop thinking about it", 'no thanks needed, happy to help!']) {
    assert.ok(OLD_REGEX.test(r), `old regex should have (wrongly) matched: ${r}`)
    assert.ok(!EXPLICIT_OPTOUT_RE.test(r), `hard rule must not match: ${r}`)
  }
})

test('a low-confidence model opt-out is HELD — neither opted out nor contacted', async () => {
  const unsure = { name: 'f', model: 'f', complete: async (_, letters) => letters.map(l => ({ token: l, prob: l === 'D' ? 0.5 : 0.125 })) }
  const c = await classifyReply({ reply: 'hmm maybe not' }, { engine: unsure })
  assert.strictEqual(c.intent, 'opt_out')
  assert.strictEqual(c.hold, true)
  assert.strictEqual(isOptOut(c), false)
})

async function modelAvailable () {
  try {
    const r = await fetch((process.env.OLLAMA_HOST || 'http://127.0.0.1:11434') + '/api/tags', { signal: AbortSignal.timeout(2000) })
    return (await r.json()).models.some(m => m.name === (process.env.IRIS_DECIDE_MODEL || 'qwen3:4b'))
  } catch { return false }
}

// Written to look like real DM replies to an outreach message, including the regex's traps.
const LAST = 'Hey! Loved your recent post — we help artists get their music placed on curated playlists. Want me to send details?'
const LABELLED = [
  ["I'll pass this to my manager, she handles this", ['interested', 'question', 'not_now', 'other']],
  ["can't stop listening to that playlist you run, yes send it", ['interested']],
  ['yes please send details!', ['interested']],
  ['how much does it cost?', ['question']],
  ['is this legit? what playlists?', ['question']],
  ['not right now, maybe after my album drops in december', ['not_now']],
  ['super busy this month, hit me up next month', ['not_now']],
  ['no thanks', ['opt_out']],
  ['nah im good', ['opt_out']],
  ['🔥🔥', ['other', 'interested']],
  ['Thanks for your message! I am away until Monday.', ['other', 'not_now']],
  ['sure, what do you need from me?', ['interested', 'question']]
]

test('labelled replies on the real local model — ZERO false opt-outs, accepted intents otherwise', async (t) => {
  if (!(await modelAvailable())) { t.skip('local model not available — labelled set NOT run'); return }
  const rows = []
  for (const [reply, accept] of LABELLED) {
    const c = await classifyReply({ reply, lastSent: LAST })
    rows.push({ reply, intent: c.intent, conf: +c.confidence.toFixed(2), hold: c.hold, method: c.method })
    if (isOptOut(c)) assert.ok(accept.includes('opt_out'), `FALSE OPT-OUT: "${reply}" → ${c.intent} ${c.confidence}`)
    if (!c.hold) assert.ok(accept.includes(c.intent), `"${reply}" → ${c.intent} (${c.confidence}); accepted: ${accept}`)
  }
  const old = LABELLED.filter(([r, a]) => OLD_REGEX.test(r) && !a.includes('opt_out')).length
  t.diagnostic(`old regex false opt-outs on this set: ${old}; new: 0`)
  t.diagnostic(JSON.stringify(rows))
})
