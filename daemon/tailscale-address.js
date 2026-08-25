'use strict'

/**
 * What tailnet address is THIS machine reachable at (#182368).
 *
 * `iris hive fs` resolved a Hive node to an ssh address by matching the Hive registration
 * name against tailnet peer names. Those two names are chosen independently, so for
 * "AlexMaysnow1063" vs "alex-mayo-bisnow" the match failed and the FIRST call dead-ended —
 * telling the operator to pass the IP that they were asking the tool to find.
 *
 * Making the matcher fuzzier is the wrong direction: a fuzzy name match cannot distinguish
 * the right machine from a similarly-named one, and `hive fs push` WRITES FILES onto whatever
 * it picks. On a tailnet carrying other people's laptops that is a data leak dressed as a
 * convenience.
 *
 * So the node reports its own address instead. Ask the machine; do not infer from its name.
 */

const { execFile } = require('child_process')
const { promisify } = require('util')
const pexec = promisify(execFile)

// launchd hands a minimal PATH, so `tailscale` is frequently NOT on it — the same reason
// `command -v tmux` returned false for a tmux that was installed and working.
const CANDIDATES = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/usr/bin/tailscale',
  'tailscale',
]

/**
 * Pick the single usable IPv4 out of `tailscale ip -4` output.
 *
 * Pure and exported so the parsing is pinned by tests rather than trusted — the module it
 * replaces shipped with a docblock claiming it was tested when it had no tests at all.
 *
 * Returns null for anything that is not exactly one CGNAT-range (100.64.0.0/10) address.
 * A blank, an error string, or an unexpected shape must read as "no address", never as one:
 * an empty string dialled as a host turns "the node told us nothing" into "connect to
 * nowhere", which is the absence-vs-value confusion this whole epic keeps tripping over.
 */
function parseTailscaleIp (stdout) {
  if (typeof stdout !== 'string') return null
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  const v4 = lines.filter((l) => /^\d{1,3}(\.\d{1,3}){3}$/.test(l))
  if (v4.length !== 1) return null
  const ip = v4[0]
  const o = ip.split('.').map(Number)
  if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  // Tailscale hands out 100.64.0.0/10. Refusing anything else keeps a LAN or public address
  // from being advertised as a tailnet one.
  if (o[0] !== 100 || o[1] < 64 || o[1] > 127) return null
  return ip
}

/** Best-effort. A machine not on a tailnet simply advertises nothing. */
async function detectTailscaleIp () {
  for (const bin of CANDIDATES) {
    try {
      const { stdout } = await pexec(bin, ['ip', '-4'], { timeout: 5000 })
      const ip = parseTailscaleIp(stdout)
      if (ip) return ip
    } catch {
      // wrong path, not installed, or not logged in — try the next
    }
  }
  return null
}

module.exports = { parseTailscaleIp, detectTailscaleIp, CANDIDATES }
