/**
 * TDD test suite for WhatsApp Scanner bug fixes
 *
 * Bug #101840 — Persistent context incompatible with Hive cloud credentials
 * Bug #101841 — Group detection misses some groups, catches some 1:1s
 * Bug #101842 — nameMatch() too aggressive for short names
 *
 * Run: node som/tests/wa-scanner-bugs.test.js
 */

const path = require('path')
const fs = require('fs')
const os = require('os')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${err.message}`)
    failed++
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed')
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'Mismatch'}: expected "${expected}", got "${actual}"`)
  }
}

// ═══════════════════════════════════════════════════════════════
// Bug #101842 — nameMatch() improvements
// ═══════════════════════════════════════════════════════════════

// Current (broken) implementation for reference
function nameMatchBroken(a, b) {
  const na = a.toLowerCase().replace(/[^a-z0-9._]/g, '').trim()
  const nb = b.toLowerCase().replace(/[^a-z0-9._]/g, '').trim()
  if (!na || !nb || na.length < 2 || nb.length < 2) return false
  return na.includes(nb) || nb.includes(na) || na === nb
}

// Fixed implementation — require higher bar for short names
function nameMatchFixed(a, b) {
  const na = a.toLowerCase().replace(/[^a-z0-9._]/g, '').trim()
  const nb = b.toLowerCase().replace(/[^a-z0-9._]/g, '').trim()
  if (!na || !nb || na.length < 2 || nb.length < 2) return false

  // Exact match always wins
  if (na === nb) return true

  // For short names (< 5 chars), require exact match only
  if (na.length < 5 || nb.length < 5) return false

  // For longer names, allow substring match only if the shorter string
  // is at least 40% of the longer string's length (prevents "max" matching "maximus"
  // but allows "richard" to match "richarddelgado" — first name in full name)
  const shorter = na.length <= nb.length ? na : nb
  const longer = na.length > nb.length ? na : nb
  if (shorter.length / longer.length < 0.4) return false

  return longer.includes(shorter)
}

console.log('\n=== Bug #101842: nameMatch() improvements ===')

test('exact match works', () => {
  assert(nameMatchFixed('Richard Delgado', 'Richard Delgado'))
})

test('case-insensitive exact match', () => {
  assert(nameMatchFixed('YUKTA KANDHARI', 'yukta kandhari'))
})

test('short name "Al" does NOT match "Albert"', () => {
  assert(!nameMatchFixed('Al', 'Albert'), 'Al should not match Albert')
})

test('short name "Max" does NOT match "MAX S Shabib"', () => {
  assert(!nameMatchFixed('Max', 'MAX S Shabib'), 'Max should not match MAX S Shabib')
})

test('short name "Sam" does NOT match "Samsung"', () => {
  assert(!nameMatchFixed('Sam', 'Samsung'))
})

test('"Ali" does NOT match "Alice"', () => {
  assert(!nameMatchFixed('Ali', 'Alice'))
})

test('exact short name "Max" matches "Max"', () => {
  assert(nameMatchFixed('Max', 'Max'))
})

test('longer similar names still match', () => {
  assert(nameMatchFixed('Christiaan Cilliers', 'christiaan cilliers'))
})

test('reasonable substring: "richard" in "Richard Delgado"', () => {
  assert(nameMatchFixed('richard', 'Richard Delgado'))
})

test('unreasonable substring: "rich" does NOT match "Richard Delgado"', () => {
  assert(!nameMatchFixed('rich', 'Richard Delgado'))
})

test('BROKEN: old nameMatch allows "Al" to match "Albert"', () => {
  assert(nameMatchBroken('Al', 'Albert'), 'old function should match (proving the bug)')
})

// ═══════════════════════════════════════════════════════════════
// Bug #101841 — Group detection improvements
// ═══════════════════════════════════════════════════════════════

// Simulate the group detection heuristic
function isGroupChat(contactName, lastMessage, hasGroupIcon, hasGroupAvatar) {
  // SVG icon detection (primary signal)
  if (hasGroupIcon || hasGroupAvatar) return true

  // Heuristic: last message starts with "~Name:" (WA group message sender prefix)
  if (lastMessage && /^~[^:]+:/.test(lastMessage)) return true

  // Heuristic: last message mentions "changed the group" / "added you" / "created group"
  if (lastMessage && /(changed the group|added you|created group|left$|joined using)/i.test(lastMessage)) return true

  return false
}

console.log('\n=== Bug #101841: Group detection improvements ===')

test('group icon detected -> is group', () => {
  assert(isGroupChat('CatoDrive Tech Dev', '', true, false))
})

test('group avatar detected -> is group', () => {
  assert(isGroupChat('Some Group', '', false, true))
})

test('~sender prefix in last message -> is group', () => {
  assert(isGroupChat('Developer Channel', '~Mirza S. Baig: Can we please get that', false, false))
})

test('"changed the group description" -> is group', () => {
  assert(isGroupChat('Saddle Pass', 'Carrington Smurl changed the group description. Click to view', false, false))
})

