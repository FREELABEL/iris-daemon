'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { reconcile, isPublicV4 } = require('../relay/ddns')

/** DDNS for the relay's wildcard record (#188585) — against a fake Cloudflare + fake IP lookups. */

function world ({ ipify = '104.202.243.99', trace = '104.202.243.99', record = '104.202.243.97', records = null } = {}) {
  const patches = []
  const fetchImpl = async (url, init = {}) => {
    const j = (o, status = 200) => new Response(JSON.stringify(o), { status })
    if (url === 'https://api.ipify.org') return ipify === null ? Promise.reject(new Error('down')) : new Response(ipify)
    if (url === 'https://1.1.1.1/cdn-cgi/trace') return trace === null ? Promise.reject(new Error('down')) : new Response(`fl=1\nip=${trace}\nts=1`)
    assert.match(init.headers.authorization, /^Bearer tok$/)
    if (url.includes('/zones?name=')) return j({ success: true, result: [{ id: 'Z' }] })
    if (url.includes('/dns_records?')) return j({ success: true, result: records ?? [{ id: 'R1', content: record }] })
    if (init.method === 'PATCH') { patches.push({ url, body: JSON.parse(init.body) }); return j({ success: true, result: {} }) }
    return j({ success: false, errors: [{ message: 'unexpected' }] }, 400)
  }
  const out = []
  return { patches, run: (o = {}) => reconcile({ token: 'tok', zone: 'heyiris.io', records: ['*.t.heyiris.io'], fetchImpl, log: (l) => out.push(l), ...o }), out }
}

test('the address moved: the record is updated to the new one, content only', async () => {
  const w = world()
  const r = await w.run()
  assert.strictEqual(r.changed, 1)
  assert.deepStrictEqual(w.patches, [{ url: 'https://api.cloudflare.com/client/v4/zones/Z/dns_records/R1', body: { content: '104.202.243.99' } }])
})

test('already current: nothing is written', async () => {
  const w = world({ record: '104.202.243.99' })
  assert.strictEqual((await w.run()).changed, 0)
  assert.strictEqual(w.patches.length, 0)
})

test('--check reports and changes nothing', async () => {
  const w = world()
  await w.run({ check: true })
  assert.strictEqual(w.patches.length, 0)
  assert.match(w.out.join('\n'), /would set 104\.202\.243\.99/)
})

test('the two lookups DISAGREE: no change (one bad answer must not repoint every tunnel)', async () => {
  const w = world({ trace: '203.0.113.9' })
  const r = await w.run()
  assert.match(r.error, /disagree/)
  assert.strictEqual(w.patches.length, 0)
})

test('a lookup is down: no change', async () => {
  const w = world({ trace: null })
  assert.match((await w.run()).error, /lookup failed/)
  assert.strictEqual(w.patches.length, 0)
})

test('a private / CGNAT answer is never published, even when both sources agree', async () => {
  for (const ip of ['192.168.4.22', '10.0.0.5', '100.100.67.48', '127.0.0.1', '172.20.1.1']) {
    const w = world({ ipify: ip, trace: ip })
    assert.match((await w.run()).error, /not a public/, ip)
    assert.strictEqual(w.patches.length, 0, ip)
  }
  assert.strictEqual(isPublicV4('104.202.243.97'), true)
  assert.strictEqual(isPublicV4('not-an-ip'), false)
})

test('a missing record is reported, never created (this keeps a record current; it does not invent one)', async () => {
  const w = world({ records: [] })
  assert.strictEqual((await w.run()).changed, 0)
  assert.match(w.out.join('\n'), /no A record/)
})
