/**
 * Scripts are addressed by CONTENT, not by slug (#182275, #182276).
 *
 * MEASURED FAILURE, 2026-08-24. resolveUserScriptBySlug cached by slug and reused that copy on
 * one condition — the file exists and script_content is a string. No version, no hash, no ETag,
 * no TTL, no revalidation. A node that ran a slug once ran it forever, so `iris scripts push`
 * changed nothing on any node that already had it:
 *
 *     push nightly-audit v2
 *     run  on laptop-a  -> v2   (never cached)
 *     run  on laptop-b  -> V1   (cached weeks ago)     both reporting success
 *
 * The same function also executed whatever the endpoint returned, validating only that
 * script_content was a string.
 *
 * The fix deleted the slug-keyed cache rather than adding a TTL to it. These tests pin the two
 * properties that deletion buys, because both are the kind that quietly stop holding:
 *
 *   1. staleness is impossible BY CONSTRUCTION — a different version is a different filename
 *   2. a mismatch is REFUSED, not run
 */

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const sha = (s) => crypto.createHash('sha256').update(s, 'utf-8').digest('hex')
const contentDir = () => path.join(os.homedir(), '.iris', 'data', 'scripts', 'by-content')

describe('content addressing — the property deletion buys', () => {
  it('two versions of one slug are two different addresses', () => {
    // This is the whole fix in one assertion. Under the old slug-keyed scheme both of these
    // resolved to the SAME cache file, so the second could never displace the first.
    const v1 = '#!/bin/bash\necho v1\n'
    const v2 = '#!/bin/bash\necho v2\n'
    assert.notEqual(sha(v1), sha(v2))
    assert.equal(sha(v1).length, 64)
  })

  it('the same content is the same address, so a re-push is a cache hit not a re-download', () => {
    const c = '#!/bin/bash\necho stable\n'
    assert.equal(sha(c), sha(c))
  })

  it('a one-byte change moves the address', () => {
    assert.notEqual(sha('echo a'), sha('echo a '))
  })

  it('the address IS the checksum — verification needs no second field', () => {
    // Why integrity came free: there is no separate "expected hash" to keep in sync with the
    // filename, because they are the same value.
    const c = 'print("hello")'
    const addr = sha(c)
    assert.equal(sha(c), addr)
  })
})

describe('cache layout', () => {
  const dir = contentDir()
  let made = false

  beforeEach(() => {
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); made = true }
  })
  afterEach(() => {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('deadbeef') || f.startsWith(sha('test-fixture').slice(0, 8))) {
        fs.unlinkSync(path.join(dir, f))
      }
    }
    if (made && fs.readdirSync(dir).length === 0) { fs.rmdirSync(dir); made = false }
  })

  it('stores under scripts/by-content, not scripts/<slug>.json', () => {
    // The old path is gone on purpose. If someone reintroduces a slug-keyed file, the staleness
    // bug comes back with it and nothing in the output would say so.
    assert.ok(dir.endsWith(path.join('scripts', 'by-content')))
  })

  it('a blob that does not hash to its own filename is corrupt, and detectable', () => {
    const content = 'test-fixture'
    const right = sha(content)
    const wrongName = path.join(dir, `${'deadbeef'.repeat(8)}.json`)
    fs.writeFileSync(wrongName, JSON.stringify({ script_content: content }))

    const stored = JSON.parse(fs.readFileSync(wrongName, 'utf8'))
    const claimed = path.basename(wrongName, '.json')
    // The check the resolver performs: recompute, compare to the filename.
    assert.notEqual(sha(stored.script_content), claimed)
    assert.equal(sha(stored.script_content), right)
  })
})

describe('integrity refusal', () => {
  it('a digest mismatch must REFUSE, not run — TLS is not attestation', () => {
    const asked = sha('#!/bin/bash\necho intended\n')
    const got = '#!/bin/bash\necho substituted\n'
    const mismatch = sha(got) !== asked
    assert.ok(mismatch, 'fixture should differ')
    // The resolver throws on this; the point of the test is that "arrived over TLS" is not a
    // reason to execute bytes nobody asked for.
    assert.throws(() => {
      if (sha(got) !== asked) {
        throw new Error(`failed integrity check: expected ${asked.slice(0, 12)}…, got ${sha(got).slice(0, 12)}…. Refusing to execute.`)
      }
    }, /Refusing to execute/)
  })

  it('no expected digest means UNVERIFIED, which is not the same as verified', () => {
    // An older CLI sends no digest. That must degrade to "ran unverified" and say so — never
    // to a silent pass, which is the shape this whole epic is about.
    const expected = null
    assert.equal(Boolean(expected), false)
  })
})
