'use strict'
/**
 * A Hive script's settings for one run, as environment variables (#189589).
 *
 * The hub checks the values against the script's `# iris: arg=` declarations and carries them in
 * the SIGNED task config (config.args). Here they become IRIS_ARG_<NAME> — the only way a value
 * reaches the script. Never argv, never a shell string: a value is data, and an env var cannot
 * become a second command however it is spelled.
 *
 * Names are upper-cased and must be letters, digits and underscores (the hub already refuses
 * anything else; this refuses it again rather than trusting the wire). Values are strings, capped.
 */
const MAX_VALUE = 2000

function scriptArgEnv (args) {
  const env = {}
  if (!args || typeof args !== 'object' || Array.isArray(args)) return env
  for (const [name, value] of Object.entries(args)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) continue
    if (value === null || value === undefined || typeof value === 'object') continue
    env[`IRIS_ARG_${name.toUpperCase()}`] = String(value).slice(0, MAX_VALUE)
  }
  return env
}

/**
 * What the run itself is (#189589): its task id, and the receipt of the Constellation Gate scan
 * that cleared it (config.gate — set by the hub in the signed config, absent when Gate is off).
 * A script can then name, in its own records, the scan and the approval it ran under.
 */
function runEnv (task) {
  const env = {}
  if (task && /^[A-Za-z0-9-]{1,64}$/.test(String(task.id || ''))) env.IRIS_TASK_ID = String(task.id)
  const receipt = task?.config?.gate
  if (receipt && typeof receipt === 'object' && !Array.isArray(receipt)) {
    const json = JSON.stringify(receipt)
    if (json.length <= 4000) env.IRIS_GATE_RECEIPT = json
  }
  return env
}

module.exports = { scriptArgEnv, runEnv, MAX_VALUE }
