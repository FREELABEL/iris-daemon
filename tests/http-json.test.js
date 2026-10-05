const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const fs = require('fs')
const path = require('path')
const { requestJson } = require('../daemon/http-json')

// Every local-model turn longer than five minutes died at exactly 5m00s (iris-hive-001,
// 2026-10-05: Ollama `500 | 5m1s`). The cause was fetch()'s hidden 300s headers timeout, which
// no AbortSignal overrides. These tests pin the replacement: one timeout, the caller's.

let server, base
before(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const u = new URL(req.url, 'http://x')
      const delay = Number(u.searchParams.get('delay') || 0)
      setTimeout(() => {
        res.writeHead(Number(u.searchParams.get('status') || 200), { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ echo: raw ? JSON.parse(raw) : null }))
      }, delay)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

describe('requestJson', () => {
  it('waits for a slow server that sends no headers until it is done', async () => {
    const r = await requestJson({ method: 'POST', url: `${base}/?delay=400`, body: { a: 1 }, timeoutMs: 3000 })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.echo, { a: 1 })
  })

  it('gives up at the caller\'s timeout, and says so', async () => {
    await assert.rejects(requestJson({ url: `${base}/?delay=1500`, timeoutMs: 200 }), /no complete response within/)
  })

  it('an HTTP error is a response, not a throw', async () => {
    const r = await requestJson({ url: `${base}/?status=502` })
    assert.equal(r.status, 502)
  })

  it('a closed port is a rejection', async () => {
    await assert.rejects(requestJson({ url: 'http://127.0.0.1:9/', timeoutMs: 2000 }), /ECONNREFUSED/)
  })
})

describe('no fetch() on the long-running paths', () => {
  // fetch() is what capped them at five minutes. If either hop goes back to it, the cap comes back
  // silently — every short test still passes, and only a real 5-minute turn shows it.
  // Code only: the comments explaining WHY fetch() was removed mention fetch() themselves.
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'daemon', f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  it('local-llm.js chat() calls the model server through requestJson', () => {
    const body = src('local-llm.js').split('async function chat')[1].split('\nfunction ')[0]
    assert.match(body, /requestJson\(/)
    assert.doesNotMatch(body, /\bfetch\(/)
  })
  it('bridge-registry.js call() reaches the bridge through requestJson', () => {
    const body = src('bridge-registry.js').split('async function call')[1]
    assert.match(body, /requestJson\(/)
    assert.doesNotMatch(body, /\bfetch\(/)
  })
})
