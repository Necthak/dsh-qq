/**
 * `/model` — catalog rendering and the switch path.
 *
 * The catalog is stubbed rather than mocked per-call, because the point of
 * these tests is the fold over a real catalog shape: numbering, tie-breaking,
 * and what the operator is told when a choice cannot be resolved.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionMap } from '../lib/bridge/sessions.js'
import { PendingInteractions } from '../lib/bridge/pending.js'
import { createInboundHandler } from '../lib/bridge/inbound.js'
import {
  createModelSwitcher,
  explainChoice,
  explainEffort,
  flattenCatalog,
  formatCatalog,
  resolveChoice,
  resolveEffort,
} from '../lib/bridge/model.js'

/** A two-provider catalog, including one model id published twice. */
function catalog() {
  return {
    default: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    routableProviders: ['opencode-go', 'deepseek-official'],
    groups: [
      {
        id: 'opencode-go',
        name: 'opencode-go',
        models: [
          { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', reasoning: { efforts: [{ id: 'off', name: 'off' }, { id: 'max', name: 'max' }], defaultEffort: 'max' } },
          { id: 'glm-5.2', name: 'GLM-5.2' },
        ],
      },
      {
        id: 'deepseek-official',
        name: 'DeepSeek 官方',
        models: [
          { id: 'deepseek-v4.1-flash', name: 'DeepSeek V41 Flash' },
          { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
        ],
      },
    ],
    failures: [],
  }
}

/** A normalized private message. */
function message(overrides = {}) {
  return {
    kind: 'private',
    peerId: 'OWNER',
    userId: 'OWNER',
    userName: '甲',
    messageId: 'ROBOT1.0_abc',
    text: 'hi',
    attachments: [],
    ark: '',
    ...overrides,
  }
}

/**
 * Build an inbound handler wired to a fake model service.
 *
 * @param options - catalog contents and settings overrides.
 * @returns The handler plus recorded calls.
 */
function harness({ settings = {}, sessionId = null, key = 'private:OWNER', current = undefined } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-model-'))
  const sessions = new SessionMap({ path: join(dir, 'sessions.json'), log: () => {} })
  if (sessionId !== null) sessions.bind(key, sessionId)

  const sent = []
  const selected = []
  const ctx = {
    sessionController: {
      prompt: async () => { throw new Error('a command must never reach the agent') },
      modelCatalog: async () => catalog(),
      selectModel: async (request) => {
        selected.push(request)
        return { selected: { provider: request.provider, model: request.model, ...request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort } } }
      },
      resolveAgent: async () => { throw new Error('not needed when current is supplied') },
    },
  }

  const models = createModelSwitcher({ ctx, log: () => {} })
  if (current !== undefined) models.current = async () => current

  const handler = createInboundHandler({
    ctx,
    sessions,
    outbound: { deliver: async (job) => { sent.push(job) }, sendActive: async (job) => { sent.push(job) } },
    pending: new PendingInteractions({ log: () => {} }),
    models,
    config: () => ({ mode: 'closed-agent', ownerOpenId: 'OWNER', ...settings }),
    log: () => {},
    ensureSession: async () => 'sess_1',
    status: () => ({}),
    signal: new AbortController().signal,
  })

  return { handler, sent, selected, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('numbering walks the catalog in the same order the list renders', () => {
  const rows = flattenCatalog(catalog())
  assert.deepEqual(rows.map((row) => `${row.provider}/${row.model.id}`), [
    'opencode-go/deepseek-v4.1-flash',
    'opencode-go/glm-5.2',
    'deepseek-official/deepseek-v4.1-flash',
    'deepseek-official/deepseek-v4-pro',
  ])

  const third = resolveChoice(catalog(), '3')
  assert.equal(third.kind, 'row')
  assert.equal(third.row.provider, 'deepseek-official')
  assert.equal(third.row.model.id, 'deepseek-v4.1-flash')
})

test('a bare model id resolves, preferring the conversation current provider', () => {
  const preferred = resolveChoice(catalog(), 'deepseek-v4.1-flash', 'deepseek-official')
  assert.equal(preferred.kind, 'row')
  assert.equal(preferred.row.provider, 'deepseek-official', 'the current provider breaks a two-provider tie')

  const ambiguous = resolveChoice(catalog(), 'deepseek-v4.1-flash', undefined)
  assert.equal(ambiguous.kind, 'ambiguous')
  assert.match(explainChoice(ambiguous), /opencode-go\/deepseek-v4\.1-flash/)

  const unique = resolveChoice(catalog(), 'deepseek-v4-pro', undefined)
  assert.equal(unique.kind, 'row')
  assert.equal(unique.row.provider, 'deepseek-official')
})

test('a display name resolves and provider/model is explicit', () => {
  const byName = resolveChoice(catalog(), 'GLM-5.2', undefined)
  assert.equal(byName.kind, 'row')
  assert.equal(byName.row.model.id, 'glm-5.2')

  const explicit = resolveChoice(catalog(), 'opencode-go/glm-5.2', undefined)
  assert.equal(explicit.kind, 'row')
  assert.equal(explicit.row.provider, 'opencode-go')
})

test('an unusable choice is refused with a reason, never guessed', () => {
  assert.equal(resolveChoice(catalog(), '99').kind, 'out-of-range')
  assert.equal(resolveChoice(catalog(), 'nope').kind, 'unknown')
  assert.equal(resolveChoice(catalog(), '').kind, 'missing')
  assert.match(explainChoice(resolveChoice(catalog(), '99')), /超出范围/)
  assert.match(explainChoice(resolveChoice(catalog(), 'nope')), /没有找到模型/)
})

test('an effort argument is validated against the chosen model', () => {
  const flash = resolveChoice(catalog(), '1').row
  assert.equal(resolveEffort(flash, undefined).kind, 'default')
  assert.deepEqual(resolveEffort(flash, 'max'), { kind: 'effort', id: 'max' })

  const rejected = resolveEffort(flash, 'ultra')
  assert.equal(rejected.kind, 'unsupported')
  assert.match(explainEffort(flash, rejected), /off、max/)

  const plain = resolveChoice(catalog(), '2').row
  const none = resolveEffort(plain, 'high')
  assert.equal(none.kind, 'unsupported')
  assert.match(explainEffort(plain, none), /不接受推理强度/)
})

test('the listing numbers every row and marks the current one', () => {
  const body = formatCatalog(catalog(), { provider: 'opencode-go', model: 'glm-5.2', reasoningEffort: 'high' })
  assert.match(body, /当前：opencode-go\/glm-5\.2 · high/)
  assert.match(body, /2\. glm-5\.2.*←/)
  assert.match(body, /3\. deepseek-v4\.1-flash/)
  assert.match(body, /deepseek-official/)
})

test('/model lists the catalog without reaching the agent', async () => {
  const h = harness({ sessionId: 'sess_1', current: { provider: 'opencode-go', model: 'glm-5.2' } })
  try {
    await h.handler(message({ text: '/model' }))
    assert.equal(h.selected.length, 0)
    assert.equal(h.sent.length, 1)
    assert.match(h.sent[0].text, /选择模型/)
    assert.match(h.sent[0].text, /当前：opencode-go\/glm-5\.2/)
  } finally {
    h.cleanup()
  }
})

test('/model <n> switches by row number', async () => {
  const h = harness({ sessionId: 'sess_1', current: { provider: 'opencode-go', model: 'glm-5.2' } })
  try {
    await h.handler(message({ text: '/model 4' }))
    assert.deepEqual(h.selected, [{ sessionId: 'sess_1', provider: 'deepseek-official', model: 'deepseek-v4-pro' }])
    assert.match(h.sent[0].text, /已切换：deepseek-official\/deepseek-v4-pro/)
  } finally {
    h.cleanup()
  }
})

test('/model <n> <effort> carries the reasoning effort through', async () => {
  const h = harness({ sessionId: 'sess_1', current: { provider: 'opencode-go', model: 'glm-5.2' } })
  try {
    await h.handler(message({ text: '/model 1 max' }))
    assert.deepEqual(h.selected, [{ sessionId: 'sess_1', provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' }])
  } finally {
    h.cleanup()
  }
})

test('an unsupported effort refuses the whole switch rather than half-applying it', async () => {
  const h = harness({ sessionId: 'sess_1', current: { provider: 'opencode-go', model: 'glm-5.2' } })
  try {
    await h.handler(message({ text: '/model 2 high' }))
    assert.equal(h.selected.length, 0, 'the model must not change when its effort is refused')
    assert.match(h.sent[0].text, /不接受推理强度/)
  } finally {
    h.cleanup()
  }
})

test('switching is owner-only while listing is not', async () => {
  const h = harness({
    sessionId: 'sess_1',
    key: 'group:GROUP',
    settings: { mode: 'chat', allow: ['MEMBER'], ownerOpenId: 'OWNER' },
    current: { provider: 'opencode-go', model: 'glm-5.2' },
  })
  try {
    await h.handler(message({ kind: 'group', peerId: 'GROUP', userId: 'MEMBER', text: '/model' }))
    assert.match(h.sent[0].text, /选择模型/, 'a member may look at the list')

    await h.handler(message({ kind: 'group', peerId: 'GROUP', userId: 'MEMBER', text: '/model 4' }))
    assert.equal(h.selected.length, 0)
    assert.match(h.sent[1].text, /只有 owner/)
  } finally {
    h.cleanup()
  }
})

test('/model before any session exists explains what to do first', async () => {
  const h = harness({ current: { provider: 'opencode-go', model: 'glm-5.2' } })
  try {
    await h.handler(message({ text: '/model' }))
    assert.match(h.sent[0].text, /还没有 DSH 会话/)
  } finally {
    h.cleanup()
  }
})
