import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_BUSY_DELIVERY,
  normalizeBusyDelivery,
  parseDeliveryOverride,
  resolveDeliveryMode,
} from '../lib/bridge/delivery.js'

test('a bare message is not an override', () => {
  assert.equal(parseDeliveryOverride('你好'), null)
  assert.equal(parseDeliveryOverride(''), null)
})

test('/steer and /queue split into a mode and the remaining prompt', () => {
  assert.deepEqual(parseDeliveryOverride('/steer 换个思路'), { mode: 'steer', text: '换个思路' })
  assert.deepEqual(parseDeliveryOverride('/queue 等会再说'), { mode: 'queue', text: '等会再说' })
  assert.deepEqual(parseDeliveryOverride('/STEER 大写也行'), { mode: 'steer', text: '大写也行' })
  assert.deepEqual(parseDeliveryOverride('  /steer   前后留白  '), { mode: 'steer', text: '前后留白' })
})

test('an override with no text is still an override, so the caller can print usage', () => {
  assert.deepEqual(parseDeliveryOverride('/steer'), { mode: 'steer', text: '' })
  assert.deepEqual(parseDeliveryOverride('/queue   '), { mode: 'queue', text: '' })
})

test('a longer word that merely starts with the same letters stays a command', () => {
  // Otherwise adding a `/steering` command later would be shadowed forever.
  assert.equal(parseDeliveryOverride('/steerer 你好'), null)
  assert.equal(parseDeliveryOverride('/queued'), null)
})

test('other commands are not overrides', () => {
  assert.equal(parseDeliveryOverride('/model 3'), null)
  assert.equal(parseDeliveryOverride('/status'), null)
  assert.equal(parseDeliveryOverride('/stop'), null)
})

test('the override text may span lines', () => {
  assert.deepEqual(parseDeliveryOverride('/steer 第一行\n第二行'), { mode: 'steer', text: '第一行\n第二行' })
})

test('the stored policy normalizes to the two known modes', () => {
  assert.equal(normalizeBusyDelivery('queue'), 'queue')
  assert.equal(normalizeBusyDelivery('steer'), 'steer')
  assert.equal(normalizeBusyDelivery(undefined), DEFAULT_BUSY_DELIVERY)
  assert.equal(normalizeBusyDelivery(''), DEFAULT_BUSY_DELIVERY)
  assert.equal(normalizeBusyDelivery('insert'), DEFAULT_BUSY_DELIVERY)
})

test('an idle session queues even under the steer policy', () => {
  assert.equal(resolveDeliveryMode({ policy: 'steer', busy: false }), 'queue')
  assert.equal(resolveDeliveryMode({ policy: 'steer', busy: null }), 'queue')
})

test('a running session steers under the default policy', () => {
  assert.equal(resolveDeliveryMode({ policy: DEFAULT_BUSY_DELIVERY, busy: true }), 'steer')
  assert.equal(resolveDeliveryMode({ policy: undefined, busy: true }), 'steer')
})

test('the queue policy queues even while the turn runs', () => {
  assert.equal(resolveDeliveryMode({ policy: 'queue', busy: true }), 'queue')
})

test('an explicit override wins over both the policy and the turn state', () => {
  assert.equal(resolveDeliveryMode({ policy: 'queue', forced: 'steer', busy: true }), 'steer')
  assert.equal(resolveDeliveryMode({ policy: 'queue', forced: 'steer', busy: false }), 'steer')
  assert.equal(resolveDeliveryMode({ policy: 'steer', forced: 'queue', busy: true }), 'queue')
})
