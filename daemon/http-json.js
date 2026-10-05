/**
 * One JSON request over node:http(s), with exactly the timeout the caller asks for.
 *
 * WHY NOT fetch(): Node's built-in fetch (undici) has a hidden headersTimeout of 300s — it gives
 * up when no response HEADERS have arrived after five minutes, whatever AbortSignal you pass. A
 * model server answering a non-streaming chat sends nothing until the whole answer is ready, so
 * every turn longer than five minutes died at exactly 5m00s, even with a 10-minute budget.
 * Measured on iris-hive-001, 2026-10-05: Ollama logged `500 | 5m1s | POST /v1/chat/completions`
 * for a 5,882-token agent turn. This helper has one timeout and it is the one you pass.
 *
 * Resolves { status, body } where body is the parsed JSON or null. Rejects only when there is no
 * response at all (connection refused, timeout) — an HTTP error status is a response, not a throw.
 */
const http = require('http')
const https = require('https')

function requestJson ({ method = 'GET', url, headers = {}, body, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch (e) { return reject(new Error(`bad URL ${url}: ${e.message}`)) }
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body))
    const h = { Accept: 'application/json', ...headers }
    if (payload !== null) {
      h['Content-Type'] = h['Content-Type'] || 'application/json'
      h['Content-Length'] = Buffer.byteLength(payload)
    }
    const req = (u.protocol === 'https:' ? https : http).request(u, { method, headers: h }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let parsed = null
        try { parsed = raw ? JSON.parse(raw) : null } catch { parsed = null }
        resolve({ status: res.statusCode, body: parsed, raw })
      })
      res.on('error', reject)
    })
    // One deadline for the whole exchange — not an idle timer, which a slow-but-alive server resets.
    const deadline = setTimeout(() => req.destroy(new Error(`no complete response within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)
    req.on('close', () => clearTimeout(deadline))
    req.on('error', (e) => { clearTimeout(deadline); reject(e) })
    if (payload !== null) req.write(payload)
    req.end()
  })
}

module.exports = { requestJson }
