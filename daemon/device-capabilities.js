/**
 * DeviceCapabilities — which radios and sensors this machine physically has (#187880).
 *
 * Reports COUNTS, not booleans. The cloud owns the rule that turns a count into a routing
 * capability (`bluetooth: true` etc.), so the rule lives in one place and an old daemon cannot
 * disagree with a new cloud about what "has a camera" means.
 *
 * Why this exists: planning a drone flight needed one fact — does any Hive node have Bluetooth?
 * Nothing could say. It took two remote shell probes to learn iris-hive-001 has no adapter at
 * all, and a task that needed one would have been dispatched there and failed inside a library.
 *
 * Three rules the numbers keep:
 *
 *   1. PHYSICAL ONLY in `count`. This Mac lists 4 cameras and 11 audio devices; one camera and
 *      two of those audio devices are hardware. OBS/BlackHole/aggregate devices go in `virtual`.
 *      A virtual camera cannot see a room, so routing on it would be routing on a lie.
 *   2. NULL MEANS UNKNOWN, never 0. A platform we cannot probe reports null, and the cloud
 *      leaves that node's flags alone. 0 means we looked and there is none.
 *   3. NEVER OPEN A DEVICE. Listing comes from system_profiler / sysfs, which enumerate without
 *      opening a capture session — so no macOS camera/microphone permission prompt, ever.
 *
 * Device NAMES are deliberately not reported: they identify people and rooms ("Alex's AirPods").
 *
 * The macOS probe takes ~4s (measured 2026-10-04), so it runs async in the background on an
 * interval and the heartbeat reads the cached result. It must never run inside the heartbeat.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

const REFRESH_MS = 10 * 60 * 1000
const MAC_TIMEOUT_MS = 20 * 1000

// Audio transports that are a real device attached to this machine. Everything else —
// `virtual`, and `unknown`, which is what macOS reports for aggregate/multi-output devices and
// Continuity (an iPhone's mic) — counts as virtual: it is not hardware this node owns.
const PHYSICAL_AUDIO_TRANSPORTS = new Set([
  'builtin', 'usb', 'bluetooth', 'bluetooth_le', 'hdmi', 'displayport',
  'thunderbolt', 'pci', 'firewire', 'avb'
])

const VIRTUAL_NAME = /virtual|extension|loopback|dummy/i

let cached = null
let timer = null
let inFlight = null

/**
 * Pure parser for `system_profiler -json SPAirPortDataType SPBluetoothDataType SPAudioDataType
 * SPCameraDataType`. Exported for tests.
 */
function parseMacProfiler (data) {
  const wifiIfaces = (data.SPAirPortDataType || [])
    .flatMap(x => x.spairport_airport_interfaces || [])
    // awdl0 (AirDrop) and llw0 (low-latency WLAN) are virtual interfaces on the SAME radio.
    // Counting them reported one Wi-Fi card as two.
    .filter(i => /^en\d+$/.test(i._name || ''))

  const btControllers = (data.SPBluetoothDataType || [])
    .map(x => x.controller_properties)
    .filter(Boolean)
  const btPowered = btControllers.length === 0
    ? null
    : btControllers.some(c => c.controller_state === 'attrib_on')

  const audio = { audio_in: { count: 0, virtual: 0 }, audio_out: { count: 0, virtual: 0 } }
  for (const dev of (data.SPAudioDataType || []).flatMap(x => x._items || [])) {
    const transport = String(dev.coreaudio_device_transport || '').replace(/^coreaudio_device_type_/, '')
    const kind = PHYSICAL_AUDIO_TRANSPORTS.has(transport) && !VIRTUAL_NAME.test(dev._name || '')
      ? 'count'
      : 'virtual'
    if (dev.coreaudio_device_input) audio.audio_in[kind]++
    if (dev.coreaudio_device_output) audio.audio_out[kind]++
  }

  const camera = { count: 0, virtual: 0 }
  for (const cam of data.SPCameraDataType || []) {
    // Virtual cameras are camera EXTENSIONS ("OBS Camera Extension") — measured on this Mac.
    const isVirtual = VIRTUAL_NAME.test(cam._name || '') || VIRTUAL_NAME.test(cam['spcamera_model-id'] || '')
    camera[isVirtual ? 'virtual' : 'count']++
  }

  return {
    wifi: { count: wifiIfaces.length },
    bluetooth: { count: btControllers.length, powered: btPowered },
    camera,
    ...audio
  }
}

