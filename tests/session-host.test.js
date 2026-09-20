'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { chooseHost, normalizeWorktree } = require('../lib/session-host')

/**
 * WHICH local process can show a human a given session.
 *
 * The epic planned a registry file the TUI would write (`~/.iris/run/<pid>.json`). Measured
 * 2026-09-20 against the shipped CLI (v1.3.283): every session server already answers
 * `GET /project/current` with its worktree, so the file was a cache of a fact the process owns —
 * with a writer, a staleness mode and a fleet rollout attached. Deleted before it was built.
 *
 * What survives is the CHOICE, and the rule that makes it safe: never guess. Telling the wrong
 * process to display a session yanks a human's screen to work they did not ask for.
 */
test('one process serving the session\'s worktree is the host', () => {
    const got = chooseHost([{ port: 4599, worktree: '/Users/a/sites/freelabel' }], '/Users/a/sites/freelabel')
    assert.strictEqual(got.port, 4599)
    assert.strictEqual(got.why, 'worktree')
})

test('the right process is picked out of several', () => {
    const got = chooseHost([
        { port: 4001, worktree: '/Users/a/other' },
        { port: 4002, worktree: '/Users/a/sites/freelabel' },
        { port: 4003, worktree: '/Users/a/third' },
    ], '/Users/a/sites/freelabel')
    assert.strictEqual(got.port, 4002)
})

test('a trailing slash is the same worktree — it is a path, not a string', () => {
    assert.strictEqual(chooseHost([{ port: 7, worktree: '/Users/a/x/' }], '/Users/a/x').port, 7)
    assert.strictEqual(chooseHost([{ port: 7, worktree: '/Users/a/x' }], '/Users/a/x/').port, 7)
    assert.strictEqual(normalizeWorktree('/Users/a/x/'), normalizeWorktree('/Users/a/x'))
})

test('TWO processes on one worktree refuse rather than pick — a wrong pick hijacks a screen', () => {
    // Two terminals open on the same repo is ordinary. Guessing means someone's TUI jumps to a
    // session they were not looking at, and they cannot tell why.
    const got = chooseHost([
        { port: 4001, worktree: '/Users/a/repo' },
        { port: 4002, worktree: '/Users/a/repo' },
    ], '/Users/a/repo')
    assert.strictEqual(got.port, undefined)
    assert.deepStrictEqual(got.ambiguous, [4001, 4002])
    assert.match(got.error, /two|more than one|ambiguous/i)
})

test('no process serving that worktree says so — never "not found"', () => {
    // The session EXISTS; nothing here can show it to a human. Those are different answers, and
    // conflating them is the failure this whole epic started from.
    const got = chooseHost([{ port: 4001, worktree: '/Users/a/other' }], '/Users/a/repo')
    assert.strictEqual(got.port, undefined)
    assert.match(got.error, /no session server|not open|nothing on this machine/i)
    assert.match(got.error, /\/Users\/a\/repo/, 'names the worktree it looked for')
})

test('nothing listening, and junk input, both refuse by name', () => {
    assert.match(chooseHost([], '/Users/a/repo').error, /no session server|nothing on this machine/i)
    assert.ok(chooseHost(null, '/Users/a/repo').error)
    assert.ok(chooseHost([{ port: 1, worktree: '/x' }], '').error)
    assert.ok(chooseHost([{ port: 1, worktree: '' }], '/x').error)
})

test('a SIBLING directory is not the same project', () => {
    // `/Users/a/repo` and `/Users/a/repo-two` share a prefix and nothing else. A prefix match here
    // sends the message to a different codebase and jumps that person's screen.
    const got = chooseHost([{ port: 4001, worktree: '/Users/a/repo-two' }], '/Users/a/repo')
    assert.strictEqual(got.port, undefined)
    assert.match(got.error, /No session server/i)

    // And the reverse: a nested worktree is its own project, not the parent.
    assert.strictEqual(chooseHost([{ port: 4002, worktree: '/Users/a/repo/sub' }], '/Users/a/repo').port, undefined)
})

test('a matching worktree with no usable port is not a host', () => {
    const got = chooseHost([{ port: undefined, worktree: '/Users/a/repo' }], '/Users/a/repo')
    assert.strictEqual(got.port, undefined)
    assert.ok(got.error)
})

test('an unknown worktree on BOTH sides never matches itself', () => {
    // Two absences are not an agreement. A session with no project and a server that would not say
    // must not resolve to each other.
    // ONE candidate, so the ambiguity branch cannot mask it: an unknown worktree must not match an
    // unknown worktree and hand back a port.
    const got = chooseHost([{ port: 4001, worktree: '' }], '')
    assert.strictEqual(got.port, undefined)
    assert.match(got.error, /does not say which project/i)
    assert.strictEqual(chooseHost([{ port: 4002, worktree: null }], '').port, undefined)
})

test('a candidate that could not be asked is skipped, not treated as a match', () => {
    // probeHosts leaves `worktree: null` when /project/current did not answer.
    const got = chooseHost([
        { port: 4001, worktree: null },
        { port: 4002, worktree: '/Users/a/repo' },
    ], '/Users/a/repo')
    assert.strictEqual(got.port, 4002)
})

/* ── Probing: ask each server what it serves ─────────────────────────────────────────────────── */

const { probeHosts } = require('../lib/session-host')

const fakeFetch = (byPort) => async (url, opts) => {
    const port = Number(new URL(url).port)
    const answer = byPort[port]
    if (answer === 'timeout') { const e = new Error('aborted'); e.name = 'AbortError'; throw e }
    if (answer === 500) return { ok: false, status: 500, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => answer }
}

test('each server is asked what it is serving, and the answers are collected', async () => {
    const got = await probeHosts(fakeFetch({
        4001: { worktree: '/Users/a/one', vcs: 'git' },
        4002: { worktree: '/Users/a/two', vcs: 'git' },
    }), [4001, 4002])
    assert.deepStrictEqual(got, [
        { port: 4001, worktree: '/Users/a/one' },
        { port: 4002, worktree: '/Users/a/two' },
    ])
})

test('a port that does not answer is UNKNOWN, never a match for anything', async () => {
    // A dead or foreign port must not become a candidate by default. `null` loses every
    // comparison in chooseHost; a '' or a guessed path would silently win one.
    const got = await probeHosts(fakeFetch({ 4001: 'timeout', 4002: 500, 4003: { notAProject: true } }), [4001, 4002, 4003])
    assert.deepStrictEqual(got.map((c) => c.worktree), [null, null, null])
    assert.strictEqual(chooseHost(got, '/Users/a/one').port, undefined)
})

test('probing is bounded and parallel — a hung port cannot stall the others', async () => {
    const started = Date.now()
    const got = await probeHosts(fakeFetch({ 4001: 'timeout', 4002: { worktree: '/w' } }), [4001, 4002])
    assert.strictEqual(got.find((c) => c.port === 4002).worktree, '/w')
    assert.ok(Date.now() - started < 2000, 'one bad port must not serialise the sweep')
})

test('nothing listening probes nothing', async () => {
    assert.deepStrictEqual(await probeHosts(fakeFetch({}), []), [])
    assert.deepStrictEqual(await probeHosts(fakeFetch({}), null), [])
})