test('"added you" -> is group', () => {
  assert(isGroupChat('New Group', 'John added you', false, false))
})

test('normal 1:1 message NOT detected as group', () => {
  assert(!isGroupChat('Christiaan Cilliers', 'Hello!! Lets do a call at 2 pm pst?', false, false))
})

test('1:1 with <> in name NOT detected as group (no icon, no prefix)', () => {
  assert(!isGroupChat('Kalia<>Mayo', 'Hey what time works?', false, false))
})

test('"joined using" -> is group', () => {
  assert(isGroupChat('Tech Meetup', 'Alex joined using this group invite link', false, false))
})

// ═══════════════════════════════════════════════════════════════
// Bug #101840 — Hive credential portability (session archive)
// ═══════════════════════════════════════════════════════════════

// Test the session resolution logic
function resolveSessionDir(envBrowserSessionFile, envWaSessionDir, waAccount) {
  const input = envBrowserSessionFile || envWaSessionDir
    || path.join(os.homedir(), '.iris', 'whatsapp-sessions', waAccount || 'default')

  // If input is a .tar.gz file, it needs extraction
  if (input.endsWith('.tar.gz') || input.endsWith('.tgz')) {
    return { type: 'archive', archivePath: input, needsExtract: true }
  }

  // If input is a directory, use directly
  try {
    if (fs.existsSync(input) && fs.statSync(input).isDirectory()) {
      return { type: 'directory', sessionDir: input, needsExtract: false }
    }
  } catch {}

  // If input is a JSON file (Hive protocol default), can't use for WA
  if (input.endsWith('.json')) {
    return { type: 'unsupported', error: 'JSON session files not supported for WhatsApp (needs persistent browser profile). Use save-whatsapp-session.spec.ts to create a session directory.' }
  }

  // Directory doesn't exist yet — needs session save
  return { type: 'missing', sessionDir: input, needsExtract: false }
}

console.log('\n=== Bug #101840: Hive credential portability ===')

test('existing directory resolves directly', () => {
  const result = resolveSessionDir(os.tmpdir(), null, 'default')
  assertEqual(result.type, 'directory')
  assert(!result.needsExtract)
})

test('.tar.gz file triggers extraction', () => {
  const result = resolveSessionDir('/tmp/wa-session.tar.gz', null, 'default')
  assertEqual(result.type, 'archive')
  assert(result.needsExtract)
})

test('.tgz file triggers extraction', () => {
  const result = resolveSessionDir('/tmp/wa-session.tgz', null, 'default')
  assertEqual(result.type, 'archive')
})

test('JSON file returns unsupported error', () => {
  const result = resolveSessionDir('/tmp/session-auth.json', null, 'default')
  assertEqual(result.type, 'unsupported')
  assert(result.error.includes('not supported'))
})

test('missing directory detected', () => {
  const result = resolveSessionDir(null, null, 'nonexistent-account-xyz')
  assertEqual(result.type, 'missing')
})

test('WA_SESSION_DIR takes priority over default', () => {
  const result = resolveSessionDir(null, '/custom/wa/sessions/myaccount', 'default')
  assertEqual(result.type, 'missing')
  assertEqual(result.sessionDir, '/custom/wa/sessions/myaccount')
})

test('BROWSER_SESSION_FILE takes priority over WA_SESSION_DIR', () => {
  const result = resolveSessionDir('/hive/workspace/session.tar.gz', '/custom/wa/sessions', 'default')
  assertEqual(result.type, 'archive')
  assertEqual(result.archivePath, '/hive/workspace/session.tar.gz')
})

// ═══════════════════════════════════════════════════════════════
// Phone normalization tests (bonus — validate existing logic)
// ═══════════════════════════════════════════════════════════════

function normalizePhone(phone) {
  const digits = (phone || '').replace(/[^\d]/g, '')
  return digits.length >= 10 ? digits.slice(-10) : digits
}

function phoneMatch(a, b) {
  const na = normalizePhone(a)
  const nb = normalizePhone(b)
  if (!na || !nb || na.length < 7 || nb.length < 7) return false
  return na === nb
}

console.log('\n=== Phone normalization (bonus) ===')

test('+1 (972) 839-5434 normalizes to 9728395434', () => {
  assertEqual(normalizePhone('+1 (972) 839-5434'), '9728395434')
})

test('+19728395434 normalizes to 9728395434', () => {
  assertEqual(normalizePhone('+19728395434'), '9728395434')
})

test('phone match: +1 (972) 839-5434 == 19728395434', () => {
  assert(phoneMatch('+1 (972) 839-5434', '19728395434'))
})

test('phone match: international +44 7723 442982 == 447723442982', () => {
  assert(phoneMatch('+44 7723 442982', '447723442982'))
})

test('short phone (6 digits) does NOT match', () => {
  assert(!phoneMatch('123456', '123456'))
})

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`)
console.log(`  ${passed} passed, ${failed} failed`)
console.log(`${'='.repeat(50)}\n`)

process.exit(failed > 0 ? 1 : 0)
