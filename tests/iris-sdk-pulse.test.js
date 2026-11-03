// iris.heartbeats / iris.sources / iris.pulse in the script SDK (#189245, epic #189242).
//
// The rules come from @heyiris/pulse-core, vendored as daemon/vendor/pulse-core.cjs. The golden
// replay below is what makes that copy safe: it is the package's own golden fixture, so a vendored
// bundle that drifts from the package fails here instead of quietly disagreeing with the panel.
const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs')

const core = require('../daemon/vendor/pulse-core.cjs')
const IRIS = require('../daemon/iris-sdk')

const fx = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'pulse-core', f), 'utf8'))
const raw = fx('heartbeats.raw.json')
const NOW = Date.parse(raw.capturedAt)

// ── a fake fl-api ────────────────────────────────────────────────────────────

let calls
let realFetch
function serve (opts = {}) {
  calls = []
  const runsOf = new Map(raw.rows.map((r) => [String(r.job.id), r.runs]))
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url)
    calls.push({ method: init.method || 'GET', path: u.pathname + u.search, headers: init.headers || {} })
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status })
    if (u.pathname === '/api/v1/users/193/bloqs/scheduled-jobs') {
      return opts.list ? json({ message: 'Unauthenticated.' }, opts.list) : json({ data: raw.rows.map((r) => r.job) })
    }
    const m = /scheduled-jobs\/(\d+)\/executions$/.exec(u.pathname)
    if (m) return json({ data: runsOf.get(m[1]) || [] })
    return json({ ok: true })
  }
}
const client = () => new IRIS({ apiKey: 'k', apiUrl: 'https://fl.test', userId: 193 })

beforeEach(() => { realFetch = globalThis.fetch })
afterEach(() => { globalThis.fetch = realFetch })

// ── the vendored bundle ──────────────────────────────────────────────────────

describe('vendored @heyiris/pulse-core', () => {
  it('names its version on the first line', () => {
    const head = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'vendor', 'pulse-core.cjs'), 'utf8').split('\n')[0]
    assert.match(head, /^\/\* @heyiris\/pulse-core \d+\.\d+\.\d+ \*\/$/)
  })

  it('reproduces the package golden fixture exactly — same rules as the panel', () => {
    const snap = fx('heartbeats.json')
    const base = Date.parse(snap.capturedAt)
    const got = {
      capturedAt: snap.capturedAt,
      at: [0, 6, 30].map((h) => {
        const now = base + h * 3600000
        return {
          offsetHours: h,
          now: new Date(now).toISOString(),
          rows: snap.heartbeats.map((r) => {
            const w = core.weekOf(r, now)
            return {
              jobId: r.jobId,
              state: core.stateOf(r, now),
              silentSince: core.silentSince(r, now),
              problems: core.problemsOf(r, now).map((p) => p.kind),
              drift: core.cadenceDrift(r),
              nextFireAt: core.nextFireAt(r),
              line: core.lineOf(r, now),
              week: { expected: w.expected.length, beats: w.beats.length, missed: w.missed.length, unknown: w.unknown, outside: w.outside, skips: w.skips.length }
            }
          })
        }
      })
    }
    assert.deepEqual(got, fx('golden.json'))
  })
})

// ── iris.heartbeats ──────────────────────────────────────────────────────────

describe('iris.heartbeats.query', () => {
  it('answers with the panel states, counting every row read', async () => {
    serve()
    const q = await client().heartbeats.query({ now: NOW })
    assert.equal(q.measured, true)
    assert.deepEqual(q.counts, { late: 0, silent: 6, failing: 2, running: 0, ok: 10, paused: 0 })
    assert.equal(q.matches.length, 18)
    assert.ok(calls.every((c) => c.method === 'GET'))
  })

  it('filters by state, since and agent', async () => {
    serve()
    const q = await client().heartbeats.query({ now: NOW, states: ['silent', 'failing'], since: '1d', agents: ['agent'] })
    const names = q.matches.map((m) => m.agentName)
    assert.ok(names.includes('Sales Agent'))
    assert.ok(!names.includes('Oversight Agent'), 'silent since 7 Oct is older than a day')
    assert.ok(q.matches.every((m) => m.state === 'silent' || m.state === 'failing'))
    assert.ok(!('row' in q.matches[0]), 'matches are flat records, not raw rows')
  })

  it('a state that does not exist throws instead of matching nothing', async () => {
    serve()
    await assert.rejects(client().heartbeats.query({ states: ['held'] }), /held.*late, silent, failing, running, ok, paused/)
  })

  it('a list that cannot be read throws, marked not measured — it is never an empty fleet', async () => {
    serve({ list: 401 })
    await assert.rejects(client().heartbeats.query(), (e) => e.measured === false && /Unauthenticated/.test(e.message))
  })
})

