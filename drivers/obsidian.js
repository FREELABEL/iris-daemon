/**
 * Obsidian vault driver — reads a local vault straight off disk.
 *
 * Obsidian is local-first markdown; there is no cloud API and no OAuth, so it can never
 * be a Composio integration. It CAN be a bridge driver, because a vault is just files —
 * the same shape as the iMessage and Apple Mail drivers already here.
 *
 * Read-only by design. A vault is someone's thinking; this indexes it, it does not edit it.
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

/** Directories never worth walking. */
const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules', '.DS_Store', '.smart-env'])

/** Where vaults commonly live. Cheap to probe, and beats making the user hunt for paths. */
function defaultSearchRoots() {
  const home = os.homedir()
  return [
    home,
    path.join(home, 'Documents'),
    path.join(home, 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents'),
    path.join(home, 'Dropbox'),
    path.join(home, 'Google Drive'),
    path.join(home, 'obsidian'),
    path.join(home, 'vaults'),
  ]
}

/** A directory is a vault if it contains a `.obsidian` config folder. */
function isVault(dir) {
  try {
    return fs.statSync(path.join(dir, '.obsidian')).isDirectory()
  } catch {
    return false
  }
}

/**
 * Cached discovery results. Vault locations change approximately never; this ran on EVERY
 * heartbeat (#182371).
 *
 * Captured on the real node by the fs probe:
 *     [BLOCKED 1000ms across 2646 sync fs calls WITHOUT yielding]
 *        899ms 1334x fs.readdirSync   at walk (obsidian.js:55) <- recursive
 *                                     at discoverVaults
 *                                     at heartbeat.getStateCallback   <- every 30s
 *
 * The depth-3 cap was already here and was not the problem. `defaultSearchRoots()` includes
 * the whole home directory plus Dropbox and Google Drive, so on a machine with real
 * cloud-sync trees depth 3 is thousands of directories — and it ran twice a minute forever.
 * While it ran the daemon answered nothing and still showed ONLINE in the fleet.
 */
const VAULT_CACHE_TTL_MS = 60 * 60 * 1000
const vaultCache = new Map() // rootsKey -> { at, vaults }

/** Exported for tests; also the honest way to force a rescan after a vault is created. */
function _resetVaultCache() {
  vaultCache.clear()
}

/**
 * Find vaults under the given roots (or the usual suspects).
 *
 * Shallow on purpose — depth 3 covers real layouts without walking an entire home dir — and
 * now also CACHED and DEADLINED. Caching removes the repeat cost; the deadline bounds the
 * worst single walk, because without it the first heartbeat after every restart still blocks.
 */
function discoverVaults(roots = null, maxDepth = 3, opts = {}) {
  const rootList = roots ?? defaultSearchRoots()
  const key = rootList.join('\u0000')
  const now = Date.now()

  const hit = vaultCache.get(key)
  if (hit && (now - hit.at) < VAULT_CACHE_TTL_MS) return hit.vaults.slice()

  // A wall-clock budget for the whole walk. Exceeding it returns what was found so far
  // rather than continuing — a partial answer that arrives is worth more here than a
  // complete one that stops the daemon answering anything at all.
  const deadlineMs = typeof opts.deadlineMs === 'number' ? opts.deadlineMs : 250
  const startedAt = now
  let ranOut = false

  const found = []
  const seen = new Set()

  const walk = (dir, depth) => {
    if (depth > maxDepth || seen.has(dir)) return
    if (Date.now() - startedAt > deadlineMs) { ranOut = true; return }
    seen.add(dir)

    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return // unreadable (permissions, or a path that does not exist) — not an error
    }

    if (isVault(dir)) {
      found.push(dir)
      return // vaults do not nest; stop descending
    }

    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
      walk(path.join(dir, e.name), depth + 1)
    }
  }

  for (const r of rootList) walk(r, 0)

  if (ranOut) {
    console.warn(`[obsidian] vault scan hit its ${deadlineMs}ms budget after ${seen.size} dirs — returning ${found.length} found so far`)
  }

  // Cached even when partial. A daemon that re-runs an over-budget walk every 30s is the
  // failure being fixed; a stale-but-quick answer is recoverable, a wedged daemon is not.
  vaultCache.set(key, { at: Date.now(), vaults: found.slice() })
  return found
}

