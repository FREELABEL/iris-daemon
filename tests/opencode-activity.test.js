'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { opencodeActivity, ACTIVITY_WINDOW_MS, MAX_DIRECTORIES } = require('../lib/opencode-activity')

/**
 * "Working right now" from opencode itself, not from a timestamp (epic #185632, step 4b).
 *
 * MEASURED 2026-09-17 on a throwaway `iris serve` in a scratch directory:
 *   - GET /session/status returns ONLY non-idle sessions: {id: {type:"busy"}} or
 *     {id: {type:"retry", ...}}. A finished turn disappears from the map.
 *   - Only the server RUNNING a session reports it — a busy session on :4199 read {} on :4096,
 *     though every server lists the same sessions from shared disk storage. So absence proves
 *     nothing: this can say WORKING, never WAITING.
 *   - The instance is per directory: a busy session in directory B was invisible on the same
 *     server without ?directory=B.
 */

const NOW = Date.parse('2026-09-17T06:00:00Z')
const ago = (ms) => new Date(NOW - ms).toISOString()
const sess = (id, directory, updatedMsAgo) => ({ session_id: id, project_path: directory, updated_at: ago(updatedMsAgo) })

/** A fake fleet: {base: {directory: statusMap}}; records every URL asked. */
function fleet (servers) {
  const asked = []
  const fetchJson = async (url) => {
    asked.push(url)
    const u = new URL(url)
    const base = `${u.protocol}//${u.host}`
    const dir = u.searchParams.get('directory')
    const byDir = servers[base]
    if (byDir === undefined) return null
    if (byDir === 'html') return '<!doctype html>'
    return byDir[dir] ?? {}
  }
  return { fetchJson, asked }
}

test('a busy session is working and a retrying one is retrying — found on whichever server runs it', async () => {
  const { fetchJson } = fleet({
    'http://127.0.0.1:4096': { '/code/a': {} },
    'http://127.0.0.1:4199': { '/code/a': { ses_1: { type: 'busy' } }, '/code/b': { ses_2: { type: 'retry', attempt: 2, message: 'rate limited', next: 5 } } },
  })
  const r = await opencodeActivity({
    sessions: [sess('ses_1', '/code/a', 5000), sess('ses_2', '/code/b', 5000), sess('ses_3', '/code/a', 5000)],
    servers: ['http://127.0.0.1:4096', 'http://127.0.0.1:4199'],
    fetchJson,
    now: NOW,
  })

  assert.deepStrictEqual(r.activity, { ses_1: 'working', ses_2: 'retrying' })
  // ses_3 is absent everywhere — NOT "waiting". Absence is not a measurement.
  assert.ok(!('ses_3' in r.activity))
})

test('status is asked once per server per directory, with the directory passed', async () => {
  const { fetchJson, asked } = fleet({ 'http://s1': {}, 'http://s2': {} })
  await opencodeActivity({
    sessions: [sess('a', '/code/a', 1000), sess('b', '/code/a', 2000), sess('c', '/code/b', 3000)],
    servers: ['http://s1', 'http://s2'],
    fetchJson,
    now: NOW,
  })

  const pairs = asked.map((u) => { const x = new URL(u); return `${x.host}|${x.pathname}|${x.searchParams.get('directory')}` }).sort()
  assert.deepStrictEqual(pairs, ['s1|/session/status|/code/a', 's1|/session/status|/code/b', 's2|/session/status|/code/a', 's2|/session/status|/code/b'])
})

test('directories with special characters are encoded, not spliced', async () => {
  const { fetchJson, asked } = fleet({ 'http://s1': {} })
  await opencodeActivity({ sessions: [sess('a', '/Users/me/My Project & co?x=1', 1000)], servers: ['http://s1'], fetchJson, now: NOW })
  assert.strictEqual(new URL(asked[0]).searchParams.get('directory'), '/Users/me/My Project & co?x=1')
})

