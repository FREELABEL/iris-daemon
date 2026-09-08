'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { callMcp } = require('../daemon/mcp-client')

/**
 * Every path out of an MCP call must be BOUNDED.
 *
 * A stdio server that never answers is exactly the shape of the 26-hour daemon wedge this
 * codebase already paid for: a blocked call with nothing to time it out, and a node that looks
 * alive while doing nothing. These were the only untested paths in the MCP work — and they were
 * untested because the handshake timeout was a fixed 45-second constant, which is its own
 * lesson: a timeout nobody can exercise is a timeout nobody knows fires.
 *
 * Each stub misbehaves in a different way a real server can. None of these tests takes longer
 * than a couple of seconds.
 */

function stub (body) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stub-')), 's.js')
  fs.writeFileSync(f, body)
  return { command: process.execPath, args: [f] }
}

/** Accepts input, answers nothing, stays alive. The worst case: no error, no answer, no exit. */
const SILENT = stub("process.stdin.resume(); setInterval(()=>{}, 1000)")

/** Completes the handshake, then goes quiet on the actual call. */
const HANDSHAKE_ONLY = stub(`
let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);
if(!l.trim())continue;const m=JSON.parse(l);
if(m.id===1)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{}})+'\\n');}});
setInterval(()=>{},1000)`)

test('a server that never completes initialize is cut off', async () => {
  const t0 = Date.now()
  const r = await callMcp(SILENT, { method: 'tools/list', handshakeMs: 800, timeoutMs: 60000 })
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /did not complete initialize/)
  // and it actually stopped, rather than waiting for the call timeout 60s away
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`)
})

test('a server that handshakes then goes quiet is cut off by the CALL timeout', async () => {
  const t0 = Date.now()
  const r = await callMcp(HANDSHAKE_ONLY, { method: 'tools/list', handshakeMs: 5000, timeoutMs: 1200 })
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /exceeded 1200ms/)
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`)
})

test('a timeout below the 1s floor is clamped, and the message says the EFFECTIVE value', async () => {
  // Asking for 900ms gets 1000ms. The message reports what actually happened rather than what
  // was requested — otherwise the log would claim a bound the code never applied, and someone
  // would tune a number that was being ignored.
  const r = await callMcp(HANDSHAKE_ONLY, { method: 'tools/list', handshakeMs: 5000, timeoutMs: 900 })
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /exceeded 1000ms/)
})

test('a server that EXITS without answering says so, rather than hanging', async () => {
  const r = await callMcp(stub("process.exit(3)"), { method: 'tools/list', handshakeMs: 4000, timeoutMs: 4000 })
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /exited \(code 3\)/)
})

test('a command that does not exist is reported, not thrown', async () => {
  const r = await callMcp({ command: '/nonexistent/mcp-server', args: [] }, { method: 'tools/list', handshakeMs: 2000, timeoutMs: 2000 })
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /could not be launched|could not start/)
})

test('an initialize ERROR is surfaced instead of waiting for a timeout', async () => {
  const s = stub(`
let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);
if(!l.trim())continue;const m=JSON.parse(l);
if(m.id===1)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-1,message:'nope'}})+'\\n');}});
setInterval(()=>{},1000)`)
  const t0 = Date.now()
  const r = await callMcp(s, { method: 'tools/list', handshakeMs: 6000, timeoutMs: 6000 })
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /initialize failed/)
  assert.ok(Date.now() - t0 < 5000)
})

test('non-JSON noise on stdout is skipped, not fatal', async () => {
  // Real servers log to stdout. A parser that died on the first non-JSON line would make a
  // chatty-but-working server look broken.
  const s = stub(`
process.stdout.write('starting up...\\n');
let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);
if(!l.trim())continue;let m;try{m=JSON.parse(l)}catch{continue}
if(m.id===1){process.stdout.write('still here\\n');process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{}})+'\\n')}
if(m.id===2)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:2,result:{tools:[{name:'ok'}]}})+'\\n')}});
setInterval(()=>{},1000)`)
  const r = await callMcp(s, { method: 'tools/list', handshakeMs: 6000, timeoutMs: 6000 })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.result.tools[0].name, 'ok')
})

test('stderr is captured and returned with the failure', async () => {
  // Without it, "the server exited" is a dead end. With it, the reason is in hand.
  const s = stub("process.stderr.write('missing API key\\n'); process.exit(1)")
  const r = await callMcp(s, { method: 'tools/list', handshakeMs: 3000, timeoutMs: 3000 })
  assert.strictEqual(r.ok, false)
  assert.match(r.stderr || '', /missing API key/)
})

test('a firehose on stdout is capped rather than eating memory', async () => {
  const s = stub("setInterval(()=>process.stdout.write('x'.repeat(200000)),1)")
  const r = await callMcp(s, { method: 'tools/list', handshakeMs: 8000, timeoutMs: 8000 })
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /more than \d+ bytes|did not complete initialize/)
})
