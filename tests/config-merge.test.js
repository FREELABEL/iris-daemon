// `iris-daemon register` replaced ~/.iris/config.json with a printf of three keys:
//
//   printf '{"node_api_key":"%s","user_id":%s,"api_url":"..."}\n' ... > "$IRIS_CONFIG"
//
// Three defects in one line (#185145):
//   1. `>` truncates. Every other field is destroyed — on this machine, node_id,
//      which is the node's own identity.
//   2. api_url is hardcoded, so any custom endpoint is silently reverted.
//   3. user_id comes from grepping a .env. Unset writes `"user_id":0` — a
//      valid-looking wrong owner. Non-numeric writes `"user_id":abc`, which is
//      INVALID JSON: the daemon then cannot read its own config at all.
//
// The patch arrives on STDIN, never argv: the node key would otherwise be visible
// in `ps` output on a host other people share.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { mergeConfig } = require('../lib/config-merge')

function tmpConfig (contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-cfg-'))
  const p = path.join(dir, 'config.json')
  if (contents !== undefined) fs.writeFileSync(p, contents, 'utf-8')
  return p
}

test('merging PRESERVES fields the patch does not mention', () => {
  const p = tmpConfig(JSON.stringify({
    node_api_key: 'old', user_id: 193, api_url: 'https://custom.example',
    node_id: 'KEEP-ME', node_api_key_previous: 'older', some_future_field: { a: 1 }
  }))
  mergeConfig(p, { node_api_key: 'new', user_id: 193 })
  const after = JSON.parse(fs.readFileSync(p, 'utf-8'))

  assert.strictEqual(after.node_id, 'KEEP-ME', 'the node identity must survive a re-register')
  assert.strictEqual(after.node_api_key_previous, 'older')
  assert.deepStrictEqual(after.some_future_field, { a: 1 }, 'unknown fields survive too')
  assert.strictEqual(after.api_url, 'https://custom.example',
    'a custom endpoint must NOT be reverted by a field the patch never set')
  assert.strictEqual(after.node_api_key, 'new', 'the patch still applies')
})

test('a patch CAN change a field it explicitly sets', () => {
  // The other direction — "preserve everything" must not mean "ignore the patch".
  const p = tmpConfig(JSON.stringify({ api_url: 'https://old.example', node_id: 'x' }))
  mergeConfig(p, { api_url: 'https://new.example' })
  assert.strictEqual(JSON.parse(fs.readFileSync(p, 'utf-8')).api_url, 'https://new.example')
})

test('user_id must be a positive integer or the write is REFUSED', () => {
  for (const bad of ['abc', '', 0, -1, 1.5, null, {}]) {
    const p = tmpConfig(JSON.stringify({ node_id: 'x' }))
    assert.throws(
      () => mergeConfig(p, { node_api_key: 'k', user_id: bad }),
      /user_id/,
      `user_id ${JSON.stringify(bad)} must be rejected, not written`
    )
    assert.strictEqual(JSON.parse(fs.readFileSync(p, 'utf-8')).node_id, 'x',
      'a refused write must leave the existing file untouched')
    assert.ok(!('node_api_key' in JSON.parse(fs.readFileSync(p, 'utf-8'))),
      'nothing from a refused patch may land')
  }
})

test('a numeric string user_id is accepted and stored as a number', () => {
  // Shell always hands over strings; refusing "193" would make the caller unusable.
  const p = tmpConfig(JSON.stringify({}))
  mergeConfig(p, { user_id: '193' })
  const after = JSON.parse(fs.readFileSync(p, 'utf-8'))
  assert.strictEqual(after.user_id, 193)
  assert.strictEqual(typeof after.user_id, 'number')
})

test('a missing config file is created, not an error', () => {
  const p = tmpConfig(undefined)
  mergeConfig(p, { node_api_key: 'k', user_id: 193 })
  assert.strictEqual(JSON.parse(fs.readFileSync(p, 'utf-8')).node_api_key, 'k')
})

test('a CORRUPT config is backed up, never silently discarded', () => {
  const p = tmpConfig('{ this is not json')
  mergeConfig(p, { node_api_key: 'k', user_id: 193 })

  const after = JSON.parse(fs.readFileSync(p, 'utf-8'))
  assert.strictEqual(after.node_api_key, 'k', 'registration must still be able to recover the node')

  const backups = fs.readdirSync(path.dirname(p)).filter(f => f.includes('corrupt'))
  assert.strictEqual(backups.length, 1, 'the unreadable original must be kept for inspection')
  assert.match(fs.readFileSync(path.join(path.dirname(p), backups[0]), 'utf-8'), /not json/)
})

test('the file is written 0600', () => {
  const p = tmpConfig(JSON.stringify({}))
  fs.chmodSync(p, 0o644)
  mergeConfig(p, { node_api_key: 'k', user_id: 193 })
  assert.strictEqual(fs.statSync(p).mode & 0o777, 0o600,
    'it holds a live node key; a loose mode must be corrected, not inherited')
})

test('no temp file is left behind', () => {
  const p = tmpConfig(JSON.stringify({}))
  mergeConfig(p, { node_api_key: 'k', user_id: 193 })
  const leftovers = fs.readdirSync(path.dirname(p)).filter(f => f !== 'config.json')
  assert.deepStrictEqual(leftovers, [], `atomic write must clean up, found: ${leftovers}`)
})

test('an empty patch is refused — it would be a silent no-op that reports success', () => {
  const p = tmpConfig(JSON.stringify({ node_id: 'x' }))
  assert.throws(() => mergeConfig(p, {}), /empty/i)
})