test('only recently active directories are asked — asking loads an instance on the server', async () => {
  const { fetchJson, asked } = fleet({ 'http://s1': {} })
  await opencodeActivity({
    sessions: [sess('recent', '/code/recent', ACTIVITY_WINDOW_MS - 1000), sess('old', '/code/old', ACTIVITY_WINDOW_MS + 1000), { session_id: 'undated', project_path: '/code/undated' }],
    servers: ['http://s1'],
    fetchJson,
    now: NOW,
  })
  assert.deepStrictEqual(asked.map((u) => new URL(u).searchParams.get('directory')), ['/code/recent'])
})

test('the number of directories asked is capped, most recent first', async () => {
  const { fetchJson, asked } = fleet({ 'http://s1': {} })
  const sessions = Array.from({ length: MAX_DIRECTORIES + 4 }, (_, i) => sess(`s${i}`, `/code/d${i}`, (i + 1) * 1000))
  const r = await opencodeActivity({ sessions: sessions.reverse(), servers: ['http://s1'], fetchJson, now: NOW })

  const dirs = asked.map((u) => new URL(u).searchParams.get('directory'))
  assert.strictEqual(dirs.length, MAX_DIRECTORIES)
  assert.ok(dirs.includes('/code/d0') && !dirs.includes(`/code/d${MAX_DIRECTORIES}`))
  assert.strictEqual(r.directories, MAX_DIRECTORIES)
})

test('an HTML page, an array, garbage values, or an unreachable server contribute nothing and do not throw', async () => {
  const { fetchJson } = fleet({
    'http://html': 'html',
    'http://garbage': { '/code/a': { ses_1: 'busy', ses_2: { type: 'sleeping' }, ses_3: null, '': { type: 'busy' } } },
  })
  const arrayServer = async (url) => (url.startsWith('http://array') ? [{ type: 'busy' }] : fetchJson(url))
  const r = await opencodeActivity({
    sessions: [sess('ses_1', '/code/a', 1000)],
    servers: ['http://html', 'http://garbage', 'http://array', 'http://down'],
    fetchJson: arrayServer,
    now: NOW,
  })
  assert.deepStrictEqual(r.activity, {})
  // Unreadable answers are ignored, not counted as failures of the call.
  assert.strictEqual(r.errors, 0)
})

test('a null status for a wanted session is skipped without losing the rest of that answer', async () => {
  const fetchJson = async () => ({ ses_null: null, ses_ok: { type: 'busy' } })
  const r = await opencodeActivity({ sessions: [sess('ses_null', '/code/a', 1000), sess('ses_ok', '/code/a', 1000)], servers: ['http://s1'], fetchJson, now: NOW })
  assert.deepStrictEqual(r.activity, { ses_ok: 'working' })
  assert.strictEqual(r.errors, 0)
})

test('malformed session entries are skipped — including an empty id a server might echo back', async () => {
  const fetchJson = async () => ({ '': { type: 'busy' }, ses_1: { type: 'busy' } })
  const r = await opencodeActivity({
    sessions: [null, 'x', { project_path: '/code/a', updated_at: ago(1000) }, { session_id: '', project_path: '/code/a', updated_at: ago(1000) }, sess('ses_1', '/code/a', 1000)],
    servers: ['http://s1'],
    fetchJson,
    now: NOW,
  })
  assert.deepStrictEqual(r.activity, { ses_1: 'working' })
})

test('a directory ranks by its NEWEST session, so an old sibling cannot push it past the cap', async () => {
  const { fetchJson, asked } = fleet({ 'http://s1': {} })
  const sessions = []
  // MAX_DIRECTORIES directories touched 10..(10+MAX)s ago...
  for (let i = 0; i < MAX_DIRECTORIES; i++) sessions.push(sess(`d${i}`, `/code/d${i}`, (10 + i) * 1000))
  // ...and one more directory whose newest session is the freshest of all, listed AFTER an old one.
  sessions.push(sess('hot-new', '/code/hot', 1000))
  sessions.push(sess('hot-old', '/code/hot', 5 * 60 * 60 * 1000))
  await opencodeActivity({ sessions, servers: ['http://s1'], fetchJson, now: NOW })
  assert.ok(asked.map((u) => new URL(u).searchParams.get('directory')).includes('/code/hot'))
})

