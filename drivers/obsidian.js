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
 * Find vaults under the given roots (or the usual suspects).
 * Shallow on purpose — depth 3 covers real layouts without walking an entire home dir.
 */
function discoverVaults(roots = null, maxDepth = 3) {
  const found = []
  const seen = new Set()

  const walk = (dir, depth) => {
    if (depth > maxDepth || seen.has(dir)) return
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

  for (const r of roots ?? defaultSearchRoots()) walk(r, 0)
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
function listNotes(vaultPath, { limit = 1000, folder = null } = {}) {
  const notes = []
  const root = folder ? path.join(vaultPath, folder) : vaultPath

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
  if (path.isAbsolute(relPath)) {
    throw new Error('Path escapes the vault')
  }

  const resolved = path.resolve(path.join(vaultPath, relPath))
  if (!resolved.startsWith(path.resolve(vaultPath) + path.sep)) {
    throw new Error('Path escapes the vault')
  }

  let raw
  try {
    raw = fs.readFileSync(resolved, 'utf-8')
  } catch (e) {
    // Never echo absolute filesystem paths back over HTTP.
    if (e.code === 'ENOENT') throw new Error(`Note not found: ${relPath}`)
    throw new Error(`Could not read note: ${relPath}`)
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

module.exports = { discoverVaults, isVault, listNotes, readNote, searchNotes, parseFrontmatter, extractLinks, extractTags }