/**
 * Parse YAML-ish frontmatter without a YAML dependency.
 * Deliberately conservative: scalars and simple lists only. Anything it cannot parse is
 * left out rather than guessed at — a wrong tag is worse than a missing one.
 */
function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return { frontmatter: {}, body: raw }

  const end = raw.indexOf('\n---', 3)
  if (end === -1) return { frontmatter: {}, body: raw }

  const block = raw.slice(3, end).trim()
  const body = raw.slice(end + 4).replace(/^\n/, '')
  const fm = {}

  let currentKey = null
  for (const line of block.split('\n')) {
    const listItem = line.match(/^\s*-\s+(.*)$/)
    if (listItem && currentKey) {
      if (!Array.isArray(fm[currentKey])) fm[currentKey] = []
      fm[currentKey].push(listItem[1].trim().replace(/^["']|["']$/g, ''))
      continue
    }

    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!kv) continue

    const [, key, rawVal] = kv
    const val = rawVal.trim()
    currentKey = key

    if (val === '') {
      fm[key] = [] // a list probably follows
    } else if (val.startsWith('[') && val.endsWith(']')) {
      fm[key] = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    } else {
      fm[key] = val.replace(/^["']|["']$/g, '')
    }
  }

  return { frontmatter: fm, body }
}

/** [[wikilinks]] are the vault's graph — the most valuable part for contextual memory. */
function extractLinks(body) {
  const out = new Set()
  for (const m of body.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
    out.add(m[1].trim())
  }
  return [...out]
}

/** Inline #tags, plus anything declared in frontmatter. */
function extractTags(body, frontmatter) {
  const out = new Set()
  // Unicode-aware: [A-Za-z0-9_-/] truncated "#tåg" to "t", silently mangling every
  // non-English tag. Obsidian allows unicode in tags, so match letters/marks/numbers by
  // Unicode property instead of ASCII ranges.
  for (const m of body.matchAll(/(?:^|\s)#([\p{L}\p{M}\p{N}_\-/]+)/gu)) out.add(m[1])

  const fmTags = frontmatter.tags ?? frontmatter.tag
  if (Array.isArray(fmTags)) fmTags.forEach((t) => out.add(String(t).replace(/^#/, '')))
  else if (typeof fmTags === 'string') fmTags.split(',').forEach((t) => out.add(t.trim().replace(/^#/, '')))

  return [...out].filter(Boolean)
}

/** Walk every .md file in a vault. */
/**
 * Confine a caller-supplied relative path to the vault.
 *
 * readNote() had this guard; listNotes() did not, so `folder=../../..` walked straight out
 * of the vault. Verified in production: it returned .md files from a DIFFERENT macOS user's
 * home directory (/Users/Treyton/...), reachable from the cloud through bridge-call. Reads
 * of those paths were still blocked, so it leaked directory structure and filenames rather
 * than contents — and it scanned 1000 files in 9.7s, which measurably starved concurrent
 * requests. #178744.
 *
 * Shared by both callers now, because the lesson from that bug is that ONE of two sibling
 * entry points having the check is the same as neither having it.
 */
function resolveInsideVault(vaultPath, relPath) {
  if (path.isAbsolute(relPath)) {
    throw new Error('Path escapes the vault')
  }
  const base = path.resolve(vaultPath)
  const resolved = path.resolve(path.join(base, relPath))
  // Allow the vault root itself, and anything genuinely beneath it.
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error('Path escapes the vault')
  }

  return resolved
}

/**
 * @param {number} limit  clamped to [1, 5000]. A negative limit used to return one
 *   arbitrary note and a zero limit one result — silently answering a caller's bug with
 *   plausible-looking data, which is worse for pagination code than an error (#178751).
 */
function listNotes(vaultPath, { limit = 1000, folder = null } = {}) {
  const notes = []
  limit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(5000, Math.floor(Number(limit)))) : 1000
  const root = folder ? resolveInsideVault(vaultPath, folder) : path.resolve(vaultPath)

  const walk = (dir) => {
    if (notes.length >= limit) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const e of entries) {
      if (notes.length >= limit) return
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue

      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(full)
      } else if (e.name.endsWith('.md')) {
        let st
        try {
          st = fs.statSync(full)
        } catch {
          continue
        }
        const rel = path.relative(vaultPath, full)
        notes.push({
          path: rel,
          name: e.name.replace(/\.md$/, ''),
          folder: path.dirname(rel) === '.' ? '' : path.dirname(rel),
          size: st.size,
          modified: st.mtime.toISOString(),
        })
      }
    }
  }

  walk(root)
  return notes
}

/** Read one note, fully parsed. */
function readNote(vaultPath, relPath, { maxBody = 200000 } = {}) {
  // relPath arrives over HTTP, so treat it as hostile.
  //
  // Reject absolute paths explicitly. path.join('/vault', '/etc/passwd') happens to
  // yield '/vault/etc/passwd' — contained, but only by accident of how join treats a
  // leading slash. Relying on that is one refactor away from a traversal bug, and the
  // resulting ENOENT also leaked the absolute vault path back to the caller.
  const resolved = resolveInsideVault(vaultPath, relPath)

  let raw
  try {
    raw = fs.readFileSync(resolved, 'utf-8')
  } catch (e) {
    // Never echo absolute filesystem paths back over HTTP — but DO say what went wrong.
    //
    // This used to collapse every non-ENOENT failure into "Could not read note: X", which
    // names the file and nothing else. Caught by the all-providers suite on a real
    // transient: a note that listNotes had just returned failed to read, and the message
    // gave the reader nothing to act on. Vaults commonly live in iCloud or Google Drive,
    // where a listed file can be dataless and fail to materialise, so "it is there but I
    // could not read it right now" is a COMMON case that deserves its own words.
    if (e.code === 'ENOENT') throw new Error(`Note not found: ${relPath}`)
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      throw new Error(`No permission to read note: ${relPath} — check Full Disk Access`)
    }
    if (e.code === 'EISDIR') throw new Error(`Not a file: ${relPath}`)
    // EIO / ENOTCONN / EDEADLK are what a stalled cloud-storage download looks like.
    throw new Error(
      `Could not read note: ${relPath} (${e.code || 'unknown error'}) — ` +
      'if this vault syncs via iCloud or Google Drive the file may not be downloaded yet',
    )
  }
  const { frontmatter, body } = parseFrontmatter(raw)
  const st = fs.statSync(resolved)

  return {
    path: relPath,
    name: path.basename(relPath, '.md'),
    folder: path.dirname(relPath) === '.' ? '' : path.dirname(relPath),
    frontmatter,
    body: body.length > maxBody ? body.slice(0, maxBody) : body,
    truncated: body.length > maxBody,
    links: extractLinks(body),
    tags: extractTags(body, frontmatter),
    size: st.size,
    modified: st.mtime.toISOString(),
  }
}

/** Substring search across note names and bodies. */
function searchNotes(vaultPath, query, { limit = 50, includeBody = false } = {}) {
  const needle = String(query || '').toLowerCase()
  if (!needle) return []
  // Clamp: limit=0 returned one result and limit=-1 returned one note, so a caller bug
  // came back as plausible data instead of an error (#178751).
  limit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(500, Math.floor(Number(limit)))) : 50

  const results = []
  for (const note of listNotes(vaultPath, { limit: 5000 })) {
    if (results.length >= limit) break

    const nameHit = note.name.toLowerCase().includes(needle)
    let bodyHit = false
    let snippet = null

    if (!nameHit || includeBody) {
      try {
        const raw = fs.readFileSync(path.join(vaultPath, note.path), 'utf-8')
        const idx = raw.toLowerCase().indexOf(needle)
        if (idx !== -1) {
          bodyHit = true
          snippet = raw.slice(Math.max(0, idx - 80), idx + 160).replace(/\s+/g, ' ').trim()
        }
      } catch {
        continue
      }
    }

    if (nameHit || bodyHit) results.push({ ...note, snippet, matched: nameHit ? 'name' : 'body' })
  }

  return results
}

module.exports = {
  _resetVaultCache, discoverVaults, isVault, listNotes, readNote, searchNotes, parseFrontmatter, extractLinks, extractTags, resolveInsideVault }
