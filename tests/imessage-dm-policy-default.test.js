const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const IMessageChannel = require('../channels/imessage')

/**
 * #184811 / #137256 — the DM default must admit NOBODY.
 *
 * shouldProcess() honours dm_policy, group_policy and the allow-list, and has
 * since the #137256 fix. The residual was the DEFAULT: dm_policy fell back to
 * 'open', and the open branch only consulted the allow-list `if (length > 0)`.
 * So a config that named no policy — the config you get by enabling the channel
 * and nothing else — replied to any stranger who typed the wake word.
 *
 * That is tolerable-looking for chat and not tolerable at all once the channel
 * routes structured commands: "@heyiris inbox read" from an unknown number
 * would read the operator's Hive inbox back to them.
 *
 * These tests pin the DEFAULT, not the configured behaviour. The configured
 * paths are already covered; what was never asserted is what happens when
 * nobody configures anything.
 */

function dm (overrides = {}) {
  return {
    text: '@heyiris inbox read',
    attachments: [],
    is_from_me: false,
    is_group: false,
    sender_id: '+15555550123',
    conversation_id: 'chat-stranger',
    ...overrides
  }
}

describe('iMessage DM policy default (#184811)', () => {
  it('a config that names NO policy does not reply to a stranger', () => {
    const channel = new IMessageChannel({})
    assert.equal(channel.shouldProcess(dm(), true), false)
  })

  it('an EMPTY allowlist admits nobody, rather than everybody', () => {
    const channel = new IMessageChannel({ allowlist: [] })
    assert.equal(channel.shouldProcess(dm(), true), false)
  })

  it('an allowlisted sender still gets through on the default', () => {
    const channel = new IMessageChannel({ allowlist: ['+15555550123'] })
    assert.equal(channel.shouldProcess(dm(), true), true)
  })

  it('a sender NOT on a non-empty allowlist is refused', () => {
    const channel = new IMessageChannel({ allowlist: ['+15555559999'] })
    assert.equal(channel.shouldProcess(dm(), true), false)
  })

  it('dm_policy=open is still honoured when someone asks for it explicitly', () => {
    const channel = new IMessageChannel({ dmPolicy: 'open' })
    assert.equal(channel.shouldProcess(dm(), true), true)
  })

  it('no wake word is refused regardless of policy', () => {
    const channel = new IMessageChannel({ dmPolicy: 'open' })
    assert.equal(channel.shouldProcess(dm({ text: 'hey are we still on for 3' }), false), false)
  })

  it('groups still default to closed', () => {
    const channel = new IMessageChannel({})
    assert.equal(channel.shouldProcess(dm({ is_group: true }), true), false)
  })

  it('an unrecognised policy value fails closed rather than open', () => {
    const channel = new IMessageChannel({ dmPolicy: 'sure-why-not' })
    assert.equal(channel.shouldProcess(dm(), true), false)
  })
})