function listDir (p) {
  try { return fs.readdirSync(p) } catch { return [] }
}

function readText (p) {
  try { return fs.readFileSync(p, 'utf-8').trim() } catch { return null }
}

/**
 * Linux probe from sysfs/procfs. `root` is injectable so tests can point it at a fake tree.
 * An ABSENT /sys/class/bluetooth is a real 0: it means no adapter, or no driver for one —
 * either way nothing on this node can talk Bluetooth (measured on iris-hive-001, 2026-10-03).
 */
function probeLinux (root = '/') {
  const sys = (...p) => path.join(root, 'sys', 'class', ...p)

  const wifi = listDir(sys('net')).filter(iface =>
    fs.existsSync(sys('net', iface, 'wireless')) || fs.existsSync(sys('net', iface, 'phy80211'))
  ).length

  const hcis = listDir(sys('bluetooth')).filter(n => /^hci\d+$/.test(n))
  // rfkill can tell us an adapter is BLOCKED; nothing in sysfs reliably says it is on.
  // So: false when blocked, otherwise unknown — never a guessed true.
  let powered = null
  if (hcis.length > 0) {
    const blocked = listDir(sys('rfkill')).some(r =>
      readText(sys('rfkill', r, 'type')) === 'bluetooth' &&
      (readText(sys('rfkill', r, 'soft')) === '1' || readText(sys('rfkill', r, 'hard')) === '1')
    )
    if (blocked) powered = false
  }

  // One camera exposes several /dev/video nodes (capture + metadata). index 0 is the capture
  // node, so counting those counts cameras rather than device files.
  const camera = { count: 0, virtual: 0 }
  for (const v of listDir(sys('video4linux'))) {
    if ((readText(sys('video4linux', v, 'index')) || '0') !== '0') continue
    camera[VIRTUAL_NAME.test(readText(sys('video4linux', v, 'name')) || '') ? 'virtual' : 'count']++
  }

  // /proc/asound/pcm: "00-00: ALC3234 Analog : ALC3234 Analog : playback 1 : capture 1"
  const audio = { audio_in: { count: 0, virtual: 0 }, audio_out: { count: 0, virtual: 0 } }
  for (const line of (readText(path.join(root, 'proc', 'asound', 'pcm')) || '').split('\n')) {
    if (!line.trim()) continue
    const kind = VIRTUAL_NAME.test(line) ? 'virtual' : 'count'
    if (/capture \d+/.test(line)) audio.audio_in[kind]++
    if (/playback \d+/.test(line)) audio.audio_out[kind]++
  }

  return {
    wifi: { count: wifi },
    bluetooth: { count: hcis.length, powered },
    camera,
    ...audio
  }
}

function probeMac () {
  return new Promise((resolve) => {
    execFile('system_profiler',
      ['-json', 'SPAirPortDataType', 'SPBluetoothDataType', 'SPAudioDataType', 'SPCameraDataType'],
      { timeout: MAC_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null)
        try { resolve(parseMacProfiler(JSON.parse(stdout))) } catch { resolve(null) }
      })
  })
}

/** Probe now. Resolves to a device report, or null when this platform cannot be probed. */
async function detectDevices () {
  const platform = os.platform()
  if (platform === 'darwin') return probeMac()
  if (platform === 'linux') return probeLinux()
  return null // Windows: unknown, not zero — see rule 2.
}

async function refresh () {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const devices = await detectDevices()
      if (devices) cached = { ...devices, probed_at: new Date().toISOString() }
    } catch (e) {
      console.error(`[devices] probe failed: ${e.message}`)
    } finally {
      inFlight = null
    }
    return cached
  })()
  return inFlight
}

/** Start the background probe. Idempotent. */
function startDeviceProbe (intervalMs = REFRESH_MS) {
  if (timer) return
  refresh()
  timer = setInterval(refresh, intervalMs)
  if (timer.unref) timer.unref()
}

function stopDeviceProbe () {
  if (timer) clearInterval(timer)
  timer = null
}

/** The last completed probe, or null if none has finished yet. Cheap — safe in the heartbeat. */
function getDeviceReport () {
  return cached
}

module.exports = {
  parseMacProfiler,
  probeLinux,
  detectDevices,
  refresh,
  startDeviceProbe,
  stopDeviceProbe,
  getDeviceReport
}
