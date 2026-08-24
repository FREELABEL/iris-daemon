/**
 * GET /api/imessage/mentions — #182121
 *
 * index.js instantiates and (conditionally) listens on the real bridge port as a side
 * effect of being required, so — same convention as tests/bridge-security.test.js — this
 * stands up an isolated Express app carrying a copy of just the route under test rather
 * than requiring index.js directly. HOME is redirected to a scratch dir per test, the
 * same trick tests/imessage-mention-logging.test.js uses, since the route reads
 * os.homedir() fresh on every request rather than accepting an injected path.
 */
const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const express = require('express')

function withScratchHome () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imessage-mentions-route-test-'))
  const realHome = process.env.HOME
  process.env.HOME = dir
  return {
    dir,
    restore () {
      process.env.HOME = realHome
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

function writeMentionFile (dateStr, rows) {
  const dir = path.join(os.homedir(), '.iris', 'mentions')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${dateStr}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

// Exact copy of the route body in index.js — see that file's own comment for why this
// isn't required as a module instead.
function mentionsRoute (req, res) {
  const mentionsDir = path.join(os.homedir(), '.iris', 'mentions')
  const days = Math.max(1, Math.min(365, parseInt(req.query.days || '30', 10)))
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '50', 10)))

  if (!fs.existsSync(mentionsDir)) {
    return res.json({ mentions: [], count: 0, source: 'local-file' })
  }

  try {
    const cutoff = new Date(Date.now() - days * 86400 * 1000)
    const files = fs.readdirSync(mentionsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .filter((f) => new Date(f.replace('.jsonl', '')) >= cutoff)

    let mentions = []
    for (const file of files) {
      const lines = fs.readFileSync(path.join(mentionsDir, file), 'utf-8').split('\n').filter(Boolean)
      for (const line of lines) {
        try { mentions.push(JSON.parse(line)) } catch { /* skip a malformed line */ }
      }
    }

    mentions = mentions.filter((m) => new Date(m.ts).getTime() >= cutoff.getTime())
    mentions.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    mentions = mentions.slice(0, limit)

    res.json({ mentions, count: mentions.length, source: 'local-file' })
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
}

function httpGet (port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }) }
        catch { resolve({ status: res.statusCode, body: data }) }
      })
    }).on('error', reject)
  })
}

describe('GET /api/imessage/mentions (#182121)', () => {
  let scratch, server, port

  beforeEach(async () => {
    scratch = withScratchHome()
    const app = express()
    app.get('/api/imessage/mentions', mentionsRoute)
    server = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    port = server.address().port
  })

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
    scratch.restore()
  })

  it('returns an empty result when no mentions directory exists yet', async () => {
    const res = await httpGet(port, '/api/imessage/mentions')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { mentions: [], count: 0, source: 'local-file' })
  })

  it('returns recent mentions sorted newest first', async () => {
    const today = new Date().toISOString().slice(0, 10)
    writeMentionFile(today, [
      { ts: new Date(Date.now() - 60000).toISOString(), sender: 'a', text: 'older' },
      { ts: new Date().toISOString(), sender: 'b', text: 'newer' },
    ])

    const res = await httpGet(port, '/api/imessage/mentions')
    assert.equal(res.status, 200)
    assert.equal(res.body.count, 2)
    assert.equal(res.body.mentions[0].text, 'newer')
    assert.equal(res.body.mentions[1].text, 'older')
    assert.equal(res.body.source, 'local-file')
  })

  it('respects the days cutoff', async () => {
    writeMentionFile('2020-01-01', [{ ts: '2020-01-01T00:00:00.000Z', sender: 'old', text: 'ancient' }])
    const today = new Date().toISOString().slice(0, 10)
    writeMentionFile(today, [{ ts: new Date().toISOString(), sender: 'new', text: 'recent' }])

    const res = await httpGet(port, '/api/imessage/mentions?days=1')
    assert.equal(res.body.count, 1)
    assert.equal(res.body.mentions[0].text, 'recent')
  })

  it('respects the limit param', async () => {
    const today = new Date().toISOString().slice(0, 10)
    writeMentionFile(today, [
      { ts: new Date(Date.now() - 3000).toISOString(), text: 'one' },
      { ts: new Date(Date.now() - 2000).toISOString(), text: 'two' },
      { ts: new Date(Date.now() - 1000).toISOString(), text: 'three' },
    ])

    const res = await httpGet(port, '/api/imessage/mentions?limit=2')
    assert.equal(res.body.count, 2)
    assert.equal(res.body.mentions[0].text, 'three')
    assert.equal(res.body.mentions[1].text, 'two')
  })

  it('skips a malformed line instead of failing the whole request', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const dir = path.join(os.homedir(), '.iris', 'mentions')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, `${today}.jsonl`),
      `not valid json\n${JSON.stringify({ ts: new Date().toISOString(), text: 'valid one' })}\n`,
    )

    const res = await httpGet(port, '/api/imessage/mentions')
    assert.equal(res.status, 200)
    assert.equal(res.body.count, 1)
    assert.equal(res.body.mentions[0].text, 'valid one')
  })
})
