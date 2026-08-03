#!/usr/bin/env node
/**
 * BridgeRegistry — correctness suite.
 *
 * The registry is the contract between the cloud and this machine, so the things worth
 * asserting are mostly about HONESTY, not happy paths: does every failure carry a
 * distinct, actionable reason, and does the capability report distinguish "unavailable"
 * from "unknown"? Collapsing those is the bug this whole rail exists to fix (#178670),
 * and it is the kind of bug a happy-path test would never catch.
 */

const assert = require('assert')
const path = require('path')
const registry = require('../daemon/bridge-registry')

let pass = 0
let fail = 0
const failures = []

async function t (name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    failures.push({ name, error: e.message })
    console.log(`  ✗ ${name}\n      ${e.message}`)
  }
}

const section = (s) => console.log(`\n${s}`)

;(async () => {
  section('Capability reporting')

  await t('reports every configured provider', () => {
    const caps = registry.capabilities()
    for (const key of registry.listProviders()) {
      assert.ok(caps[key], `missing ${key}`)
    }
  })

  await t('every entry has available + functions', () => {
    for (const [key, entry] of Object.entries(registry.capabilities())) {
      assert.strictEqual(typeof entry.available, 'boolean', `${key}.available`)
      assert.ok(Array.isArray(entry.functions), `${key}.functions`)
    }
  })

  await t('an unavailable provider ALWAYS carries a reason', () => {
    // The whole point. A bare `false` is what let "bridge is offline" stand in for
    // five different problems; an unavailable provider that cannot say why is a
    // regression even when the boolean is correct.
    for (const [key, entry] of Object.entries(registry.capabilities())) {
      if (!entry.available) {
        assert.ok(entry.reason && entry.reason.length > 3, `${key} unavailable with no reason`)
      }
    }
  })

  await t('an available provider carries no reason', () => {
    for (const [key, entry] of Object.entries(registry.capabilities())) {
      if (entry.available) assert.strictEqual(entry.reason, null, `${key} available but has a reason`)
    }
  })

  await t('the four Data Sources providers are all declared', () => {
    const declared = registry.listProviders()
    for (const key of ['obsidian', 'imessage', 'apple_mail', 'apple_calendar']) {
      assert.ok(declared.includes(key), `missing provider ${key}`)
    }
  })

  await t('capability probes never throw', () => {
    // A probe that throws takes the heartbeat with it, and a node that stops
    // heartbeating reads as OFFLINE — a worse lie than any wrong capability.
    for (const provider of Object.values(registry.PROVIDERS)) {
      provider.available()
    }
  })

  section('Named failures')

  await t('unknown provider names the provider AND lists the known ones', async () => {
    await assert.rejects(
      () => registry.call('definitely-not-a-provider', 'x', {}),
      (e) => /Unknown bridge provider/.test(e.message) && /obsidian/.test(e.message),
    )
  })

  await t('unknown function lists the available functions', async () => {
    await assert.rejects(
      () => registry.call('obsidian', 'not_a_function', {}),
      (e) => /Unknown function/.test(e.message) && /search_notes/.test(e.message),
    )
  })

  await t('unknown provider and unknown function are DIFFERENT errors', async () => {
    const msgs = []
    for (const [p, f] of [['nope', 'x'], ['obsidian', 'nope']]) {
      await registry.call(p, f, {}).catch((e) => msgs.push(e.message))
    }
    assert.strictEqual(msgs.length, 2)
    assert.notStrictEqual(msgs[0], msgs[1], 'both failures produced the same message')
  })

  section('Live calls (require the bridge HTTP server)')

  let bridgeUp = true
  try {
    await fetch(`http://127.0.0.1:${registry.bridgePort()}/health`, { signal: AbortSignal.timeout(2000) })
  } catch {
    bridgeUp = false
  }

  if (!bridgeUp) {
    // Skipping is reported, never silent — a suite that quietly drops its only
    // end-to-end coverage reads as "all green" while proving nothing.
    console.log(`  ⚠ SKIPPED — bridge not listening on :${registry.bridgePort()} (start it to run these)`)
  } else {
    let vaultPath = null

    await t('obsidian.list_vaults returns vaults', async () => {
      const res = await registry.call('obsidian', 'list_vaults', {})
      assert.ok(Array.isArray(res.vaults), 'expected a vaults array')
      if (res.vaults.length) vaultPath = res.vaults[0].path
    })

    await t('obsidian.search_notes returns structured results', async () => {
      assert.ok(vaultPath, 'no vault discovered on this machine')
      const res = await registry.call('obsidian', 'search_notes', { vault: vaultPath, q: 'the', limit: 3, body: 1 })
      assert.ok(Array.isArray(res.results))
      assert.ok(res.results.length <= 3)
      for (const r of res.results) assert.ok(r.path && r.name, JSON.stringify(r))
    })

    await t('a route error surfaces the ROUTE\'s message, not a generic one', async () => {
      // search_notes without ?q is a 400 from the bridge. The registry must pass that
      // through — flattening it to "bridge unavailable" is what made real failures
      // undiagnosable.
      await assert.rejects(
        () => registry.call('obsidian', 'search_notes', { vault: vaultPath }),
        (e) => /search_notes failed/.test(e.message) && !/not listening/.test(e.message),
      )
    })

    await t('a missing vault does not leak absolute paths', async () => {
      await registry
        .call('obsidian', 'read_note', { vault: vaultPath, path: 'definitely-missing-xyz.md' })
        .catch((e) => {
          assert.ok(!e.message.includes(path.sep + 'Users' + path.sep), `leaked a path: ${e.message}`)
        })
    })
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) {
    console.log('\nFAILURES:')
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`)
  }
  process.exit(fail ? 1 : 0)
})()
