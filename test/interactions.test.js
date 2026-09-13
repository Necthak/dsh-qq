/**
 * Inline keyboards and their callbacks.
 *
 * The contract under test is that a tap performs exactly what the equivalent
 * typed command would have performed — including handing the pending registry
 * the same text a human would type — because that reuse is what keeps the
 * approval and question rules in one place.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionMap } from '../lib/bridge/sessions.js'
import { PendingInteractions } from '../lib/bridge/pending.js'
import { createInteractionHandler } from '../lib/bridge/interactions.js'
import { registerApprovalAnswerer } from '../lib/bridge/approvals.js'
import { registerQuestionAnswerer } from '../lib/bridge/questions.js'
import { createInboundHandler } from '../lib/bridge/inbound.js'
import { decodeButton, MODEL_PAGE_SIZE } from '../lib/bridge/keyboard.js'
import { normalizeInteraction } from '../lib/qq/events.js'
import { buildMessageBody } from '../lib/qq/api.js'

/** A two-provider catalog with one reasoning-capable model. */
function catalog() {
  const models = []
  for (let index = 0; index < 12; index += 1) {
    models.push({ id: `model-${index}`, name: `Model ${index}` })
  }
  return {
    default: { provider: 'opencode-go', model: 'model-0' },
    routableProviders: ['opencode-go', 'deepseek-official'],
    groups: [
      {
        id: 'opencode-go',
        name: 'opencode-go',
        models: [
          { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', reasoning: { efforts: [{ id: 'off' }, { id: 'max' }] } },
          ...models,
        ],
      },
      { id: 'deepseek-official', name: 'DeepSeek 官方', models: [{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }] },
    ],
    failures: [],
  }
}

/** A normalized interaction. */
function interaction(overrides = {}) {
  return {
    kind: 'private',
    peerId: 'OWNER',
    userId: 'OWNER',
    interactionId: 'INNER1',
    eventId: 'OUTER1',
    buttonData: '',
    buttonId: '',
    timestamp: '',
    ...overrides,
  }
}

/**
 * Build an interaction handler over a scripted model service.
 *
 * @param options - settings and whether a session is bound.
 * @returns The handler plus recorded calls.
 */
function harness({ settings = {}, bound = true, bindAs = 'private:OWNER' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-int-'))
  const sessions = new SessionMap({ path: join(dir, 'sessions.json'), log: () => {} })
  if (bound) sessions.bind(bindAs, 'sess_1')

  const sent = []
  const selected = []
  const rejected = []
  const acks = []
  const pending = new PendingInteractions({ log: () => {} })

  const models = {
    catalog: async () => catalog(),
    current: async () => ({ provider: 'opencode-go', model: 'model-0' }),
    select: async (sessionId, selection) => {
      selected.push({ sessionId, ...selection })
      return { selected: { provider: selection.provider, model: selection.model, ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort } } }
    },
  }

  const handler = createInteractionHandler({
    sessions,
    models,
    pending,
    config: () => ({ mode: 'closed-agent', ownerOpenId: 'OWNER', ...settings }),
    log: () => {},
    outbound: {
      deliver: async (job) => { sent.push(job) },
      ackInteraction: async (id, code) => { acks.push({ id, code }) },
    },
    onRejected: (value) => rejected.push(value),
  })

  return { handler, sent, selected, rejected, acks, pending, sessions, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('a model button carries provider and model, never a position', async () => {
  const h = harness()
  try {
    const ctx = { sessionController: { prompt: async () => { throw new Error('no prompt expected') }, modelCatalog: async () => catalog() } }
    const sent = []
    const inbound = createInboundHandler({
      ctx,
      sessions: h.sessions,
      outbound: { deliver: async (job) => { sent.push(job) } },
      pending: new PendingInteractions({ log: () => {} }),
      models: { catalog: async () => catalog(), current: async () => ({ provider: 'opencode-go', model: 'model-0' }) },
      config: () => ({ mode: 'closed-agent', ownerOpenId: 'OWNER' }),
      log: () => {},
      ensureSession: async () => 'sess_1',
      status: () => ({}),
      signal: new AbortController().signal,
    })

    await inbound({ kind: 'private', peerId: 'OWNER', userId: 'OWNER', messageId: 'm1', text: '/model', attachments: [], ark: '' })

    const keyboard = sent[0].keyboard
    assert.ok(keyboard, 'the listing must carry a keyboard')
    const buttons = keyboard.content.rows.flatMap((row) => row.buttons)
    const modelButtons = buttons.filter((entry) => decodeButton(entry.action.data)?.kind === 'model')
    assert.equal(modelButtons.length, MODEL_PAGE_SIZE, 'one page of model buttons')

    // Position would break the moment the catalog changed under a stale
    // message; the payload must name the model outright.
    assert.deepEqual(decodeButton(modelButtons[0].action.data), { kind: 'model', args: ['opencode-go', 'deepseek-v4.1-flash'] })
    for (const entry of buttons) {
      assert.ok(entry.render_data.label.length <= 10, 'the platform caps button labels at 10 characters')
    }
  } finally {
    h.cleanup()
  }
})

test('pressing a model button switches that exact model', async () => {
  const h = harness()
  try {
    await h.handler(interaction({ buttonData: 'model|deepseek-official|deepseek-flash' }))
    assert.deepEqual(h.selected, [{ sessionId: 'sess_1', provider: 'deepseek-official', model: 'deepseek-flash' }])
    assert.match(h.sent[0].text, /已切换：deepseek-official\/deepseek-flash/)
  } finally {
    h.cleanup()
  }
})

test('pressing an effort button sets the effort on the named model', async () => {
  const h = harness()
  try {
    await h.handler(interaction({ buttonData: 'effort|opencode-go|deepseek-v4.1-flash|max' }))
    assert.deepEqual(h.selected, [{ sessionId: 'sess_1', provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' }])
  } finally {
    h.cleanup()
  }
})

test('the confirmation offers the new model reasoning efforts', async () => {
  const h = harness()
  try {
    await h.handler(interaction({ buttonData: 'model|opencode-go|deepseek-v4.1-flash' }))
    const buttons = h.sent[0].keyboard.content.rows[0].buttons
    assert.deepEqual(buttons.map((entry) => decodeButton(entry.action.data).args[2]), ['off', 'max'])
  } finally {
    h.cleanup()
  }
})

test('a page button re-renders that page', async () => {
  const h = harness()
  try {
    await h.handler(interaction({ buttonData: 'page|1' }))
    assert.match(h.sent[0].text, /第 2\/2 页/)
    const numbers = h.sent[0].keyboard.content.rows.flatMap((row) => row.buttons).map((entry) => entry.render_data.label)
    assert.ok(numbers.includes('9'), 'page two starts at the ninth model')
  } finally {
    h.cleanup()
  }
})

test('an approval button feeds the registry the text a human would type', async () => {
  const h = harness()
  try {
    const decision = h.pending.open('private:OWNER', {
      kind: 'approval',
      timeoutMs: 5_000,
      parse: (text) => (text === '通过' ? 'allowed-once' : undefined),
    })
    await h.handler(interaction({ buttonData: 'approve' }))
    assert.equal(await decision, 'allowed-once')
    assert.match(h.sent[0].text, /已通过/)
  } finally {
    h.cleanup()
  }
})

test('a question option button answers with its number', async () => {
  const h = harness()
  try {
    const decision = h.pending.open('private:OWNER', {
      kind: 'question',
      timeoutMs: 5_000,
      parse: (text) => (text === '2' ? { answers: [{ id: 'q', selected: ['乙'] }] } : undefined),
    })
    await h.handler(interaction({ buttonData: 'opt|2' }))
    assert.deepEqual(await decision, { answers: [{ id: 'q', selected: ['乙'] }] })
  } finally {
    h.cleanup()
  }
})

test('a button with nothing waiting says so instead of pretending', async () => {
  const h = harness()
  try {
    await h.handler(interaction({ buttonData: 'approve' }))
    assert.match(h.sent[0].text, /没有待审批的请求/)
  } finally {
    h.cleanup()
  }
})

test('an unadmitted sender cannot press a button', async () => {
  const h = harness({ settings: { mode: 'chat', allow: ['MEMBER'], ownerOpenId: 'OWNER' } })
  try {
    await h.handler(interaction({ peerId: 'STRANGER', userId: 'STRANGER', buttonData: 'model|opencode-go|model-1' }))
    assert.equal(h.selected.length, 0, 'a stranger must not reach the model router')
    assert.equal(h.sent.length, 0, 'and must not be answered')
    assert.equal(h.rejected.length, 1, 'but the refusal is recorded so the operator can admit them')
  } finally {
    h.cleanup()
  }
})

test('a payload this bridge did not encode is ignored', async () => {
  const h = harness()
  try {
    await h.handler(interaction({ buttonData: 'something-else-entirely' }))
    assert.equal(h.selected.length, 0)
    assert.equal(h.sent.length, 0)
  } finally {
    h.cleanup()
  }
})

test('a press arms the cursor with the envelope id, never the interaction id', async () => {
  const h = harness()
  try {
    // Only the envelope id is accepted as a passive `event_id`; the interaction
    // id belongs to the acknowledgement and nowhere else.
    await h.handler(interaction({ interactionId: 'INNER9', eventId: 'OUTER9', buttonData: 'approve' }))
    const record = h.sessions.get('private:OWNER')
    assert.equal(record.replyToMessageId, 'OUTER9')
    assert.equal(record.replyTargetKind, 'event')
  } finally {
    h.cleanup()
  }
})

test('a click whose frame carried no envelope id leaves the cursor alone', async () => {
  const h = harness()
  try {
    h.sessions.setReplyTarget('private:OWNER', 'msg_keep')
    await h.handler(interaction({ interactionId: 'INNER9', eventId: '', buttonData: 'approve' }))
    assert.equal(
      h.sessions.get('private:OWNER').replyToMessageId,
      'msg_keep',
      'without an event target the conversation still answers in the window it already had',
    )
  } finally {
    h.cleanup()
  }
})

test('switching a model from a button is owner-only', async () => {
  const h = harness({ settings: { mode: 'chat', allow: ['MEMBER'], ownerOpenId: 'OWNER' } })
  try {
    h.sessions.bind('group:GROUP', 'sess_2')
    await h.handler(interaction({ kind: 'group', peerId: 'GROUP', userId: 'MEMBER', buttonData: 'model|opencode-go|model-1' }))
    assert.equal(h.selected.length, 0)
    assert.match(h.sent[0].text, /只有 owner/)
  } finally {
    h.cleanup()
  }
})

// ── the prompts that carry keyboards ────────────────────────────────────────

test('an approval prompt ships its decision buttons', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-kb-'))
  try {
    const sessions = new SessionMap({ path: join(dir, 'sessions.json'), log: () => {} })
    sessions.bind('private:OWNER', 'sess_1')
    const sent = []
    const ctx = { on: (name, handler, options) => { ctx.handlers[name] = handler; ctx.options[name] = options; return () => {} }, handlers: {}, options: {} }

    registerApprovalAnswerer({
      ctx,
      sessions,
      outbound: { deliver: async (job) => { sent.push(job) } },
      pending: new PendingInteractions({ log: () => {} }),
      config: () => ({ approvalTimeoutMs: 20 }),
      log: () => {},
    })

    await ctx.handlers['approval/request']({ agent: { session: { id: 'sess_1' } }, toolName: 'bash' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60))
      return 'desktop'
    })

    const buttons = sent[0].keyboard.content.rows[0].buttons
    assert.deepEqual(buttons.map((entry) => entry.action.data), ['approve', 'deny'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a single question with options ships option buttons; a multi-question does not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-kb-'))
  try {
    const sessions = new SessionMap({ path: join(dir, 'sessions.json'), log: () => {} })
    sessions.bind('private:OWNER', 'sess_1')
    const sent = []
    const ctx = { on: (name, handler, options) => { ctx.handlers[name] = handler; ctx.options[name] = options; return () => {} }, handlers: {}, options: {} }

    registerQuestionAnswerer({
      ctx,
      sessions,
      outbound: { deliver: async (job) => { sent.push(job) } },
      pending: new PendingInteractions({ log: () => {} }),
      config: () => ({ questionTimeoutMs: 20 }),
      log: () => {},
    })

    const ask = ctx.handlers['user-questions/request']
    await ask({ questions: [{ id: 'q1', question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] }], agent: { session: { id: 'sess_1' } } }, async () => 'desktop')
    assert.deepEqual(sent[0].keyboard.content.rows[0].buttons.map((entry) => entry.action.data), ['opt|1', 'opt|2'])

    await ask({ questions: [{ id: 'a', question: 'A?' }, { id: 'b', question: 'B?' }], agent: { session: { id: 'sess_1' } } }, async () => 'desktop')
    assert.equal(sent[1].keyboard, undefined, 'a multi-question request keeps the numbered-text protocol')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── transport ───────────────────────────────────────────────────────────────

test('a keyboard survives body construction alongside text', () => {
  const body = buildMessageBody({ text: 'hi', keyboard: { content: { rows: [] } }, replyToMessageId: 'm1', msgSeq: 2 })
  assert.equal(body.msg_type, 0)
  assert.equal(body.content, 'hi')
  assert.equal(body.msg_id, 'm1')
  assert.deepEqual(body.keyboard, { content: { rows: [] } })
})

test('an interaction event normalizes to the conversation a message would carry', () => {
  const normalized = normalizeInteraction('INTERACTION_CREATE', {
    id: 'EV1',
    scene: 'c2c',
    user_openid: 'U1',
    data: { type: 11, resolved: { button_data: 'approve', button_id: '通过' } },
  })
  assert.equal(normalized.kind, 'private')
  assert.equal(normalized.peerId, 'U1')
  assert.equal(normalized.interactionId, 'EV1')
  assert.equal(normalized.buttonData, 'approve')
})

test('the envelope id is carried separately from the payload id', () => {
  const data = {
    id: '1b13d569-4610-4ab9-bc51-feecc5def6d4',
    scene: 'c2c',
    user_openid: 'U1',
    data: { type: 11, resolved: { button_data: 'approve' } },
  }
  // The two are different values from different levels and only the envelope
  // one is a usable `event_id` passive target.
  const withEnvelope = normalizeInteraction('INTERACTION_CREATE', data, 'INTERACTION_CREATE:1b13d569')
  assert.equal(withEnvelope.interactionId, '1b13d569-4610-4ab9-bc51-feecc5def6d4')
  assert.equal(withEnvelope.eventId, 'INTERACTION_CREATE:1b13d569')

  // A frame that carried none leaves the caller with no event target.
  assert.equal(normalizeInteraction('INTERACTION_CREATE', data).eventId, '')
})

test('interaction kinds the bridge does not act on are not normalized', () => {
  const base = { id: 'EV1', scene: 'c2c', user_openid: 'U1' }
  assert.equal(normalizeInteraction('INTERACTION_CREATE', { ...base, data: { type: 13 } }), null, 'message feedback')
  assert.equal(normalizeInteraction('INTERACTION_CREATE', { ...base, data: { type: 16 } }), null, 'model switcher')
  assert.equal(normalizeInteraction('INTERACTION_CREATE', { ...base, scene: 'guild', data: { type: 11, resolved: { button_data: 'x' } } }), null, 'channel scene')
  assert.equal(normalizeInteraction('C2C_MESSAGE_CREATE', base), null, 'a message is not an interaction')
})

// ── click acknowledgement ───────────────────────────────────────────────────

test('every handled tap is acknowledged exactly once, with its outcome', async () => {
  const h = harness()
  try {
    await h.handler(interaction({ buttonData: 'page|0' }))
    assert.deepEqual(h.acks, [{ id: 'INNER1', code: 0 }], 'a served tap reports success')
  } finally {
    h.cleanup()
  }
})

test('a tap from an unadmitted sender is acknowledged as a permission failure', async () => {
  const h = harness({ settings: { mode: 'chat', allow: ['SOMEONE_ELSE'] } })
  try {
    await h.handler(interaction())
    // Without an acknowledgement the QQ client spins until its own timeout,
    // so even a refusal has to answer — with the code that says why.
    assert.deepEqual(h.acks, [{ id: 'INNER1', code: 4 }])
    assert.equal(h.rejected.length, 1)
  } finally {
    h.cleanup()
  }
})

test('an unrecognised payload is acknowledged as a failure, not left loading', async () => {
  const h = harness()
  try {
    await h.handler(interaction({ buttonData: 'nonsense' }))
    assert.deepEqual(h.acks, [{ id: 'INNER1', code: 1 }])
    assert.equal(h.sent.length, 0)
  } finally {
    h.cleanup()
  }
})

test('an option tap with nothing open is acknowledged and answered', async () => {
  const h = harness()
  try {
    await h.handler(interaction({ buttonData: 'opt|1' }))
    assert.deepEqual(h.acks, [{ id: 'INNER1', code: 1 }])
    assert.match(h.sent[0].text, /当前没有待回答的问题/)
  } finally {
    h.cleanup()
  }
})

test('a served option tap reports success', async () => {
  const h = harness()
  try {
    const decision = h.pending.open('private:OWNER', {
      kind: 'question',
      timeoutMs: 60_000,
      parse: (text) => (text === '1' ? '甲' : undefined),
    })
    await h.handler(interaction({ buttonData: 'opt|1' }))
    assert.equal(await decision, '甲')
    assert.deepEqual(h.acks, [{ id: 'INNER1', code: 0 }])
  } finally {
    h.cleanup()
  }
})

test("a tap arms the cursor as an event target, so the reply uses event_id", async () => {
  const h = harness()
  try {
    await h.handler(interaction({ buttonData: 'page|0' }))
    // The click's id is an event id: sent as msg_id the platform refuses it
    // with 40034024, which also broke every later reply on the conversation.
    assert.equal(h.sessions.get('private:OWNER').replyTargetKind, 'event')
    assert.deepEqual(h.sessions.takeReplySlot('private:OWNER', 4), { eventId: 'OUTER1' })
  } finally {
    h.cleanup()
  }
})

test('a model button still refuses a non-owner, and says so', async () => {
  // A group conversation, where the peer is the group and the owner is a
  // person: in a private chat the peer IS the owner, so that path cannot
  // express "someone else tapped".
  const h = harness({
    settings: { mode: 'chat', allow: ['MEMBER'], ownerOpenId: 'OWNER' },
    bindAs: 'group:GROUP',
  })
  try {
    await h.handler(interaction({ kind: 'group', peerId: 'GROUP', userId: 'MEMBER', buttonData: 'model|opencode-go|model-1' }))
    assert.equal(h.selected.length, 0)
    assert.match(h.sent[0].text, /只有 owner/)
    assert.deepEqual(h.acks, [{ id: 'INNER1', code: 4 }])
  } finally {
    h.cleanup()
  }
})
