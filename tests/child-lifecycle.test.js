'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { spawn } = require('child_process')
const { closeStdin, killWithEscalation } = require('../daemon/child-lifecycle')

const exited = (child) => new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))

test('a program that reads stdin finishes once stdin is closed — it used to wait forever (#188351)', async () => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const done = exited(child)
  closeStdin(child)
  const r = await Promise.race([done, new Promise((res) => setTimeout(() => res('HANG'), 3000))])
  if (r === 'HANG') child.kill('SIGKILL')
  assert.deepStrictEqual(r, { code: 0, signal: null })
})

test('a payload is still delivered before stdin closes', async () => {
  const child = spawn(process.execPath, ['-e', 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{process.stdout.write(s);process.exit(0)})'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  closeStdin(child, 'hello')
  await exited(child)
  assert.strictEqual(out, 'hello')
})

test('a process that ignores SIGTERM is SIGKILLed after the grace period (child.killed lied)', async () => {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{}, 1000)'], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 300))   // let it install the handler
  const done = exited(child)
  killWithEscalation(child, 300)
  const r = await Promise.race([done, new Promise((res) => setTimeout(() => res('SURVIVED'), 4000))])
  if (r === 'SURVIVED') child.kill('SIGKILL')
  assert.deepStrictEqual(r, { code: null, signal: 'SIGKILL' })
})
