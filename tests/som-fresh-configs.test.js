// #191686 / #191770 — a campaign's script must be the one `iris som campaign update` wrote.
// The server now serves it (daemon-configs reads som_campaigns), but the daemon kept its answer
// in memory for 5 minutes, so a batch started right after an update still got the OLD strategy,
// and when daemon-configs failed it fell back to the disk cache, which is the previous answer.
// A send (som / som_batch) now always asks fresh and refuses to run without an answer.
const test = require('node:test')
const assert = require('node:assert')
const { getCampaignConfigs, _resetCampaignConfigCache } = require('../daemon/task-executor')

const identity = { userId: 193, token: 't' }

function server (strategyRef) {
  const calls = []
  const fetch = async (url) => {
    calls.push(url)
    return {
      ok: true,
      status: 200,
      json: async () => ({
        configs: { courses: { boardId: '38', strategy: strategyRef.value, igAccount: 'heyiris.io', strategySource: 'som_campaigns' } },
        active_accounts: [{ id: 'courses', igAccount: 'heyiris.io', boardId: '38' }],
        source: 'database',
      }),
    }
  }
  return { fetch, calls }
}

test('a send sees the strategy changed a moment ago, not the one cached 5 minutes', async () => {
  _resetCampaignConfigCache()
  const strategy = { value: 'AI Course | V3' }
  const { fetch, calls } = server(strategy)

  const before = await getCampaignConfigs('/nonexistent', { fresh: true, fetch, identity })
  assert.strictEqual(before.configs.courses.strategy, 'AI Course | V3')

  strategy.value = 'Roadmap Commenters | V1' // iris som campaign update courses --strategy ...

  const after = await getCampaignConfigs('/nonexistent', { fresh: true, fetch, identity })
  assert.strictEqual(after.configs.courses.strategy, 'Roadmap Commenters | V1')
  assert.strictEqual(after.source, 'database')
  assert.strictEqual(calls.length, 2)
})

test('non-sending callers may still use the short cache', async () => {
  _resetCampaignConfigCache()
  const strategy = { value: 'A' }
  const { fetch, calls } = server(strategy)
  await getCampaignConfigs('/nonexistent', { fetch, identity })
  await getCampaignConfigs('/nonexistent', { fetch, identity })
  assert.strictEqual(calls.length, 1)
})

test('a send refuses when daemon-configs cannot answer, instead of using the last cached copy', async () => {
  _resetCampaignConfigCache()
  const strategy = { value: 'AI Course | V3' }
  const ok = server(strategy)
  await getCampaignConfigs('/nonexistent', { fresh: true, fetch: ok.fetch, identity }) // warm the cache

  const down = async () => ({ ok: false, status: 503, json: async () => ({ error: 'som_campaigns_unavailable' }) })
  const r = await getCampaignConfigs('/nonexistent', { fresh: true, requireDatabase: true, fetch: down, identity })
  assert.strictEqual(r.source, 'unavailable')
  assert.deepStrictEqual(r.configs, {})
  assert.match(r.error, /503/)
})
