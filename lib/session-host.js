'use strict'

/**
 * WHICH process on this machine can show a human a given session.
 *
 * MEASURED 2026-09-20 against the shipped CLI (v1.3.283): every session server answers
 * `GET /project/current` with `{ worktree, vcs }`, and the OpenAPI surface carries 77 endpoints
 * including `/session/:id/prompt_async`, `/session/:id/abort` and the whole `/tui/*` group.
 *
 * The epic planned a registry file the TUI would write (`~/.iris/run/<pid>.json`) to learn the
 * same fact. It was a CACHE of something the process already owns, and it came with a writer, a
 * staleness failure mode — the design prescribed a liveness checker to compensate, a part to fix
 * a part — and a rollout to every machine before anything worked. Deleted before it was built.
 *
 * What survives is the choice, and the one rule that makes it safe:
 *
 *   NEVER GUESS. Telling the wrong process to display a session yanks a human's screen to work
 *   they did not ask for, with nothing on screen explaining why. Two servers on one worktree is
 *   ordinary (two terminals, one repo), so that case REFUSES and says so.
 *
 * Session storage is shared — every port's `/session` lists every session — so the list is not
 * evidence of who can render one. The worktree is.
 */

/** A worktree is a path, not a string: `/a/b` and `/a/b/` are the same place. */
function normalizeWorktree (v) {
  if (typeof v !== 'string') return ''
  const trimmed = v.trim()
  if (trimmed === '') return ''
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed
}

/**
 * @param  {Array<{port:number, worktree:string|null}>} candidates  local servers, already probed
 * @param  {string} worktree  the session's project directory
 * @return {{port?:number, why?:string, error?:string, ambiguous?:number[]}}
 */
function chooseHost (candidates, worktree) {
  const want = normalizeWorktree(worktree)
  if (want === '') {
    return { error: 'This session does not say which project it belongs to, so no process can be matched to it.' }
  }

  const list = Array.isArray(candidates) ? candidates : []
  // A candidate that could not be asked is UNKNOWN, never a match.
  const matches = list.filter((c) => c && normalizeWorktree(c.worktree) === want && Number.isFinite(c.port))

  if (matches.length === 1) return { port: matches[0].port, why: 'worktree' }

  if (matches.length > 1) {
    const ports = matches.map((c) => c.port).sort((a, b) => a - b)
    return {
      ambiguous: ports,
      error: `Two or more sessions servers are open on ${want} (ports ${ports.join(', ')}). `
        + 'Refusing to pick one — the wrong one would jump somebody\'s screen to a session they were not reading.',
    }
  }

  return {
    error: `No session server on this machine is open on ${want}. `
      + 'The session exists; nothing here can show it to a person right now.',
  }
}

/**
 * Ask every local session server what it is serving.
 *
 * A port that does not answer is `null` — UNKNOWN — never `''` and never a guess: chooseHost
 * compares worktrees, and an empty string would quietly match another unknown.
 *
 * Bounded and parallel: one hung port must not stall the sweep behind it.
 */
async function probeHosts (fetchImpl, ports, opts = {}) {
  const list = Array.isArray(ports) ? ports : []
  const timeoutMs = opts.timeoutMs || 1000

  return Promise.all(list.map(async (port) => {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/project/current`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json' },
      })
      if (!res || !res.ok) return { port, worktree: null }
      const body = await res.json().catch(() => null)
      const worktree = body && typeof body.worktree === 'string' ? body.worktree : null
      return { port, worktree }
    } catch {
      return { port, worktree: null }
    }
  }))
}

module.exports = { chooseHost, normalizeWorktree, probeHosts }
