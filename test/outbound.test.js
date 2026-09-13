import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionMap } from '../lib/bridge/sessions.js'
import { Outbound, TurnCollector, extractText } from '../lib/bridge/outbound.js'
import { MSG_TYPE } from '../lib/qq/api.js'

/** A fake OpenAPI client that records every send body. */
function fakeApi({ failOnce = null } = {}) {
  const sent = []
  let failures = failOnce === null ? 0 : 1
  return {
    sent,
    async sendC2C(openid, body) {
      if (failures > 0) {
        failures -= 1
        throw failOnce
      }
      sent.push({ kind: 'private', openid, body })
      return { ok: true }
    },
    async sendGroup(openid, body) {
      if (failures > 0) {
        failures -= 1
        throw failOnce
      }
      sent.push({ kind: 'group', openid, body })
      return { ok: true }
    },
  }
}

function harness(config = {}, { failOnce = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-out-'))
  const sessions = new SessionMap({ path: join(dir, 'sessions.json'), log: () => {} })
  sessions.bind('private:U1', 'sess_a')
  sessions.bind('group:G1', 'sess_g')
  const api = fakeApi({ failOnce })
  const outbound = new Outbound({
    api,
    sessions,
    log: () => {},
    // `never` keeps this suite on the plain-text path, which is a supported
    // configuration in its own right; the automatic choice has its own tests.
    config: () => ({ intervalMs: 0, maxBytes: 3_500, markdownMode: 'never', ...config }),
  })
  return { api, sessions, outbound, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('a short answer is sent as one passive reply carrying msg_id and msg_seq', async () => {
  const h = harness()
  try {
    h.sessions.setReplyTarget('private:U1', 'msg_1')
    await h.outbound.deliver({ key: 'private:U1', kind: 'private', peerId: 'U1', text: '你好' })

    assert.equal(h.api.sent.length, 1)
    assert.equal(h.api.sent[0].body.msg_type, MSG_TYPE.text)
    assert.equal(h.api.sent[0].body.content, '你好')
    assert.equal(h.api.sent[0].body.msg_id, 'msg_1')
    assert.equal(h.api.sent[0].body.msg_seq, 1)
  } finally {
    h.cleanup()
  }
})

test('a long answer splits, and every chunk keeps a passive reply slot', async () => {
  const h = harness({ maxBytes: 40 })
  try {
    h.sessions.setReplyTarget('private:U1', 'msg_1')
    const text = Array.from({ length: 8 }, (_, i) => `第 ${i} 行的内容`).join('\n')
    await h.outbound.deliver({ key: 'private:U1', kind: 'private', peerId: 'U1', text })

    assert.ok(h.api.sent.length > 1, 'the answer must be split')
    // Every chunk stays passive while the window lasts: that is what keeps a
    // long answer off the tightly limited active-message quota.
    for (const [index, entry] of h.api.sent.entries()) {
      assert.equal(entry.body.msg_id, 'msg_1')
      assert.equal(entry.body.msg_seq, index + 1, 'msg_seq must increase per chunk')
    }
    for (const entry of h.api.sent) {
      assert.ok(Buffer.byteLength(entry.body.content, 'utf8') <= 40)
    }
  } finally {
    h.cleanup()
  }
})

test('msg_seq increases across successive replies to the same message', async () => {
  const h = harness()
  try {
    h.sessions.setReplyTarget('private:U1', 'msg_1')
    await h.outbound.deliver({ key: 'private:U1', kind: 'private', peerId: 'U1', text: '一' })
    await h.outbound.deliver({ key: 'private:U1', kind: 'private', peerId: 'U1', text: '二' })

    assert.deepEqual(h.api.sent.map((entry) => entry.body.msg_seq), [1, 2])
    assert.deepEqual(h.api.sent.map((entry) => entry.body.msg_id), ['msg_1', 'msg_1'])
  } finally {
    h.cleanup()
  }
})

test('the group window allows five replies and then falls back to active sends', async () => {
  const h = harness()
  try {
    h.sessions.setReplyTarget('group:G1', 'msg_g')
    for (let i = 0; i < 6; i += 1) {
      await h.outbound.deliver({ key: 'group:G1', kind: 'group', peerId: 'G1', text: `第${i}条` })
    }
    const bodies = h.api.sent.map((entry) => entry.body)
    assert.equal(bodies.length, 6)
    assert.deepEqual(bodies.slice(0, 5).map((b) => b.msg_seq), [1, 2, 3, 4, 5])
    assert.equal(bodies[5].msg_id, undefined, 'the sixth send has no passive slot left')
    assert.equal(bodies[5].msg_seq, undefined)
  } finally {
    h.cleanup()
  }
})

test('sendActive never attaches a reply target', async () => {
  const h = harness()
  try {
    h.sessions.setReplyTarget('private:U1', 'msg_1')
    await h.outbound.sendActive({ key: 'private:U1', kind: 'private', peerId: 'U1', text: '主动消息' })
    assert.equal(h.api.sent[0].body.msg_id, undefined)
  } finally {
    h.cleanup()
  }
})

test('sends to one conversation stay ordered even when issued concurrently', async () => {
  const h = harness()
  try {
    h.sessions.setReplyTarget('private:U1', 'msg_1')
    await Promise.all([
      h.outbound.deliver({ key: 'private:U1', kind: 'private', peerId: 'U1', text: '第一条' }),
      h.outbound.deliver({ key: 'private:U1', kind: 'private', peerId: 'U1', text: '第二条' }),
      h.outbound.deliver({ key: 'private:U1', kind: 'private', peerId: 'U1', text: '第三条' }),
    ])
    assert.deepEqual(h.api.sent.map((entry) => entry.body.content), ['第一条', '第二条', '第三条'])
  } finally {
    h.cleanup()
  }
})

test('mode never converts markdown to plain text', async () => {
  const h = harness({ markdownMode: 'never' })
  try {
    await h.outbound.sendActive({ key: 'private:U1', kind: 'private', peerId: 'U1', text: '## 标题\n- 项目' })
    assert.equal(h.api.sent[0].body.content, '【标题】\n· 项目')
  } finally {
    h.cleanup()
  }
})

test('mode auto sends prose as markdown but a table as plain text', async () => {
  // The platform renders bold, italics, lists, quotes and rules, but not
  // tables: a table sent as markdown arrives as a row of pipe characters, so
  // the plain-text conversion is the better encoding for exactly that case.
  const h = harness({ markdownMode: 'auto' })
  try {
    await h.outbound.sendActive({ key: 'private:U1', kind: 'private', peerId: 'U1', text: '## 标题\n\n- 一\n- **重点**' })
    assert.equal(h.api.sent[0].body.msg_type, MSG_TYPE.markdown, 'prose is rendered')
    assert.match(h.api.sent[0].body.markdown.content, /## 标题/, 'and keeps its syntax')

    await h.outbound.sendActive({ key: 'private:U1', kind: 'private', peerId: 'U1', text: '| 项 | 值 |\n|---|---|\n| a | 1 |' })
    assert.equal(h.api.sent[1].body.msg_type, MSG_TYPE.text, 'a table falls back to plain text')
  } finally {
    h.cleanup()
  }
})

test('a sentence containing a pipe is not mistaken for a table', async () => {
  const h = harness({ markdownMode: 'auto' })
  try {
    await h.outbound.sendActive({ key: 'private:U1', kind: 'private', peerId: 'U1', text: '用法是 a | b，中间是管道符' })
    assert.equal(h.api.sent[0].body.msg_type, MSG_TYPE.markdown)
  } finally {
    h.cleanup()
  }
})

test('markdown mode sends msg_type 2 with a markdown body', async () => {
  const h = harness({ markdownMode: 'always' })
  try {
    await h.outbound.sendActive({ key: 'private:U1', kind: 'private', peerId: 'U1', text: '## 标题' })
    assert.equal(h.api.sent[0].body.msg_type, MSG_TYPE.markdown)
    assert.deepEqual(h.api.sent[0].body.markdown, { content: '## 标题' })
    assert.equal(h.api.sent[0].body.content, undefined)
  } finally {
    h.cleanup()
  }
})

test('turn output keeps only the last assistant text and emits it at turn end', () => {
  const turns = []
  const collector = new TurnCollector({ onTurnEnd: (sessionId, text) => turns.push({ sessionId, text }), log: () => {} })

  collector.observe('sess_a', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '先看看' }] } } })
  collector.observe('sess_a', { type: 'tool/call', data: { name: 'bash' } })
  collector.observe('sess_a', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '最终答案' }] } } })
  collector.observe('sess_a', { type: 'turn/end', data: { turn: 1, reason: 'stop' } })

  assert.deepEqual(turns, [{ sessionId: 'sess_a', text: '最终答案' }])
  assert.deepEqual(collector.pending(), [], 'the buffer is released at turn end')
})

