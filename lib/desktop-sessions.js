'use strict'

/**
 * IRIS Desktop's sessions, for the session listing and history routes (#190648).
 *
 * Desktop runs an engine per signed-in account with XDG_DATA_HOME at ~/.iris/accounts/<id> (the
 * first account ~/.iris/accounts/default, #189477) and keeps its history in SQLite there:
 * <home>/opencode/opencode.db. The opencode routes only read the OLD file layout under
 * ~/.local/share/opencode/storage, so on a Mac measured 2026-10-23 Hive listed 25 opencode sessions,
 * none of them Desktop's, while 15 Desktop sessions active that week were invisible — and could not
 * be found to send to.
 *
 * READ-ONLY, BOUNDED, NEVER THROWS. This runs on every heartbeat: one query for the list (newest N,
 * counts and model by subquery), one for a history. A machine without Desktop, without SQLite
 * support, or with a database it cannot read reports nothing from here and the legacy listing still
 * stands. The same account and file rules as the CLI's `iris desktop sessions` (iris-opencode
 * packages/opencode/src/cli/lib/desktop-sessions.ts).
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

/** Every Desktop data home on this machine. accounts.json holds API keys — only folders are read. */
function desktopDataHomes (home = os.homedir()) {
  const homes = [path.join(home, '.iris', 'accounts', 'default')]
  try {
    const store = JSON.parse(fs.readFileSync(path.join(home, '.iris', 'accounts.json'), 'utf8'))
    for (const a of (store && store.accounts) || []) {
      if (a && typeof a.data_dir === 'string' && a.data_dir && !homes.includes(a.data_dir)) homes.push(a.data_dir)
    }
  } catch { /* no store, or unreadable: the default home still counts */ }
  return homes
}

/** Released Desktop writes opencode.db; preview/dev builds write opencode-<channel>.db beside it. */
function desktopDb (dataHome) {
  const dir = path.join(dataHome, 'opencode')
  const release = path.join(dir, 'opencode.db')
  if (fs.existsSync(release)) return release
  try {
    return fs.readdirSync(dir)
      .filter((f) => /^opencode-[A-Za-z0-9._-]+\.db$/.test(f))
      .map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null
  } catch { return null }
}

/** SQL literal for the sqlite3 CLI fallback, which cannot bind parameters. */
function literal (v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(Math.trunc(v))
  return `'${String(v).replace(/'/g, "''")}'`
}

/**
 * A read-only query function for `dbPath`: node:sqlite where the runtime has it (Node ≥ 22.13),
 * else the sqlite3 CLI (macOS ships it), else null.
 */
function openReader (dbPath) {
  try {
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(dbPath, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 2000')
    return {
      all: (sql, params = []) => db.prepare(sql).all(...params),
      close: () => { try { db.close() } catch {} }
    }
  } catch { /* no node:sqlite here — try the CLI */ }
  try {
    execFileSync('sqlite3', ['-version'], { stdio: 'ignore', timeout: 2000 })
  } catch { return null }
  return {
    all: (sql, params = []) => {
      let i = 0
      const bound = sql.replace(/\?/g, () => literal(params[i++]))
      const out = execFileSync('sqlite3', ['-readonly', '-json', '-cmd', '.timeout 2000', dbPath, bound], {
        encoding: 'utf8', timeout: 5000, maxBuffer: 16 << 20
      })
      return out.trim() ? JSON.parse(out) : []
    },
    close: () => {}
  }
}

const LIST_SQL = `
  SELECT s.id, s.title, s.slug, s.directory, s.parent_id, s.time_created, s.time_updated,
         (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS messages,
         (SELECT json_extract(m.data, '$.providerID') || '/' || json_extract(m.data, '$.modelID')
            FROM message m WHERE m.session_id = s.id AND json_extract(m.data, '$.role') = 'assistant'
           ORDER BY m.time_created DESC LIMIT 1) AS model
    FROM session s WHERE s.time_archived IS NULL
   ORDER BY s.time_updated DESC LIMIT ?`

/**
 * Desktop sessions, newest first, in the shape the opencode listing returns. Never throws.
 * `reader` is injected by tests.
 */
function listDesktopSessions ({ home, limit = 50, reader = openReader, readGitBranch = () => null } = {}) {
  const out = []
  const seen = new Set()
  for (const dataHome of desktopDataHomes(home)) {
    const dbPath = desktopDb(dataHome)
    if (!dbPath) continue
    let r = null
    try {
      r = reader(dbPath)
      if (!r) continue
      for (const row of r.all(LIST_SQL, [limit])) {
        if (!row || !row.id || seen.has(row.id)) continue
        seen.add(row.id)
        out.push({
          session_id: row.id,
          name: row.title || row.slug || 'Desktop session',
          project_path: row.directory || null,
          git_branch: row.directory ? readGitBranch(row.directory) : null,
          model: row.model || null,
          created_at: row.time_created ? new Date(row.time_created).toISOString() : null,
          updated_at: row.time_updated ? new Date(row.time_updated).toISOString() : null,
          message_count: row.messages || 0,
          provider: 'opencode',
          summary: null,
          parent_id: row.parent_id || null,
          source: 'iris_desktop'
        })
      }
    } catch { /* unreadable or locked: this home reports nothing, the rest still do */ } finally {
      if (r) r.close()
    }
  }
  return out.sort((a, b) => Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0)).slice(0, limit)
}

