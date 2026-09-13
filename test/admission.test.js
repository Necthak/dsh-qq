import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isAllowed, isOwner } from '../lib/bridge/inbound.js'

/** A normalized message with sensible defaults. */
function message(overrides = {}) {
  return { kind: 'private', peerId: 'OWNER', userId: 'OWNER', userName: '甲', ...overrides }
}

test('closed-agent admits only a named owner in a private conversation', () => {
  const settings = { mode: 'closed-agent', ownerOpenId: 'OWNER' }
  assert.equal(isAllowed(message(), settings), true)
  assert.equal(isAllowed(message({ peerId: 'STRANGER', userId: 'STRANGER' }), settings), false)
  assert.equal(
    isAllowed(message({ kind: 'group', peerId: 'GROUP', userId: 'OWNER' }), settings),
    false,
    'a group must never reach the full toolset',
  )
})

test('closed-agent with no owner configured admits nobody', () => {
  // This is the important one: the plugin ships disabled, and once enabled with
  // no owner it must still refuse everyone rather than hand out shell access.
  const settings = { mode: 'closed-agent', ownerOpenId: '' }
  assert.equal(isAllowed(message(), settings), false)
})

test('an unconfigured bridge still admits everyone when that is asked for explicitly', () => {
  const settings = { mode: 'closed-agent', ownerOpenId: '', allowAllWhenEmpty: true }
  assert.equal(isAllowed(message({ peerId: 'ANYONE', userId: 'ANYONE' }), settings), true)
})

test('chat mode follows the allow list and admits groups', () => {
  const settings = { mode: 'chat', allow: ['USER_A', 'GROUP_A'] }
  assert.equal(isAllowed(message({ peerId: 'USER_A', userId: 'USER_A' }), settings), true)
  assert.equal(isAllowed(message({ kind: 'group', peerId: 'GROUP_A', userId: 'USER_A' }), settings), true)
  assert.equal(isAllowed(message({ kind: 'group', peerId: 'GROUP_B', userId: 'USER_B' }), settings), false)
})

test('chat mode with an empty allow list admits nobody by default', () => {
  assert.equal(isAllowed(message(), { mode: 'chat', allow: [] }), false)
  assert.equal(isAllowed(message(), { mode: 'chat', allow: [], allowAllWhenEmpty: true }), true)
})

test('a deny entry beats the allow list in either mode', () => {
  assert.equal(
    isAllowed(message({ peerId: 'X', userId: 'X' }), { mode: 'chat', allow: ['X'], deny: ['X'] }),
    false,
  )
  assert.equal(
    isAllowed(message({ peerId: 'OWNER', userId: 'OWNER' }), { mode: 'closed-agent', ownerOpenId: 'OWNER', deny: ['OWNER'] }),
    false,
  )
})

test('a group deny entry refuses the whole group', () => {
  const settings = { mode: 'chat', allow: ['GROUP_A'], deny: ['GROUP_A'] }
  assert.equal(isAllowed(message({ kind: 'group', peerId: 'GROUP_A', userId: 'USER_A' }), settings), false)
})

test('an unknown mode falls back to the strict one', () => {
  const settings = { mode: 'nonsense', ownerOpenId: 'OWNER' }
  assert.equal(isAllowed(message(), settings), true)
  assert.equal(isAllowed(message({ kind: 'group', peerId: 'G', userId: 'OWNER' }), settings), false)
})

test('owner gating follows the configured OpenID', () => {
  const settings = { ownerOpenId: 'OWNER' }
  assert.equal(isOwner(message(), settings), true)
  assert.equal(isOwner(message({ userId: 'OTHER', peerId: 'OTHER' }), settings), false)
})

test('with no owner configured, administration is limited to private chat', () => {
  assert.equal(isOwner(message(), {}), true)
  assert.equal(isOwner(message({ kind: 'group' }), {}), false, 'a group member must not be able to reset a session')
})