test('a turn with no assistant text emits nothing', () => {
  const turns = []
  const collector = new TurnCollector({ onTurnEnd: (id, text) => turns.push(text), log: () => {} })
  collector.observe('sess_a', { type: 'turn/end', data: {} })
  assert.deepEqual(turns, [])
})

test('extractText ignores reasoning and tool blocks', () => {
  assert.equal(extractText({ content: [
    { type: 'reasoning', text: '思考' },
    { type: 'text', text: '可见' },
  ] }), '可见')
  assert.equal(extractText({ content: [] }), '')
  assert.equal(extractText(null), '')
})

test('a keyboard forces markdown, because buttons do not render on plain text', async () => {
  const h = harness()
  try {
    h.sessions.setReplyTarget('private:U1', 'msg_1')
    await h.outbound.deliver({
      key: 'private:U1',
      kind: 'private',
      peerId: 'U1',
      text: '选一个',
      keyboard: { content: { rows: [] } },
    })

    // Measured against the live platform: the same keyboard on msg_type 0 is
    // delivered with the buttons silently dropped.
    assert.equal(h.api.sent[0].body.msg_type, MSG_TYPE.markdown)
    assert.deepEqual(h.api.sent[0].body.markdown, { content: '选一个' })
    assert.equal(h.api.sent[0].body.content, undefined)
    assert.ok(h.api.sent[0].body.keyboard, 'the keyboard still rides along')
  } finally {
    h.cleanup()
  }
})