// ── read-only ────────────────────────────────────────────────────────────────

describe('iris.readOnly()', () => {
  it('reads, and marks every request read-only for the server', async () => {
    serve()
    await client().readOnly().get('/api/v1/anything')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].headers['X-Iris-Read-Only'], '1')
  })

  it('refuses a write before it leaves the machine', async () => {
    serve()
    const ro = client().readOnly()
    await assert.rejects(ro.post('/api/v1/leads', { name: 'x' }), /read-only.*POST/)
    await assert.rejects(ro.del('/api/v1/leads/1'), /read-only.*DELETE/)
    assert.equal(calls.length, 0)
  })

  it('its resources are read-only too — iris.readOnly().leads.create cannot write', async () => {
    serve()
    await assert.rejects(client().readOnly().leads.create({ name: 'x' }), /read-only/)
    await assert.rejects(client().readOnly().schedule.run(1), /read-only/)
    assert.equal(calls.length, 0)
  })

  it('leaves the original client able to write', async () => {
    serve()
    const iris = client()
    iris.readOnly()
    await iris.post('/api/v1/x', {})
    assert.equal(calls[0].method, 'POST')
  })
})

// ── iris.sources + iris.pulse.run ────────────────────────────────────────────

describe('iris.pulse.run', () => {
  it('walks custom sources and the heartbeats source; every number keeps where it came from', async () => {
    serve()
    const iris = client()
    const linear = iris.sources.custom({ id: 'linear', label: 'Linear', read: async () => ({ hits: 3, items: ['a', 'b', 'c'] }) })
    const res = await iris.pulse.run({ sources: [linear, iris.sources.heartbeats({ states: ['failing'], now: NOW })] })
    assert.equal(res.readOnly, true)
    const [a, b] = res.outcomes
    assert.equal(a.id, 'linear')
    assert.equal(a.output.hits, 3)
    assert.ok(a.provenance.includes('custom · read-only not enforced'))
    assert.equal(b.id, 'heartbeats')
    assert.equal(b.output.hits, 2)
    assert.equal(b.shut, false)
    assert.ok(b.provenance.some((p) => p.includes('/bloqs/scheduled-jobs')))
  })

  it('a source that throws or is unavailable is SHUT with its reason — never 0 — and the route goes on', async () => {
    serve()
    const iris = client()
    const boom = iris.sources.custom({ id: 'boom', read: async () => { throw new Error('token expired') } })
    const off = iris.sources.custom({ id: 'off', read: async () => 1, isAvailable: () => ({ ok: false, reason: 'no Slack connected' }) })
    const ok = iris.sources.custom({ id: 'ok', read: async () => 5 })
    const res = await iris.pulse.run({ sources: [boom, off, ok] })
    assert.deepEqual(res.outcomes.map((o) => o.shut), [true, true, false])
    assert.match(res.outcomes[0].reason, /token expired/)
    assert.equal(res.outcomes[1].reason, 'no Slack connected')
    assert.equal(res.outcomes[2].output.hits, 5)
    assert.deepEqual(res.lines, ['boom: shut — boom failed: token expired', 'off: shut — no Slack connected', 'ok: 5'])
  })

  it('a custom source is handed a read-only client: its writes are refused, and say so', async () => {
    serve()
    const iris = client()
    const sneaky = iris.sources.custom({ id: 'sneaky', read: async (_q, ctx) => { await ctx.iris.post('/api/v1/leads', {}); return 1 } })
    const res = await iris.pulse.run({ sources: [sneaky] })
    assert.equal(res.outcomes[0].shut, true)
    assert.match(res.outcomes[0].reason, /read-only/)
    assert.equal(calls.filter((c) => c.method !== 'GET').length, 0)
  })

  it('a floor stays a floor', async () => {
    const iris = client()
    const capped = iris.sources.custom({ id: 'capped', read: async () => ({ hits: 100, floor: true }) })
    const res = await iris.pulse.run({ sources: [capped] })
    assert.equal(res.lines[0], 'capped: 100+')
  })

  it('a custom source needs an id and a read function', () => {
    const iris = client()
    assert.throws(() => iris.sources.custom({ read: async () => 1 }), /id/)
    assert.throws(() => iris.sources.custom({ id: 'x' }), /read/)
  })
})