const HISTORY_SQL = `
  SELECT m.id AS mid, json_extract(m.data, '$.role') AS role, m.time_created AS time, p.data AS part
    FROM message m JOIN part p ON p.message_id = m.id
   WHERE m.session_id = ? AND json_extract(p.data, '$.type') IN ('text', 'tool')
     AND COALESCE(json_extract(p.data, '$.synthetic'), 0) = 0
   ORDER BY m.time_created, m.id, p.id`

/**
 * One Desktop session's history in the shape the opencode history route returns, or null when no
 * Desktop database on this machine has it.
 */
function desktopSessionHistory (sessionId, { home, limit = 200, reader = openReader } = {}) {
  for (const dataHome of desktopDataHomes(home)) {
    const dbPath = desktopDb(dataHome)
    if (!dbPath) continue
    let r = null
    try {
      r = reader(dbPath)
      if (!r) continue
      const meta = r.all('SELECT id, directory, time_created, time_updated FROM session WHERE id = ?', [sessionId])[0]
      if (!meta) continue
      const messages = []
      const filesEdited = new Set()
      const commandsRun = []
      const toolCounts = {}
      for (const row of r.all(HISTORY_SQL, [sessionId])) {
        let part
        try { part = JSON.parse(row.part) } catch { continue }
        const role = row.role === 'assistant' ? 'assistant' : 'user'
        const timestamp = row.time ? new Date(row.time).toISOString() : null
        if (part.type === 'text' && part.text) {
          messages.push({ role, type: 'text', text: String(part.text).slice(0, 2000), timestamp })
        } else if (part.type === 'tool') {
          const tool = part.tool || 'unknown'
          const input = (part.state && part.state.input) || {}
          toolCounts[tool] = (toolCounts[tool] || 0) + 1
          const fp = input.filePath || input.file_path || input.path || null
          if (fp && ['edit', 'write', 'patch', 'multiedit'].includes(tool)) filesEdited.add(fp)
          const command = typeof input.command === 'string' ? input.command.slice(0, 200) : null
          if (command && tool === 'bash') commandsRun.push(command)
          messages.push({ role, type: 'tool_use', tool, file_path: fp, command, timestamp })
        }
      }
      const limited = messages.slice(-limit)
      return {
        session_id: sessionId,
        project_path: meta.directory || null,
        created_at: meta.time_created ? new Date(meta.time_created).toISOString() : null,
        updated_at: meta.time_updated ? new Date(meta.time_updated).toISOString() : null,
        source: 'iris_desktop',
        summary: {
          total_messages: limited.filter((m) => m.type === 'text').length,
          user_messages: limited.filter((m) => m.role === 'user' && m.type === 'text').length,
          assistant_messages: limited.filter((m) => m.role === 'assistant' && m.type === 'text').length,
          files_edited: [...filesEdited],
          commands_run: commandsRun.slice(0, 50),
          tools_used: toolCounts
        },
        messages: limited
      }
    } catch { /* this home could not answer — try the next */ } finally {
      if (r) r.close()
    }
  }
  return null
}

/** Legacy rows plus Desktop rows, one per session id (Desktop's wins), newest first, `limit` long. */
function mergeSessions (legacy, desktop, limit) {
  const byId = new Map()
  for (const s of legacy || []) if (s && s.session_id) byId.set(s.session_id, s)
  for (const s of desktop || []) if (s && s.session_id) byId.set(s.session_id, s)
  return [...byId.values()]
    .sort((a, b) => Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0))
    .slice(0, limit)
}

module.exports = { desktopDataHomes, desktopDb, openReader, listDesktopSessions, desktopSessionHistory, mergeSessions, literal }
