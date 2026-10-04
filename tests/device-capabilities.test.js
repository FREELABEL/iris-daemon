/**
 * Device capabilities (#187880) — the probe reports PHYSICAL radios and sensors, counts not
 * guesses, and never a 0 it did not measure.
 *
 * The macOS fixture is the real `system_profiler -json` shape from a MacBook Pro on
 * 2026-10-04, device names replaced. It has 4 cameras and 11 audio devices listed, of which
 * 1 camera and 2 audio devices are hardware — the whole reason `count` excludes virtual ones.
 */

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { parseMacProfiler, probeLinux } = require('../daemon/device-capabilities')

const audio = (name, transport, input, output) => ({
  _name: name,
  coreaudio_device_transport: `coreaudio_device_type_${transport}`,
  ...(input ? { coreaudio_device_input: input } : {}),
  ...(output ? { coreaudio_device_output: output } : {})
})

const MAC = {
  SPAirPortDataType: [{
    spairport_airport_interfaces: [{ _name: 'en0' }, { _name: 'awdl0' }]
  }],
  SPBluetoothDataType: [{
    controller_properties: { controller_state: 'attrib_on', controller_chipset: 'BCM_4387' }
  }],
  SPAudioDataType: [{
    _items: [
      audio('Phone Microphone', 'unknown', 1, 0), // Continuity — not this machine's hardware
      audio('BlackHole 16ch', 'virtual', 16, 16),
      audio('MacBook Pro Microphone', 'builtin', 1, 0),
      audio('MacBook Pro Speakers', 'builtin', 0, 2),
      audio('Immersed', 'virtual', 2, 2),
      audio('Virtual Desktop Mic', 'virtual', 2, 2),
      audio('Virtual Desktop Speakers', 'virtual', 2, 2),
      audio('STREAM INPUT', 'unknown', 17, 16), // aggregate device
      audio('Mic Collection', 'unknown', 17, 16),
      audio('STREAM OUTPUT', 'unknown', 0, 2),
      audio('Multi-Output Device', 'unknown', 0, 2)
    ]
  }],
  SPCameraDataType: [
    { _name: 'OBSBOT Virtual Camera', 'spcamera_model-id': 'OBSBOT Camera Extension' },
    { _name: 'FaceTime HD Camera', 'spcamera_model-id': 'FaceTime HD Camera' },
    { _name: 'OBS Virtual Camera', 'spcamera_model-id': 'OBS Camera Extension' },
    // Continuity Camera has a real model id; it is a physical camera while it is attached.
    { _name: 'Phone Camera', 'spcamera_model-id': 'iPhone17,2' }
  ]
}

test('macOS: awdl0 is the same radio as en0 — one Wi-Fi, not two', () => {
  assert.deepStrictEqual(parseMacProfiler(MAC).wifi, { count: 1 })
})

test('macOS: a powered Bluetooth controller is one radio, powered', () => {
  assert.deepStrictEqual(parseMacProfiler(MAC).bluetooth, { count: 1, powered: true })
})

test('macOS: a Bluetooth controller that is switched off still counts, but says so', () => {
  const off = { ...MAC, SPBluetoothDataType: [{ controller_properties: { controller_state: 'attrib_off' } }] }
  assert.deepStrictEqual(parseMacProfiler(off).bluetooth, { count: 1, powered: false })
})

test('macOS: virtual cameras and camera extensions are not cameras', () => {
  assert.deepStrictEqual(parseMacProfiler(MAC).camera, { count: 2, virtual: 2 })
})

test('macOS: only builtin audio is physical; virtual, aggregate and Continuity are not', () => {
  const r = parseMacProfiler(MAC)
  assert.deepStrictEqual(r.audio_in, { count: 1, virtual: 7 })
  assert.deepStrictEqual(r.audio_out, { count: 1, virtual: 8 })
})

test('macOS: an empty report is zeros, and no Bluetooth controller means powered is unknown', () => {
  const r = parseMacProfiler({})
  assert.deepStrictEqual(r, {
    wifi: { count: 0 },
    bluetooth: { count: 0, powered: null },
    camera: { count: 0, virtual: 0 },
    audio_in: { count: 0, virtual: 0 },
    audio_out: { count: 0, virtual: 0 }
  })
})

test('macOS: no device names leave the machine', () => {
  const json = JSON.stringify(parseMacProfiler(MAC))
  for (const name of ['FaceTime', 'MacBook', 'Phone', 'BlackHole', 'OBS']) {
    assert.ok(!json.includes(name), `report leaked device name "${name}": ${json}`)
  }
})

// ── Linux, from a fake sysfs tree ─────────────────────────────────────────────

function tree (files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devcaps-'))
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel)
    if (content === null) { fs.mkdirSync(p, { recursive: true }); continue }
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  return root
}

test('linux: a desktop with no Bluetooth directory reports 0 Bluetooth (iris-hive-001)', () => {
  const root = tree({
    'sys/class/net/eno1': null,
    'sys/class/net/lo': null,
    'proc/asound/pcm': '00-00: ALC3234 Analog : ALC3234 Analog : playback 1 : capture 1\n03-00: HDMI 0 : HDMI 0 : playback 1\n'
  })
  assert.deepStrictEqual(probeLinux(root), {
    wifi: { count: 0 },
    bluetooth: { count: 0, powered: null },
    camera: { count: 0, virtual: 0 },
    audio_in: { count: 1, virtual: 0 },
    audio_out: { count: 2, virtual: 0 }
  })
})

test('linux: a Pi with Wi-Fi, Bluetooth and a USB camera', () => {
  const root = tree({
    'sys/class/net/wlan0/wireless': null,
    'sys/class/net/eth0': null,
    'sys/class/bluetooth/hci0': null,
    'sys/class/bluetooth/hci0:11': null, // a CONNECTION, not a second adapter
    // One USB camera exposes two nodes; only index 0 is the camera.
    'sys/class/video4linux/video0/index': '0\n',
    'sys/class/video4linux/video0/name': 'USB Camera\n',
    'sys/class/video4linux/video1/index': '1\n',
    'sys/class/video4linux/video1/name': 'USB Camera\n',
    'sys/class/video4linux/video2/index': '0\n',
    'sys/class/video4linux/video2/name': 'Dummy video device (0x0000)\n'
  })
  const r = probeLinux(root)
  assert.deepStrictEqual(r.wifi, { count: 1 })
  // Nothing in sysfs proves an adapter is ON, so powered stays unknown rather than a guessed true.
  assert.deepStrictEqual(r.bluetooth, { count: 1, powered: null })
  assert.deepStrictEqual(r.camera, { count: 1, virtual: 1 })
})

test('linux: an rfkill-blocked Bluetooth adapter is reported as not powered', () => {
  const root = tree({
    'sys/class/bluetooth/hci0': null,
    'sys/class/rfkill/rfkill0/type': 'bluetooth\n',
    'sys/class/rfkill/rfkill0/soft': '1\n',
    'sys/class/rfkill/rfkill0/hard': '0\n'
  })
  assert.deepStrictEqual(probeLinux(root).bluetooth, { count: 1, powered: false })
})

test('linux: snd-aloop loopback audio is virtual', () => {
  const root = tree({
    'proc/asound/pcm': '01-00: Loopback PCM : Loopback PCM : playback 8 : capture 8\n'
  })
  const r = probeLinux(root)
  assert.deepStrictEqual(r.audio_in, { count: 0, virtual: 1 })
  assert.deepStrictEqual(r.audio_out, { count: 0, virtual: 1 })
})
