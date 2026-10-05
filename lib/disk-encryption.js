'use strict'

/**
 * disk-encryption.js — "is the disk this node keeps patient data on encrypted at rest?"
 *
 * WHY THIS EXISTS. Encrypted vaults (lib/encrypted-vault.js) protect what a PHI task KEEPS. They
 * cannot protect what a robot writes while it RUNS: Playwright, the browser agent and the desktop
 * driver write plaintext screenshots and pages into the task workspace, and only when the task
 * ends does the daemon seal them into the vault. Swap, browser caches and crash dumps are outside
 * our reach entirely. Full-disk encryption is the only control that covers that window, so a PHI
 * task may only run on a node that has it. The node reports it as the `disk_encrypted` capability
 * and the server routes PHI tasks only to nodes that report true (capability routing, #187880).
 *
 * UNKNOWN IS NOT YES. A probe that cannot run (no fdesetup, manage-bde needs elevation, lsblk
 * missing) reports `encrypted: null`, and null is treated as "not encrypted" for PHI — the
 * expensive direction of a mistake here is a stolen laptop full of screenshots.
 */

const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')

const CACHE_MS = 60 * 60 * 1000 // FDE state changes rarely; heartbeat is every 30s.
let cache = null

function run (cmd, args, timeout = 8000) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout }).toString()
}

/** Parse `fdesetup status`. "FileVault is On." / "FileVault is Off." / "Encryption in progress". */
function parseFdesetup (out) {
  if (/FileVault is On/i.test(out)) return true
  if (/FileVault is Off/i.test(out)) return false
  return null
}

/**
 * Parse BitLocker. Accepts either PowerShell `(Get-BitLockerVolume).ProtectionStatus` ("On"/"Off")
 * or `manage-bde -status C:` text ("Protection Status: Protection On").
 */
function parseBitLocker (out) {
  const s = String(out).trim()
  if (/^On$/im.test(s) || /Protection Status:\s*Protection On/i.test(s)) return true
  if (/^Off$/im.test(s) || /Protection Status:\s*Protection Off/i.test(s)) return false
  return null
}

/**
 * Parse `lsblk -s -n -o TYPE <source>` — the device and its ANCESTORS. Any `crypt` layer (LUKS /
 * dm-crypt) below the filesystem holding $HOME means it is encrypted at rest.
 */
function parseLsblkAncestors (out) {
  const types = String(out).split('\n').map(l => l.trim()).filter(Boolean)
  if (!types.length) return null
  return types.includes('crypt')
}

function probe (platform = process.platform) {
  const home = os.homedir()
  try {
    if (platform === 'darwin') {
      return { encrypted: parseFdesetup(run('fdesetup', ['status'])), method: 'filevault' }
    }
    if (platform === 'win32') {
      let out
      try {
        out = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-BitLockerVolume -MountPoint $env:SystemDrive).ProtectionStatus'])
      } catch {
        out = run('manage-bde', ['-status', process.env.SystemDrive || 'C:'])
      }
      return { encrypted: parseBitLocker(out), method: 'bitlocker' }
    }
    if (platform === 'linux') {
      // The filesystem that holds ~/.iris (vaults, task workspaces) is the one that matters.
      const src = run('findmnt', ['-n', '-o', 'SOURCE', '--target', fs.existsSync(home) ? home : '/']).trim().replace(/\[.*\]$/, '')
      if (!src.startsWith('/dev/')) return { encrypted: null, method: 'luks', detail: `home is on ${src || 'an unknown device'}` }
      return { encrypted: parseLsblkAncestors(run('lsblk', ['-s', '-n', '-o', 'TYPE', src])), method: 'luks' }
    }
  } catch (e) {
    return { encrypted: null, method: null, detail: `probe failed: ${String(e.message).split('\n')[0].slice(0, 120)}` }
  }
  return { encrypted: null, method: null, detail: `no probe for ${platform}` }
}

/** Cached report for the heartbeat: { encrypted: true|false|null, method, probed_at }. */
function diskEncryptionReport ({ now = Date.now(), force = false, probeFn = probe } = {}) {
  if (!force && cache && now - cache.at < CACHE_MS) return cache.report
  const r = probeFn()
  const report = { encrypted: r.encrypted === true ? true : r.encrypted === false ? false : null, method: r.method || null, probed_at: new Date(now).toISOString() }
  if (r.detail) report.detail = r.detail
  cache = { at: now, report }
  return report
}

/**
 * The refusal a PHI task gets on a node without full-disk encryption — it must say EXACTLY how to
 * fix it, because the person reading it is usually not the person who wrote the daemon.
 */
function howToEnable (platform = process.platform) {
  if (platform === 'darwin') {
    return 'Turn on FileVault: System Settings > Privacy & Security > FileVault > Turn On (or `sudo fdesetup enable`), let it finish, then restart the daemon. Check with `fdesetup status`.'
  }
  if (platform === 'win32') {
    return 'Turn on BitLocker for the system drive: Settings > Privacy & security > Device encryption (Home) or Control Panel > BitLocker Drive Encryption > Turn on BitLocker (Pro), or in an elevated PowerShell `Enable-BitLocker -MountPoint $env:SystemDrive -EncryptionMethod XtsAes256 -RecoveryPasswordProtector`. Check with `manage-bde -status`.'
  }
  if (platform === 'linux') {
    return 'Put the home directory on a LUKS-encrypted volume: LUKS can only be enabled at install time or by migrating data to a new `cryptsetup luksFormat` volume (most distro installers have an "Encrypt the new installation" option). Check with `lsblk -o NAME,TYPE,MOUNTPOINT` — a `crypt` layer under /home (or /) means it is on.'
  }
  return 'Enable full-disk encryption for the drive that holds the user home directory.'
}

function refusalReason (report, platform = process.platform) {
  const state = report && report.encrypted === false ? 'is OFF' : 'could not be confirmed'
  return `phi_requires_disk_encryption: this node's full-disk encryption ${state}, and PHI tasks only run on encrypted disks (task workspaces hold plaintext screenshots while a robot runs). ${howToEnable(platform)}`
}

function _resetCache () { cache = null }

module.exports = { diskEncryptionReport, probe, parseFdesetup, parseBitLocker, parseLsblkAncestors, howToEnable, refusalReason, _resetCache }
