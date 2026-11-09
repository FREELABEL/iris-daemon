'use strict'

/**
 * Keeps this machine's model tunnel up while ~/.iris/inference.json says it is serving (#192752).
 *
 * `iris hive models serve on` starts the relay runner (relay/tunnel.js) detached and walks away.
 * The runner reconnects to the relay by itself, but when the PROCESS dies nothing brought it back,
 * and the machine's models went unreachable until someone noticed (iris-hive-001, twice: started
 * with the system Node 18, which crashes the runner on the first real request).
 *
 * The daemon already runs all the time and already re-reads inference.json every 15 s, so it owns
 * this. It restarts the runner only from what `serve on` recorded after it succeeded:
 *
 *   { "enabled": true, "node": "/home/x/.iris/node20/bin/node",
 *     "tunnel": { "name": "iris-hive-001-ai", "runner": "/home/x/.iris/bridge/relay/tunnel.js", "zones": [...] } }
 *
 * No recorded tunnel → not ours to start (serve on never succeeded, or serve off cleared it). The
 * runner authenticates with this node's own key, which the platform binds to the node's owner — the
 * same account that claimed the name — so no user token is stored anywhere.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const { readSettings } = require('./inference-endpoint')

const MIN_NODE = 20
const BASE_DELAY_MS = 15_000
const MAX_DELAY_MS = 10 * 60_000
// A runner that stayed up this long after a restart counts as healthy again: backoff resets.
const STABLE_MS = 10 * 60_000

/**
 * The restart decision, pure. `alive` is whether the recorded runner process exists.
 * `state` = { failures, lastRestartAt } — consecutive restarts that did not stay up.
 * Returns { action: 'none' | 'wait' | 'restart', reason, retryInMs?, state }.
 */
function decideTunnelRestart ({ settings, alive, now, state = { failures: 0, lastRestartAt: 0 } }) {
  const tunnel = settings && settings.tunnel
  if (!settings || settings.enabled !== true) return { action: 'none', reason: 'not serving', state: { failures: 0, lastRestartAt: 0 } }
  if (!tunnel || typeof tunnel.name !== 'string' || !tunnel.name) return { action: 'none', reason: 'no tunnel recorded by serve on', state }
  if (alive) {
    const stable = state.lastRestartAt && now - state.lastRestartAt >= STABLE_MS
    return { action: 'none', reason: 'running', state: stable ? { failures: 0, lastRestartAt: 0 } : state }
  }
  const delay = backoffMs(state.failures)
  if (state.lastRestartAt && now - state.lastRestartAt < delay) {
    return { action: 'wait', reason: 'backing off', retryInMs: delay - (now - state.lastRestartAt), state }
  }
  return { action: 'restart', reason: 'tunnel process is gone', state: { failures: state.failures + 1, lastRestartAt: now } }
}

/** How long after the last restart before the next one: 0 the first time, then 15 s, 30 s … 10 min. */
function backoffMs (failures) {
  if (!failures) return 0
  return Math.min(BASE_DELAY_MS * 2 ** (failures - 1), MAX_DELAY_MS)
}

/** Major version of a node binary, or null. */
function probeNode (bin) {
  try {
    const r = spawnSync(bin, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 5000 })
    return r.status === 0 ? Number(String(r.stdout).split('.')[0]) : null
  } catch { return null }
}

/** The recorded node if it is new enough, else this daemon's own node if that is. Never Node 18. */
function pickNode (recorded, { probe = probeNode, self = process.execPath } = {}) {
  for (const c of [recorded, self]) if (c && (probe(c) || 0) >= MIN_NODE) return c
  return null
}

const tunnelDir = (home, name) => path.join(home, '.iris', 'tunnels', name)

/** The pid in ~/.iris/tunnels/<name>/tunnel.pid if that process is alive (same check as the CLI). */
function runningPid (home, name) {
  try {
    const pid = Number(fs.readFileSync(path.join(tunnelDir(home, name), 'tunnel.pid'), 'utf8').trim())
    if (!Number.isInteger(pid) || pid <= 1) return null
    process.kill(pid, 0)
    return pid
  } catch { return null }
}

class TunnelKeepAlive {
  constructor ({ home = os.homedir(), getApiBase, getKey, log = (m) => console.log(`[inference] ${m}`), spawnFn = spawn, probe = probeNode, now = () => Date.now() }) {
    Object.assign(this, { home, getApiBase, getKey, log, spawnFn, probe, now })
    this.state = { failures: 0, lastRestartAt: 0 }
  }

  tick () {
    try {
      const s = readSettings(this.home)
      const name = s.tunnel && s.tunnel.name
      const alive = !!(name && runningPid(this.home, name))
      const d = decideTunnelRestart({ settings: s, alive, now: this.now(), state: this.state })
      this.state = d.state
      if (d.action !== 'restart') return d
      const node = pickNode(s.node, { probe: this.probe })
      const runner = [s.tunnel.runner, path.join(this.home, '.iris', 'bridge', 'relay', 'tunnel.js'), path.join(__dirname, '..', 'relay', 'tunnel.js')]
        .find((r) => r && fs.existsSync(r))
      if (!node || !runner) {
        this.log(`tunnel ${name} is down and cannot be restarted: ${!node ? `no Node ${MIN_NODE}+ (recorded: ${s.node || 'none'}) — run: iris hive models serve on` : 'relay runner not found — run: iris bridge install'}`)
        return d
      }
      const pid = this.start({ name, node, runner, port: s.port, zones: s.tunnel.zones })
      this.log(`tunnel ${name} was not running — restarted (pid ${pid}, ${node}, attempt ${this.state.failures}, next no sooner than ${Math.round(backoffMs(this.state.failures) / 1000)}s)`)
      return d
    } catch (err) {
      this.log(`tunnel keep-alive failed: ${err.message}`)
      return null
    }
  }

  start ({ name, node, runner, port, zones }) {
    const dir = tunnelDir(this.home, name)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const out = fs.openSync(path.join(dir, 'tunnel.log'), 'a', 0o600)
    const env = { ...process.env, IRIS_API_BASE: this.getApiBase(), IRIS_API_KEY: this.getKey() }
    if (Array.isArray(zones) && zones.length && !process.env.HIVE_RELAY_ZONES) env.HIVE_RELAY_ZONES = zones.join(',')
    const child = this.spawnFn(node, [runner, '--name', name, '--port', String(port)], { env, detached: true, stdio: ['ignore', out, out] })
    fs.closeSync(out)
    if (child.unref) child.unref()
    fs.writeFileSync(path.join(dir, 'tunnel.pid'), String(child.pid), { mode: 0o600 })
    return child.pid
  }
}

module.exports = { TunnelKeepAlive, decideTunnelRestart, backoffMs, pickNode, runningPid, MIN_NODE, BASE_DELAY_MS, MAX_DELAY_MS, STABLE_MS }