test('a server base with a trailing slash still asks /session/status', async () => {
  const { asked, fetchJson } = fleet({ 'http://s1': {} })
  await opencodeActivity({ sessions: [sess('a', '/code/a', 1000)], servers: ['http://s1/'], fetchJson, now: NOW })
  assert.strictEqual(new URL(asked[0]).pathname, '/session/status')
})

test('the load bound is small on purpose — each directory asked loads an instance on every server', () => {
  assert.strictEqual(MAX_DIRECTORIES, 6)
  assert.strictEqual(ACTIVITY_WINDOW_MS, 6 * 60 * 60 * 1000)
})

test('a fetch that throws is counted as an error, and the other servers still answer', async () => {
  const fetchJson = async (url) => {
    if (url.startsWith('http://boom')) throw new Error('ECONNREFUSED')
    return { ses_1: { type: 'busy' } }
  }
  const r = await opencodeActivity({ sessions: [sess('ses_1', '/code/a', 1000)], servers: ['http://boom', 'http://ok'], fetchJson, now: NOW })
  assert.deepStrictEqual(r.activity, { ses_1: 'working' })
  assert.strictEqual(r.errors, 1)
  assert.strictEqual(r.servers, 2)
})

test('working beats retrying when two servers disagree about the same session', async () => {
  const { fetchJson } = fleet({
    'http://s1': { '/code/a': { ses_1: { type: 'retry', attempt: 1, message: 'x', next: 1 } } },
    'http://s2': { '/code/a': { ses_1: { type: 'busy' } } },
  })
  for (const servers of [['http://s1', 'http://s2'], ['http://s2', 'http://s1']]) {
    const r = await opencodeActivity({ sessions: [sess('ses_1', '/code/a', 1000)], servers, fetchJson, now: NOW })
    assert.deepStrictEqual(r.activity, { ses_1: 'working' }, servers.join(','))
  }
})

test('only sessions in the given list are reported — another project\'s busy session is not ours to show', async () => {
  const { fetchJson } = fleet({ 'http://s1': { '/code/a': { ses_1: { type: 'busy' }, ses_stranger: { type: 'busy' } } } })
  const r = await opencodeActivity({ sessions: [sess('ses_1', '/code/a', 1000)], servers: ['http://s1'], fetchJson, now: NOW })
  assert.deepStrictEqual(r.activity, { ses_1: 'working' })
})

test('nothing to ask means nothing asked', async () => {
  const { fetchJson, asked } = fleet({ 'http://s1': {} })
  assert.deepStrictEqual(await opencodeActivity({ sessions: [], servers: ['http://s1'], fetchJson, now: NOW }), { activity: {}, servers: 1, directories: 0, errors: 0 })
  assert.deepStrictEqual((await opencodeActivity({ sessions: [sess('a', '/x', 1)], servers: [], fetchJson, now: NOW })).activity, {})
  assert.deepStrictEqual((await opencodeActivity({ sessions: [sess('a', '', 1), sess('b', null, 1)], servers: ['http://s1'], fetchJson, now: NOW })).directories, 0)
  assert.strictEqual(asked.length, 0)
})

test('the whole check fits inside a heartbeat: every call gets a timeout', async () => {
  const seen = []
  const fetchJson = async (url, timeoutMs) => { seen.push(timeoutMs); return {} }
  await opencodeActivity({ sessions: [sess('a', '/code/a', 1000)], servers: ['http://s1', 'http://s2'], fetchJson, now: NOW })
  assert.ok(seen.length === 2 && seen.every((t) => Number.isFinite(t) && t > 0 && t <= 2000), JSON.stringify(seen))
})
