const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// Regression guard for #184601.
//
// MEASURED 2026-09-11 on a real client's Windows machine during Hive onboarding. Her daemon
// would not stay up. Her agent had to read our shipped source and patch it by hand before
// `iris hive connect` produced a running node.
//
// TWO defects, stacked, and the second is why the first fires on EVERY Windows boot:
//
//   1. ensureChromiumInstalled({background:true}) spawned '/bin/sh' by name. That path does not
//      exist on Windows, so the spawn fails. The try/catch around it looks like protection and
//      is not: spawn reports ENOENT ASYNCHRONOUSLY as an 'error' event on the child, and an
//      unhandled 'error' event on a ChildProcess throws and takes the daemon down. A catch
//      block cannot catch it — only child.on('error', …) can.
//
//   2. browsersCacheDir() branches darwin -> ~/Library/Caches/ms-playwright, else
//      ~/.cache/ms-playwright. Windows keeps browsers in %LOCALAPPDATA%\ms-playwright, so
//      chromiumInstalled() can NEVER return true there. Every boot therefore concludes Chromium
//      is missing and takes the background-install path — i.e. defect 1 is reached every single
//      time, and even once the shell is fixed Windows would re-download ~100MB on every start.
//
// The daemon boots through this: daemon/index.js calls ensureChromiumInstalled({background:true})
// at startup when chromiumInstalled() is false. Browser provisioning is OPTIONAL for the inbox
// path she was actually trying to use, so it must never be fatal.
//
// These are a mix of behavioural assertions (platform stubbed) and source assertions. The
// behavioural ones are preferred; the spawn wiring is asserted on the source because actually
// spawning a background installer in a test would download a browser.

const SRC_PATH = path.join(__dirname, '..', 'lib', 'playwright-setup.js')
const SRC = fs.readFileSync(SRC_PATH, 'utf8')

/** Run fn with process.platform temporarily reported as `plat`. */
function asPlatform (plat, fn) {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: plat, configurable: true })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', orig)
  }
}

describe('#184601 — the browser cache path must know Windows', () => {
  it('does not put the Windows cache under ~/.cache', () => {
    // Fresh require each time so the module re-reads process.platform.
    delete require.cache[require.resolve(SRC_PATH)]
    const dir = asPlatform('win32', () => {
      const mod = require(SRC_PATH)
      return mod.browsersCacheDir ? mod.browsersCacheDir() : null
    })

    if (dir === null) {
      // browsersCacheDir is not exported; fall back to asserting the source has a win32 branch.
      assert.match(
        SRC,
        /win32/,
        'browsersCacheDir must branch on win32 — without it chromiumInstalled() is always false on Windows'
      )
      return
    }

    assert.ok(
      !dir.includes(path.join('.cache', 'ms-playwright')),
      `Windows must not use the POSIX cache dir, got: ${dir}`
    )
    assert.match(
      dir.toLowerCase(),
      /local|appdata/,
      `Windows browsers live under %LOCALAPPDATA%, got: ${dir}`
    )
  })

  it('still resolves the documented POSIX locations', () => {
    delete require.cache[require.resolve(SRC_PATH)]
    const mac = asPlatform('darwin', () => {
      const mod = require(SRC_PATH)
      return mod.browsersCacheDir ? mod.browsersCacheDir() : null
    })
    if (mac === null) return // not exported; covered by the source assertion above
    assert.ok(
      mac.includes(path.join('Library', 'Caches', 'ms-playwright')),
      `darwin must keep its existing path, got: ${mac}`
    )
  })
})

describe('#184601 — a background install must never take the daemon down', () => {
  it('does not spawn a hardcoded POSIX shell', () => {
    assert.doesNotMatch(
      SRC,
      /spawn\(\s*['"]\/bin\/sh['"]/,
      "spawn('/bin/sh', …) does not exist on Windows. Use { shell: true } so the platform picks " +
        'its own shell (cmd.exe on win32, /bin/sh elsewhere).'
    )
  })

  it('attaches an error handler to the spawned child', () => {
    // The failure is asynchronous, so try/catch does not see it. Without an 'error' listener
    // the unhandled event propagates and kills the daemon process.
    assert.match(
      SRC,
      /\.on\(\s*['"]error['"]/,
      "the spawned child needs child.on('error', …) — spawn reports ENOENT asynchronously, so " +
        'the surrounding try/catch cannot catch it and the daemon dies on an optional step'
    )
  })

  it('keeps the install non-blocking (unref) so startup is never held up', () => {
    assert.match(SRC, /\.unref\(\)/, 'the background install must stay detached and unref()d')
  })
})
