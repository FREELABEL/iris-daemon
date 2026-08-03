#!/usr/bin/env node
/**
 * Obsidian bridge — end-to-end HTTP test.
 *
 * Boots the real bridge on an isolated port and drives the actual routes. The driver
 * suite passing proves the parsing; it proves nothing about wiring, query-param handling,
 * or status codes — which is where the last few bugs in this session have lived.
 */

const { spawn } = require('child_process')
const path = require('path')
const assert = require('assert')

const PORT = 39217
const BASE = `http://127.0.0.1:${PORT}`

let pass = 0, fail = 0
const failures = []

async function t(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    failures.push({ name, error: e.message })
    console.log(`  ✗ ${name}\n      ${e.message}`)
  }
}

// The bridge authenticates with x-bridge-key. Routes returning 401 without it is
// correct behaviour, not a bug — the test just has to present the token like a real
// client does.
const BRIDGE_KEY = (() => {
  try {
    return require('fs').readFileSync(
      process.env.BRIDGE_TOKEN_PATH || require('path').join(require('os').homedir(), '.iris', 'bridge-token'),
      'utf-8',
    ).trim()
  } catch {
    return ''
  }
})()

const get = async (p) => {
  const res = await fetch(`${BASE}${p}`, { headers: BRIDGE_KEY ? { 'x-bridge-key': BRIDGE_KEY } : {} })
  let body = null
  try { body = await res.json() } catch {}
  return { status: res.status, body }
}

async function waitForBoot(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

;(async () => {
  console.log(`Booting bridge on :${PORT}…`)
  const proc = spawn('node', [path.join(__dirname, '..', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), BRIDGE_PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stderr = ''
  proc.stderr.on('data', (d) => { stderr += d.toString() })

  const up = await waitForBoot()
  if (!up) {
    console.log('  ✗ bridge did not come up')
    console.log(stderr.split('\n').slice(0, 12).join('\n'))
    proc.kill('SIGKILL')
    process.exit(1)
  }
  console.log('  ✓ bridge is up\n')

  try {
    console.log('GET /api/obsidian/vaults')
    let vaultPath = null
    await t('returns 200 with a vaults array', async () => {
      const { status, body } = await get('/api/obsidian/vaults')
      assert.strictEqual(status, 200)
      assert.ok(Array.isArray(body.vaults), 'vaults must be an array')
      assert.strictEqual(body.count, body.vaults.length, 'count must match length')
      if (body.vaults.length) vaultPath = body.vaults[0].path
    })
    await t('each vault has path + name', async () => {
      const { body } = await get('/api/obsidian/vaults')
      for (const v of body.vaults) {
        assert.ok(v.path && v.name, JSON.stringify(v))
      }
    })

    if (!vaultPath) {
      console.log('\n  (no vaults on this machine — skipping vault-scoped route tests)')
    } else {
      const q = encodeURIComponent(vaultPath)
      console.log(`\nGET /api/obsidian/notes   [vault: ${path.basename(vaultPath)}]`)
      let sampleNote = null
      await t('lists notes', async () => {
        const { status, body } = await get(`/api/obsidian/notes?vault=${q}`)
        assert.strictEqual(status, 200)
        assert.ok(Array.isArray(body.notes))
        if (body.notes.length) sampleNote = body.notes[0]
      })
      await t('honours ?limit', async () => {
        const { body } = await get(`/api/obsidian/notes?vault=${q}&limit=2`)
        assert.ok(body.notes.length <= 2, `got ${body.notes.length}`)
      })
      await t('400s without ?vault', async () => {
        assert.strictEqual((await get('/api/obsidian/notes')).status, 400)
      })
      await t('404s for a non-vault path', async () => {
        assert.strictEqual((await get(`/api/obsidian/notes?vault=${encodeURIComponent('/tmp')}`)).status, 404)
      })

      console.log('\nGET /api/obsidian/note')
      await t('reads one note with parsed fields', async () => {
        assert.ok(sampleNote, 'no sample note available')
        const { status, body } = await get(`/api/obsidian/note?vault=${q}&path=${encodeURIComponent(sampleNote.path)}`)
        assert.strictEqual(status, 200)
        assert.strictEqual(typeof body.body, 'string')
        assert.ok(Array.isArray(body.tags) && Array.isArray(body.links))
        assert.ok('frontmatter' in body)
      })
      await t('400s on ../ traversal', async () => {
        const { status, body } = await get(`/api/obsidian/note?vault=${q}&path=${encodeURIComponent('../../../../etc/passwd')}`)
        assert.strictEqual(status, 400)
        assert.match(String(body.error), /escapes the vault/i)
      })
      await t('400s on absolute path', async () => {
        const { status, body } = await get(`/api/obsidian/note?vault=${q}&path=${encodeURIComponent('/etc/passwd')}`)
        assert.strictEqual(status, 400)
        assert.match(String(body.error), /escapes the vault/i)
      })
      await t('does not leak absolute paths in errors', async () => {
        const { body } = await get(`/api/obsidian/note?vault=${q}&path=${encodeURIComponent('definitely-missing-xyz.md')}`)
        assert.ok(!String(body.error).includes(vaultPath), `leaked vault path: ${body.error}`)
      })

      console.log('\nGET /api/obsidian/search')
      await t('searches and returns results', async () => {
        const { status, body } = await get(`/api/obsidian/search?vault=${q}&q=the&limit=5`)
        assert.strictEqual(status, 200)
        assert.ok(Array.isArray(body.results))
        assert.ok(body.results.length <= 5)
      })
      await t('400s without ?q', async () => {
        assert.strictEqual((await get(`/api/obsidian/search?vault=${q}`)).status, 400)
      })
      await t('unmatched query returns empty, not an error', async () => {
        const { status, body } = await get(`/api/obsidian/search?vault=${q}&q=zzz-nope-zzz`)
        assert.strictEqual(status, 200)
        assert.strictEqual(body.results.length, 0)
      })

      console.log('\nConcurrency')
      await t('handles 20 concurrent requests', async () => {
        const rs = await Promise.all(
          Array.from({ length: 20 }, () => get(`/api/obsidian/search?vault=${q}&q=a&limit=3`)),
        )
        assert.ok(rs.every((r) => r.status === 200), 'all should be 200')
      })
    }
  } finally {
    proc.kill('SIGKILL')
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) for (const f of failures) console.log(`  - ${f.name}: ${f.error}`)
  process.exit(fail ? 1 : 0)
})()
