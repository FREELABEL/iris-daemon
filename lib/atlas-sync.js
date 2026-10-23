// #189972 stage 3 — background two-way sync of Atlas datasets on this machine.
//
// A local copy lives at ~/.iris/atlas/datasets/<slug>/ (made by `iris atlas:datasets pull`). One
// that opted in (`iris atlas:datasets sync <slug> --background on`) is kept in step here by running
// the CLI's own `sync` — pull with a three-way merge, then push with base revisions. The daemon
// does no merging itself: one implementation, not two that drift apart.
//
// Runs one copy at a time, never overlapping, with execFile (async) so the daemon's own HTTP
// server and heartbeat keep running while a sync waits on the network.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

const DEFAULT_ROOT = () => path.join(os.homedir(), '.iris', 'atlas', 'datasets')

function findStores (root = DEFAULT_ROOT()) {
  let names = []
  try { names = fs.readdirSync(root) } catch { return [] }
  const out = []
  for (const name of names.sort()) {
    const dir = path.join(root, name)
    try {
      const state = JSON.parse(fs.readFileSync(path.join(dir, '.iris', 'state.json'), 'utf8'))
      if (state && state.background === true) out.push({ slug: state.slug || name, dir })
    } catch { /* not a store, or never opted in */ }
  }
  return out
}

function findIris () {
  const home = os.homedir()
  for (const p of [path.join(home, '.iris/bin/iris'), '/usr/local/bin/iris', '/usr/bin/iris', path.join(home, '.local/bin/iris')]) {
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch {}
  }
  return null
}

function syncOne (irisBin, { slug, dir }, timeoutMs) {
  return new Promise((resolve) => {
    execFile(irisBin, ['atlas:datasets', 'sync', slug, '--dir', dir, '--json'], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      // Exit 2 = it ran and has something to report (conflicts or refusals). Not a failure.
      const ran = !err || err.code === 2
      let body = null
      try { body = JSON.parse(String(stdout).slice(String(stdout).indexOf('{'))) } catch {}
      if (!ran || !body) {
        const why = String(stderr || (err && err.message) || 'no output').trim().split('\n').slice(-1)[0]
        return resolve({ slug, ok: false, error: why.slice(0, 300) })
      }
      const p = body.pull || {}
      const q = body.push || {}
      resolve({
        slug,
        ok: true,
        pulled: (p.written || 0) + (p.merged || 0) + (p.removed || 0),
        pushed: (q.created || 0) + (q.updated || 0) + (q.deleted || 0),
        conflicts: Object.keys(p.conflicts || {}).length,
        refused: (q.refused || []).length,
      })
    })
  })
}

async function runOnce ({ root = DEFAULT_ROOT(), irisBin = findIris(), timeoutMs = 5 * 60 * 1000 } = {}) {
  const stores = findStores(root)
  const at = new Date().toISOString()
  if (!stores.length) return { at, datasets: [] }
  if (!irisBin) return { at, datasets: [], skipped: 'IRIS CLI not found' }
  const datasets = []
  for (const s of stores) datasets.push(await syncOne(irisBin, s, timeoutMs))
  return { at, datasets }
}

module.exports = { findStores, runOnce, DEFAULT_ROOT }
