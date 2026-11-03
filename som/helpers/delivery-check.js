'use strict'
// After we press send: did Instagram refuse it? (#192164)
//
// A refused message stays on screen, so "it appeared in the thread" proved nothing: on 2026-11-01, 16 of 32
// visible threads on one account carried the refusal under a message counted as sent. A read of the live
// inbox that day showed the refusal is its own message in the thread:
//   content_type REACHABILITY_SETTINGS_ONE_WAY_SEND_XMAT, sent by us,
//   in data.get_slide_thread_nullable.as_ig_direct_thread.slide_messages.
// The type does not depend on wording or language. The text check is the fast path and the fallback.
//
//   sent              read the thread back: our message is there and no refusal follows it
//   undeliverable     Instagram refused it
//   delivered-unknown it went out and we cannot say. Never reported as delivered.

const REFUSED_TEXT = /can.t receive your message|don.t allow new message requests/i
// Wording we have not seen. Not proof of a refusal, but enough to stop calling it sent.
const WARNING_TEXT = /couldn.t send|could not send|not delivered|failed to send|unable to send|tap to retry|can.t (send|message)|cannot (send|message)|isn.t available|not accepting/i
const REFUSED_TYPE = /REACHABILITY/i

const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase()

function nodeText (n) {
  const parts = [n.text_body, n.content && n.content.text_body, n.igd_snippet]
  const frags = (n.content && n.content.text_fragments) || []
  for (const f of frags) parts.push(f && f.plaintext)
  return parts.filter(p => typeof p === 'string').join(' ')
}

/**
 * The open thread from one /api/graphql body, or null. Only get_slide_thread_nullable counts: mailbox
 * payloads arrive on the same URL and hold other people's refusals.
 */
function parseThreadPayload (json, handle) {
  const t = json && json.data && json.data.get_slide_thread_nullable && json.data.get_slide_thread_nullable.as_ig_direct_thread
  if (!t) return null
  const want = norm(handle).replace(/^@/, '')
  if (!(t.users || []).some(u => norm(u && u.username) === want)) return null
  const viewer = String((t.viewer && t.viewer.interop_messaging_user_fbid) || '')
  const nodes = ((t.slide_messages && t.slide_messages.edges) || []).map(e => e && e.node).filter(Boolean)
    .map(n => ({
      refused: REFUSED_TYPE.test(String(n.content_type || '')),
      fromViewer: !!viewer && String(n.sender_fbid) === viewer,
      text: nodeText(n),
      timestampMs: Number(n.timestamp_ms) || 0,
    }))
    .sort((a, b) => a.timestampMs - b.timestampMs)
  return { nodes }
}

function classifyDelivery ({ bubbleVisible = false, threadText = '', payload = null, message = '' } = {}) {
  const refusedReason = "this account can't receive your message"
  if (REFUSED_TEXT.test(threadText)) return { outcome: 'undeliverable', reason: refusedReason }

  let ours = -1
  let lastRefusal = -1
  if (payload) {
    const want = norm(message).slice(0, 40)
    payload.nodes.forEach((n, i) => {
      if (n.refused) lastRefusal = i
      else if (n.fromViewer && want && norm(n.text).includes(want)) ours = i
    })
    if (lastRefusal >= 0 && lastRefusal > ours) return { outcome: 'undeliverable', reason: refusedReason }
  }
  if (WARNING_TEXT.test(threadText)) return { outcome: 'delivered-unknown', reason: 'the thread shows a warning we do not recognise' }
  if (!payload) {
    return { outcome: 'delivered-unknown', reason: bubbleVisible ? 'could not read the thread back' : 'typed and submitted, not seen in the thread' }
  }
  if (ours < 0) return { outcome: 'delivered-unknown', reason: 'our message is not in the thread we read back' }
  return { outcome: 'sent', reason: '' }
}

/** Blocks of text in the page, minus the thread list, which previews other people's refusals. */
function scopedThreadText (blocks) {
  return (blocks || []).filter(b => !b.inThreadList).map(b => b.text).join('\n')
}

/** What the open thread says, leaving out the thread list. '' when it cannot be read. */
async function readThreadText (page) {
  const blocks = await page.evaluate(() => [...document.querySelectorAll('[role="main"] div[dir="auto"], [role="main"] span[dir="auto"], [role="main"] [role="article"]')]
    .map(e => ({ inThreadList: !!e.closest('[role="navigation"]'), text: e.innerText || '' }))).catch(() => [])
  return scopedThreadText(blocks)
}

/** Reload the thread and take what Instagram's own page loads for it. null when it never arrives. */
async function readThreadBack (page, handle, { timeoutMs = 10000 } = {}) {
  let payload = null
  const seen = async res => {
    try {
      if (!res.url().includes('graphql')) return
      const body = await res.text()
      if (!body.includes('get_slide_thread_nullable')) return
      payload = parseThreadPayload(JSON.parse(body), handle) || payload
    } catch { /* not JSON, or the page closed */ }
  }
  page.on('response', seen)
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
    for (let waited = 0; waited < timeoutMs && !payload; waited += 500) await page.waitForTimeout(500)
  } catch { /* payload stays null, which reads as unknown */ } finally {
    page.off('response', seen)
  }
  return payload
}

/** The whole check, called straight after the delivery wait. Never throws: not knowing is an answer. */
async function checkDelivery (page, { handle, message, bubbleVisible, settleMs = 2500 }) {
  try {
    await page.waitForTimeout(settleMs) // the refusal is drawn a moment after the message appears
    const threadText = await readThreadText(page)
    const quick = classifyDelivery({ bubbleVisible, threadText, payload: null, message })
    if (quick.outcome === 'undeliverable') return quick
    const payload = await readThreadBack(page, handle)
    return classifyDelivery({ bubbleVisible, threadText, payload, message })
  } catch (err) {
    return { outcome: 'delivered-unknown', reason: `check failed: ${String(err && err.message).slice(0, 80)}` }
  }
}

module.exports = { REFUSED_TEXT, REFUSED_TYPE, parseThreadPayload, classifyDelivery, scopedThreadText, readThreadText, readThreadBack, checkDelivery }
