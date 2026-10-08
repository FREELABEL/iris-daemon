#!/usr/bin/env node
'use strict'

/**
 * Hive relay stress test — relay, node and visitors in SEPARATE processes, as in production (#188585).
 *
 *   node relay/stress.js [burst sizes...]        default: 100 500 1000
 *
 * Load tests inside the unit suite measured the machine, not the relay (one process, one core, and
 * a shared box under load average 19 → the same test passed and failed minutes apart). This runs the
 * three roles as three processes and reports per burst: success, p50/p95/p99, and — from the relay —
 * routed / pooled / refused-by-reason and RSS. Run it on a quiet machine before trusting the numbers.
 *
 * Measured 2026-10-08 (4 cores, shared, loopback): 200 → 200 ok p50 2.1 s · 500 → 500 ok p50 4.9 s ·
 * 1000 → 1000 ok p50 9.8 s · 2000 → 1032 ok, 968 refused by the 1024 pending guard (by design);
 * relay RSS 165 MB, no leaked sockets. Bottleneck: ~100 new visitor connections/s per node — two TLS
 * handshakes per visitor in one node process. Next lever: multiplex visitors over the control link.
 */

const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const tls = require('tls')
const http = require('http')

const ROOT = path.resolve(__dirname, '..')
const bursts = process.argv.slice(2).map(Number).filter((n) => n > 0)
if (!bursts.length) bursts.push(100, 500, 1000)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-stress-'))
for (const cn of ['relay.t.test', 'demo.t.test']) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', `/CN=${cn}`, '-addext', `subjectAltName=DNS:${cn}`, '-keyout', path.join(dir, cn + '.key'), '-out', path.join(dir, cn + '.crt')], { stdio: 'ignore' })
}
const RELAY_PORT = 20000 + Math.floor(Math.random() * 20000)
const APP_PORT = RELAY_PORT + 1

const relaySrc = `
const fs=require('fs'),{createRelay}=require(${JSON.stringify(ROOT + '/relay/server')})
const REF={}
const r=createRelay({zone:'t.test',relayHost:'relay.t.test',cert:fs.readFileSync(${JSON.stringify(dir + '/relay.t.test.crt')}),key:fs.readFileSync(${JSON.stringify(dir + '/relay.t.test.key')}),secret:'stress',log:(k,w)=>{w=String(w).replace(/[0-9a-f]{32}/,'').slice(0,24);REF[w]=(REF[w]||0)+1}})
r.server.listen(${RELAY_PORT},'127.0.0.1',()=>process.send('up'))
process.on('message',()=>process.send({...r.stats(),rssMB:Math.round(process.memoryUsage().rss/1048576),refusals:REF}))`
const nodeSrc = `
const fs=require('fs'),http=require('http'),{connectTunnel}=require(${JSON.stringify(ROOT + '/relay/client')}),{tokenFor}=require(${JSON.stringify(ROOT + '/relay/server')})
http.createServer((q,s)=>s.end('hi '+q.url)).listen(${APP_PORT},'127.0.0.1',async()=>{
  await connectTunnel({relay:{host:'127.0.0.1',port:${RELAY_PORT}},relayHost:'relay.t.test',relayCa:fs.readFileSync(${JSON.stringify(dir + '/relay.t.test.crt')}),name:'demo',token:tokenFor('stress','demo'),cert:fs.readFileSync(${JSON.stringify(dir + '/demo.t.test.crt')}),key:fs.readFileSync(${JSON.stringify(dir + '/demo.t.test.key')}),target:{host:'127.0.0.1',port:${APP_PORT}},reconnect:true})
  process.send('up')})`

const start = (src) => new Promise((resolve) => {
  const p = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  p.once('message', () => resolve(p))
})
const ask = (p) => new Promise((r) => { p.once('message', r); p.send('stats') })

const ca = fs.readFileSync(path.join(dir, 'demo.t.test.crt'))
const visit = (i) => new Promise((res) => {
  const t0 = Date.now()
  const q = http.request({ path: '/n' + i, createConnection: () => tls.connect({ host: '127.0.0.1', port: RELAY_PORT, servername: 'demo.t.test', ca }) }, (r) => {
    let b = ''
    r.on('data', (d) => { b += d })
    r.on('end', () => res({ ok: b === 'hi /n' + i, ms: Date.now() - t0 }))
  })
  q.on('error', (e) => res({ ok: false, err: e.message.slice(0, 40), ms: Date.now() - t0 }))
  q.setTimeout(60000, () => q.destroy(new Error('timeout')))
  q.end()
})

;(async () => {
  const relay = await start(relaySrc)
  const node = await start(nodeSrc)
  await new Promise((r) => setTimeout(r, 500))
  console.log(`relay :${RELAY_PORT} · node → local :${APP_PORT} · load average ${os.loadavg().map((x) => x.toFixed(1)).join(' ')}`)
  for (const n of bursts) {
    const t0 = Date.now()
    const rs = await Promise.all(Array.from({ length: n }, (_, i) => visit(i)))
    const ms = rs.map((r) => r.ms).sort((a, b) => a - b)
    const q = (f) => ms[Math.min(ms.length - 1, Math.floor(n * f))]
    const errs = {}
    rs.filter((r) => !r.ok).forEach((r) => { errs[r.err || 'wrong body'] = (errs[r.err || 'wrong body'] || 0) + 1 })
    console.log(`${String(n).padStart(5)} at once: ${rs.filter((r) => r.ok).length} ok · wall ${Date.now() - t0} ms · p50 ${q(0.5)} p95 ${q(0.95)} p99 ${q(0.99)} ms ${Object.keys(errs).length ? JSON.stringify(errs) : ''}`)
    await new Promise((r) => setTimeout(r, 1500))
  }
  console.log('relay:', JSON.stringify(await ask(relay)))
  relay.kill(); node.kill()
  fs.rmSync(dir, { recursive: true, force: true })
})()
