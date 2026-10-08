'use strict'

const test = require('node:test')
const assert = require('node:assert')
const net = require('net')
const tls = require('tls')
const { readClientHello, MAX_HELLO } = require('../relay/sni')

/**
 * The relay routes by the hostname in the TLS ClientHello WITHOUT terminating TLS (#188585 —
 * "relay blind"). This parser reads bytes from the open internet, so it is tested on REAL hellos
 * captured from Node's TLS client, and on the inputs an attacker would send.
 */

/** Capture the first bytes a real TLS client sends for `servername`. */
function captureHello (servername, extra = {}) {
  return new Promise((resolve) => {
    const srv = net.createServer((s) => {
      const chunks = []
      s.on('data', (d) => {
        chunks.push(d)
        const buf = Buffer.concat(chunks)
        if (buf.length >= 5 && buf.length >= 5 + buf.readUInt16BE(3)) { s.destroy(); srv.close(); resolve(buf) }
      })
    })
    srv.listen(0, '127.0.0.1', () => {
      const c = tls.connect({ port: srv.address().port, host: '127.0.0.1', servername, rejectUnauthorized: false, ...extra })
      c.on('error', () => {})
    })
  })
}

test('reads the hostname from a real ClientHello', async () => {
  const hello = await captureHello('demo.t.heyiris.io')
  assert.deepStrictEqual(readClientHello(hello), { status: 'ok', sni: 'demo.t.heyiris.io', alpn: [] })
})

test('reads ALPN too — acme-tls/1 must be routable to the node (cert issuance through the blind relay)', async () => {
  const hello = await captureHello('demo.t.heyiris.io', { ALPNProtocols: ['acme-tls/1'] })
  assert.deepStrictEqual(readClientHello(hello), { status: 'ok', sni: 'demo.t.heyiris.io', alpn: ['acme-tls/1'] })
})

test('hostnames are lower-cased (DNS is case-insensitive; routing must be too)', async () => {
  const hello = await captureHello('DeMo.T.HeyIris.IO')
  assert.strictEqual(readClientHello(hello).sni, 'demo.t.heyiris.io')
})

test('a partial hello asks for more bytes, at every cut point', async () => {
  const hello = await captureHello('demo.t.heyiris.io')
  for (let cut = 0; cut < hello.length; cut++) {
    assert.strictEqual(readClientHello(hello.subarray(0, cut)).status, 'need_more', `cut at ${cut}`)
  }
})

test('no SNI (an IP-address connection) is an answer, not a crash', async () => {
  const hello = await captureHello(undefined)
  assert.deepStrictEqual(readClientHello(hello), { status: 'no_sni', alpn: [] })
})

test('not TLS at all (plain HTTP, garbage) is refused', () => {
  assert.strictEqual(readClientHello(Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n')).status, 'not_tls')
  assert.strictEqual(readClientHello(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05, 0x02, 0, 0, 1, 0])).status, 'not_tls') // not a ClientHello
})

test('a record claiming to be larger than the limit is refused without waiting for it', () => {
  const b = Buffer.from([0x16, 0x03, 0x01, 0xff, 0xff])
  assert.strictEqual(readClientHello(b).status, 'too_big')
  assert.ok(MAX_HELLO <= 16384 + 5)
})

test('hostile lengths inside a complete record never read out of bounds', async () => {
  const hello = await captureHello('demo.t.heyiris.io')
  // Flip every byte in turn: the parser may refuse, but it must never throw.
  for (let i = 5; i < hello.length; i++) {
    const b = Buffer.from(hello)
    b[i] = b[i] ^ 0xff
    assert.doesNotThrow(() => readClientHello(b), `byte ${i}`)
  }
})

test('a hostname with characters DNS does not allow is refused (no routing on garbage)', () => {
  const { buildHello } = require('../relay/sni')
  assert.strictEqual(readClientHello(buildHello('evil host')).status, 'bad_sni')
  assert.strictEqual(readClientHello(buildHello('a'.repeat(300))).status, 'bad_sni')
  assert.strictEqual(readClientHello(buildHello('ok-name.t.heyiris.io')).sni, 'ok-name.t.heyiris.io')
})

test('fuzz: 100k random and mutated inputs never throw, never return an invalid hostname', () => {
  const { buildHello, HOST } = require('../relay/sni')
  const seeds = [buildHello('demo.t.heyiris.io'), buildHello('x.t.heyiris.io')]
  let s = 12345
  const rnd = (n) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n }
  for (let i = 0; i < 100000; i++) {
    let b
    if (i % 2) {
      b = Buffer.from(seeds[i % seeds.length])
      for (let k = 0; k < 1 + rnd(4); k++) b[rnd(b.length)] = rnd(256)
      if (rnd(4) === 0) b = b.subarray(0, rnd(b.length + 1))
    } else {
      b = Buffer.alloc(rnd(80)); for (let k = 0; k < b.length; k++) b[k] = rnd(256)
      if (b.length > 0 && rnd(2)) b[0] = 0x16
    }
    const r = readClientHello(b)
    if (r.status === 'ok') assert.ok(HOST.test(r.sni), `invalid host routed: ${JSON.stringify(r.sni)}`)
  }
})
