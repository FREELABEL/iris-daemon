const test = require('node:test')
const assert = require('node:assert')

const { envelopeBind, openEnvelopeBuffers, ENVELOPE_VERSION } = require('../daemon/task-executor')

/**
 * ihw.v1 — THE DAEMON'S SIDE OF THE CROSS-LANGUAGE CONTRACT (#177946 phase 3).
 *
 * There are THREE implementations of this format:
 *
 *   fl-iris-api   App\Services\Crypto\EnvelopeCrypto   (PHP)
 *   iris-opencode src/cli/lib/envelope.ts              (bundled CLI)
 *   this daemon   daemon/task-executor.js              (plain Node, separate process)
 *
 * They cannot be collapsed: content is sealed before it leaves the sending machine, and the
 * daemon is not the CLI. Three copies of a frozen format is exactly where drift happens — and
 * drift here does NOT throw. Each side keeps working alone; the only symptom is that a recipient
 * cannot open a file, which is indistinguishable from corruption and shows up long after the
 * change that caused it.
 *
 * So the daemon decrypts a wrap produced by PHP and never touched since. A round trip against
 * itself would prove nothing, because it would re-derive with the same drifted code.
 *
 * THE VECTOR BELOW IS FROZEN INPUT. If a change breaks it, the change is a new wire format —
 * new version tag, readers on all three sides. Never edit a vector to make a test pass.
 */

const hex = (s) => Buffer.from(s, 'hex')

// Produced by fl-iris-api's EnvelopeCrypto. Same vector the CLI suite pins.
const V = {
  transfer: 'transfer-0000-1111-2222',
  target: 'recipient:node-7',
  dek: '0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d',
  plaintext: 'the quick brown fox',
  contentNonce: '789e909961451dafe3870c11',
  contentCipher: '4db3fea83211d80aec4351249b2f66858a4852',
  contentTag: '76daa7731b21cdc7ab0f536839f476d6',
  recipPub: 'ca2aa0a1e65e40a9892f08ed3ec67c82aaf9d73d75954266807967ffbf44513f',
  recipSec: 'de9805cd8fcbe6e96c42947f933a32c2067ce13d629635db62da2dbc56abb09c',
  ephPub: 'b970bdc411ec8cd8216078c478f839a8fb100a4c0161f88918b4aacc903dd52b',
  wrapNonce: 'd92c44c63106c48a08033186',
  wrapCipher: 'e4d4a4611e73aa3703945ac06300d4c0291955229b5ded852293c33f5349891a',
  wrapTag: 'c4614a9765221eb368e441e85c4388e3',
}

test('version tag is frozen', () => {
  assert.strictEqual(ENVELOPE_VERSION, 'ihw.v1')
})

test('binding is length-prefixed, not joined', () => {
  // The defect this replaced: with a plain join, a separator inside a value made distinct inputs
  // produce identical bytes, so a wrap for one (transfer, target) pair opened under another.
  const a = envelopeBind('wrap', ['tx-a\x1fnode:7', 'escrow:x'])
  const b = envelopeBind('wrap', ['tx-a', 'node:7\x1fescrow:x'])

  assert.notStrictEqual(a, b, 'colliding contexts must not produce the same binding')
})

test('binding counts BYTES, not UTF-16 code units', () => {
  // PHP's strlen() is bytes. Using String.length here would derive a different key from PHP for
  // any non-ASCII id — invisible to ASCII-only tests, and surfacing only as an unopenable file.
  const id = 'café'
  assert.notStrictEqual(Buffer.byteLength(id, 'utf8'), id.length)
  assert.ok(envelopeBind('content', [id]).includes(`${Buffer.byteLength(id, 'utf8')}\x1f${id}`))
})

test('unwraps a DEK wrapped by PHP', () => {
  // Exercises X25519 raw<->DER handling, the HKDF info string and RFC 5869's empty-salt
  // substitution, and the wrap AAD — all against bytes this daemon did not produce.
  const { dek } = openEnvelopeBuffers({
    ephPublic: hex(V.ephPub),
    wrapNonce: hex(V.wrapNonce),
    wrappedDek: hex(V.wrapCipher),
    wrapTag: hex(V.wrapTag),
    recipientSecret: hex(V.recipSec),
    recipientPublic: hex(V.recipPub),
    envelopeId: V.transfer,
    targetId: V.target,
    sealed: null,
  })

  assert.strictEqual(dek.toString('hex'), V.dek)
})

test('opens content sealed by PHP', () => {
  const { plaintext } = openEnvelopeBuffers({
    ephPublic: hex(V.ephPub),
    wrapNonce: hex(V.wrapNonce),
    wrappedDek: hex(V.wrapCipher),
    wrapTag: hex(V.wrapTag),
    recipientSecret: hex(V.recipSec),
    recipientPublic: hex(V.recipPub),
    envelopeId: V.transfer,
    targetId: V.target,
    contentNonce: hex(V.contentNonce),
    contentTag: hex(V.contentTag),
    sealed: hex(V.contentCipher),
  })

  assert.strictEqual(plaintext.toString('utf8'), V.plaintext)
})

test('refuses a wrap belonging to a different target', () => {
  // Target binding. Escrow is "just another wrap target", so if the target id were not
  // authenticated a recipient wrap could be relabelled as the escrow one and the record of who
  // opened PHI would be a fiction.
  assert.throws(() =>
    openEnvelopeBuffers({
      ephPublic: hex(V.ephPub),
      wrapNonce: hex(V.wrapNonce),
      wrappedDek: hex(V.wrapCipher),
      wrapTag: hex(V.wrapTag),
      recipientSecret: hex(V.recipSec),
      recipientPublic: hex(V.recipPub),
      envelopeId: V.transfer,
      targetId: 'escrow:compliance-officer',
      sealed: null,
    }),
  )
})

test('refuses altered content', () => {
  // AEAD, unlike the legacy CBC path where a flipped bit decrypted to accepted garbage.
  const tampered = hex(V.contentCipher)
  tampered[0] ^= 0x01

  assert.throws(() =>
    openEnvelopeBuffers({
      ephPublic: hex(V.ephPub),
      wrapNonce: hex(V.wrapNonce),
      wrappedDek: hex(V.wrapCipher),
      wrapTag: hex(V.wrapTag),
      recipientSecret: hex(V.recipSec),
      recipientPublic: hex(V.recipPub),
      envelopeId: V.transfer,
      targetId: V.target,
      contentNonce: hex(V.contentNonce),
      contentTag: hex(V.contentTag),
      sealed: tampered,
    }),
  )
})