test('a keyboard-less message still follows the markdown setting', async () => {
  const h = harness({ markdownMode: 'never' })
  try {
    await h.outbound.deliver({ key: 'private:U1', kind: 'private', peerId: 'U1', text: '普通消息' })
    assert.equal(h.api.sent[0].body.msg_type, MSG_TYPE.text)
    assert.equal(h.api.sent[0].body.content, '普通消息')
  } finally {
    h.cleanup()
  }
})

test('an event reply target goes out as event_id, with no msg_id beside it', async () => {
  const h = harness()
  try {
    h.sessions.setReplyTarget('private:U1', 'EVENT1', 'event')
    await h.outbound.deliver({ key: 'private:U1', kind: 'private', peerId: 'U1', text: '已选择 1' })

    assert.equal(h.api.sent[0].body.event_id, 'EVENT1')
    assert.equal(h.api.sent[0].body.msg_id, undefined)
    assert.equal(h.api.sent[0].body.msg_seq, undefined, 'msg_seq is scoped to msg_id')
  } finally {
    h.cleanup()
  }
})

test('an invalid reply target is retried as an active message, not lost', async () => {
  // The exact platform answer to a click's event id sent as msg_id.
  const h = harness({}, { failOnce: new Error('QQ POST /v2/groups/G1/messages failed: 请求参数msg_id无效或越权') })
  try {
    h.sessions.setReplyTarget('group:G1', 'EVENT1', 'event')
    await h.outbound.deliver({ key: 'group:G1', kind: 'group', peerId: 'G1', text: '已选择 1' })

    assert.equal(h.api.sent.length, 1, 'the answer is still delivered')
    assert.equal(h.api.sent[0].body.event_id, undefined, 'the dead target is not retried')
    assert.equal(h.sessions.get('group:G1').replyToMessageId, '', 'the dead target is forgotten')
  } finally {
    h.cleanup()
  }
})

test('acknowledging a click is delegated to the OpenAPI client', async () => {
  const h = harness()
  try {
    const acks = []
    h.outbound = new Outbound({
      api: { ackInteraction: async (id, code) => { acks.push({ id, code }) } },
      sessions: h.sessions,
      log: () => {},
      config: () => ({}),
    })
    await h.outbound.ackInteraction('EVENT1', 0)
    await h.outbound.ackInteraction('EVENT2', 4)
    assert.deepEqual(acks, [{ id: 'EVENT1', code: 0 }, { id: 'EVENT2', code: 4 }])
  } finally {
    h.cleanup()
  }
})
