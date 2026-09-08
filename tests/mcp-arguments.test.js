'use strict'

/**
 * MCP tool arguments must reach the server as a RECORD.
 *
 * Found in production, not in a fixture: a dispatched mcp_call came back with
 *   invalid_type at params.arguments: expected record, received array
 * because PHP's json_decode($x, true) turns `{}` into `[]`, re-encodes it as `[]`, and JS
 * treats `[]` as truthy — so the `|| {}` fallback never fired. Every local test passed,
 * because nothing local round-trips through PHP.
 *
 * Uses a stub MCP server that echoes its params back, so the assertion is about the shape
 * that actually goes over the wire rather than the shape we meant to send.
 */

const test=require('node:test'), assert=require('node:assert')
const fs=require('fs'), os=require('os'), path=require('path')
const { execFileSync } = require('child_process')
const ROOT=path.resolve(__dirname,'..')
// A stub MCP server that echoes back the params it received, so we can see the wire shape.
const STUB=path.join(os.tmpdir(),'stub-mcp.js')
fs.writeFileSync(STUB,`
let buf='';process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);
if(m.id===1)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'stub',version:'1'}}})+'\\n');
if(m.id===2)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:2,result:{echoed:m.params,isArray:Array.isArray(m.params&&m.params.arguments)}})+'\\n');}})`)
const REG=path.join(os.tmpdir(),'stub-servers.json')
fs.writeFileSync(REG,JSON.stringify({stub:{command:process.execPath,args:[STUB]}}))
function run(args){
  const f=path.join(os.tmpdir(),'req-'+Math.random()+'.json')
  fs.writeFileSync(f,JSON.stringify({server:'stub',tool:'x',arguments:args}))
  const out=execFileSync(process.execPath,[path.join(ROOT,'daemon/mcp-run.js'),f],{env:{...process.env,IRIS_MCP_SERVERS_FILE:REG},encoding:'utf8'})
  return JSON.parse(out)
}
test('an empty object stays a record on the wire',()=>{
  assert.strictEqual(run({}).result.isArray,false)
})
test('an empty ARRAY (what PHP sends for {}) is coerced to a record',()=>{
  // The production bug: MCP rejected it with "expected record, received array".
  assert.strictEqual(run([]).result.isArray,false)
})
test('real arguments are passed through untouched',()=>{
  assert.deepStrictEqual(run({udid:'ABC',bundleId:'com.x'}).result.echoed.arguments,{udid:'ABC',bundleId:'com.x'})
})
test('null arguments become a record, not null',()=>{
  assert.strictEqual(run(null).result.isArray,false)
})
