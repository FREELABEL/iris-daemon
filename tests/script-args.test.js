const test = require('node:test')
const assert = require('node:assert')
const { scriptArgEnv, runEnv } = require('../daemon/script-args')

// #189589 — a run's settings reach the script as IRIS_ARG_<NAME>, and nothing else does.
test('maps settings to IRIS_ARG_ env vars', () => {
  assert.deepStrictEqual(scriptArgEnv({ mode: 'hop', drone_name: 'Mambo_1' }), { IRIS_ARG_MODE: 'hop', IRIS_ARG_DRONE_NAME: 'Mambo_1' })
})

test('a value that looks like a command stays a value', () => {
  assert.strictEqual(scriptArgEnv({ note: '"; rm -rf ~; echo "' }).IRIS_ARG_NOTE, '"; rm -rf ~; echo "')
})

test('refuses names that are not plain identifiers, and non-text values', () => {
  assert.deepStrictEqual(scriptArgEnv({ 'PATH': 'x' }), { IRIS_ARG_PATH: 'x' })
  assert.deepStrictEqual(scriptArgEnv({ 'a-b': 'x', '1x': 'y', 'ok': { nested: 1 }, n: null }), {})
  assert.deepStrictEqual(scriptArgEnv(null), {})
  assert.deepStrictEqual(scriptArgEnv(['mode']), {})
})

test('caps a value at 2000 characters', () => {
  assert.strictEqual(scriptArgEnv({ big: 'x'.repeat(5000) }).IRIS_ARG_BIG.length, 2000)
})

test('hands the script its task id and the Gate receipt it ran under', () => {
  const receipt = { by: 'Constellation Gate', verdict: 'clean', scan_id: 'scn_1', approved_by: 193 }
  const env = runEnv({ id: '01a144dd-ec7', config: { gate: receipt } })
  assert.strictEqual(env.IRIS_TASK_ID, '01a144dd-ec7')
  assert.deepStrictEqual(JSON.parse(env.IRIS_GATE_RECEIPT), receipt)
  assert.deepStrictEqual(runEnv({ id: 'x;rm', config: { gate: ['no'] } }), {})
})
