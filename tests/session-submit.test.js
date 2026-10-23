'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

/**
 * `iris hive chat` (#190671) sends with submit:true and follows the reply through the transcript.
 * Two things had to be true and neither was: the executor dropped `submit` on the floor (every
 * remote send was a notification), and a submit held the bridge — and the node task — for the whole
 * model turn. The real path was measured on a Mac Desktop session; these pin the wiring.
 */
const EXEC = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'task-executor.js'), 'utf8')
const BRIDGE = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')

test('the session_message task carries submit, and only a literal true', () => {
  assert.match(EXEC, /submit: sessionConfig\.submit === true/)
})

test('a submit queues the turn with prompt_async; an engine without it falls back to /message', () => {
  assert.match(BRIDGE, /submit \? await post\('prompt_async', 15000\) : await post\('message', 8000\)/)
  assert.match(BRIDGE, /if \(submit && r\.status === 404\) r = await post\('message', 180000\)/)
})
