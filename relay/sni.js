'use strict'

/**
 * Read the hostname (SNI) and ALPN list from a TLS ClientHello WITHOUT terminating TLS (#188585).
 *
 * The Hive relay is "blind": it routes `<name>.t.<domain>` connections by this hostname and then
 * forwards the encrypted bytes, so it never holds a tunnel's key. That makes this the one piece
 * of the relay that parses untrusted bytes from the internet, so it is written to one rule: every
 * read is bounds-checked against the buffer, and anything unexpected is a refusal, never a throw.
 *
 * ALPN is returned because ACME's TLS-ALPN-01 challenge (`acme-tls/1`) must be routed to the node
 * like any other connection — that is how a node gets its certificate through a relay it does not
 * trust (no DNS API token on any node).
 *
 * Scope: the ClientHello must fit in the first TLS record (every mainstream client does this;
 * 16 KB cap). Statuses: ok · need_more · no_sni · not_tls · too_big · bad_sni.
 */

const MAX_RECORD = 16384
const MAX_HELLO = MAX_RECORD + 5
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/

function readClientHello (buf) {
  if (!Buffer.isBuffer(buf)) return { status: 'not_tls' }
  if (buf.length < 1) return { status: 'need_more' }
  if (buf[0] !== 0x16) return { status: 'not_tls' } // handshake record
  if (buf.length < 5) return { status: 'need_more' }
  if (buf[1] !== 0x03) return { status: 'not_tls' }
  const recLen = buf.readUInt16BE(3)
  if (recLen > MAX_RECORD) return { status: 'too_big' }
  if (buf.length < 5 + recLen) return { status: 'need_more' }

  const end = 5 + recLen
  let p = 5
  const need = (n) => p + n <= end
  if (!need(4) || buf[p] !== 0x01) return { status: 'not_tls' } // ClientHello
  const hsLen = buf.readUIntBE(p + 1, 3)
  p += 4
  if (p + hsLen > end) return { status: 'not_tls' } // spans records — refused, see scope
  const hsEnd = p + hsLen

  const skip = (n) => { if (p + n > hsEnd) return false; p += n; return true }
  const len8 = () => (p + 1 <= hsEnd ? buf[p++] : -1)
  const len16 = () => { if (p + 2 > hsEnd) return -1; const v = buf.readUInt16BE(p); p += 2; return v }

  if (!skip(2 + 32)) return { status: 'not_tls' } // version + random
  let n = len8(); if (n < 0 || !skip(n)) return { status: 'not_tls' } // session id
  n = len16(); if (n < 0 || !skip(n)) return { status: 'not_tls' } // cipher suites
  n = len8(); if (n < 0 || !skip(n)) return { status: 'not_tls' } // compression
  if (p === hsEnd) return { status: 'no_sni', alpn: [] } // no extensions at all
  const extLen = len16()
  if (extLen < 0 || p + extLen > hsEnd) return { status: 'not_tls' }
  const extEnd = p + extLen

  let sni = null
  let badSni = false
  const alpn = []
  while (p + 4 <= extEnd) {
    const type = buf.readUInt16BE(p)
    const len = buf.readUInt16BE(p + 2)
    p += 4
    if (p + len > extEnd) return { status: 'not_tls' }
    const e = p
    const eEnd = p + len
    if (type === 0x0000 && len >= 2) {
      let q = e + 2
      const listEnd = Math.min(eEnd, q + buf.readUInt16BE(e))
      while (q + 3 <= listEnd) {
        const nt = buf[q]; const nl = buf.readUInt16BE(q + 1); q += 3
        if (q + nl > listEnd) break
        if (nt === 0 && sni === null) {
          const name = buf.subarray(q, q + nl).toString('latin1').toLowerCase()
          if (HOST.test(name)) sni = name; else badSni = true
        }
        q += nl
      }
    } else if (type === 0x0010 && len >= 2) {
      let q = e + 2
      const listEnd = Math.min(eEnd, q + buf.readUInt16BE(e))
      while (q + 1 <= listEnd) {
        const pl = buf[q]; q += 1
        if (q + pl > listEnd) break
        alpn.push(buf.subarray(q, q + pl).toString('latin1'))
        q += pl
      }
    }
    p = eEnd
  }
  if (badSni) return { status: 'bad_sni' }
  if (!sni) return { status: 'no_sni', alpn }
  return { status: 'ok', sni, alpn }
}

/** A minimal, syntactically valid ClientHello carrying `host` as SNI — for tests and probes. */
function buildHello (host) {
  const name = Buffer.from(String(host), 'latin1')
  const sniEntry = Buffer.concat([Buffer.from([0x00]), u16(name.length), name])
  const sniExt = Buffer.concat([u16(0x0000), u16(sniEntry.length + 2), u16(sniEntry.length), sniEntry])
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]), Buffer.alloc(32), Buffer.from([0x00]), // version, random, no session id
    u16(2), Buffer.from([0x13, 0x01]), Buffer.from([0x01, 0x00]), // one suite, null compression
    u16(sniExt.length), sniExt
  ])
  const hs = Buffer.concat([Buffer.from([0x01]), u24(body.length), body])
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(hs.length), hs])
}

function u16 (n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b }
function u24 (n) { const b = Buffer.alloc(3); b.writeUIntBE(n, 0, 3); return b }

module.exports = { readClientHello, buildHello, MAX_HELLO, HOST }
