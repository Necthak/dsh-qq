import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionMap } from '../lib/bridge/sessions.js'
import { Outbound, TurnCollector, canRenderAsMarkdown, extractText } from '../lib/bridge/outbound.js'
import { splitByBytes } from '../lib/md-to-plain.js'
import { MSG_TYPE } from '../lib/qq/api.js'

/** A fake OpenAPI client that records every send body. */
function fakeApi({ failOnce = null, uploadFails = false, mediaFails = false } = {}) {
  const sent = []
  const uploads = []
  const media = []
  let failures = failOnce === null ? 0 : 1
  return {
    sent,
    uploads,
    media,
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
    // The upload is recorded before it can fail, so a test can still name the
    // temp file the bridge was supposed to remove.
    async uploadFile(kind, peerId, { data, fileName }) {
      uploads.push({ kind, peerId, data, fileName })
      if (uploadFails) throw new Error('upload refused')
      return 'FILE_INFO'
    },
    async sendFile(kind, peerId, fileInfo) {
      media.push({ kind, peerId, fileInfo })
      if (mediaFails) throw new Error('media send refused')
      return { ok: true }
    },
  }
}

function harness(config = {}, { failOnce = null, uploadFails = false, mediaFails = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-out-'))
  const sessions = new SessionMap({ path: join(dir, 'sessions.json'), log: () => {} })
  sessions.bind('private:U1', 'sess_a')
  sessions.bind('group:G1', 'sess_g')
  const api = fakeApi({ failOnce, uploadFails, mediaFails })
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

/** The body of a recorded send, whichever content field it carries. */
function bodyText(entry) {
  return entry.body.content ?? entry.body.markdown?.content ?? ''
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

test('a markdown table becomes readable lines, because QQ renders none', async () => {
  // The platform supports bold, italics, lists, quotes and rules, but not
  // tables. Before this, both encodings delivered the pipes as they were, so
  // every table this bridge forwarded arrived as a row of vertical bars.
  const h = harness({ markdownMode: 'never' })
  try {
    await h.outbound.sendActive({
      key: 'private:U1',
      kind: 'private',
      peerId: 'U1',
      text: '| 项 | 值 |\n| --- | --- |\n| 余额 | ¥20.23 |',
    })
    const body = h.api.sent[0].body.content
    assert.match(body, /· 项：余额 · 值：¥20\.23/)
    assert.doesNotMatch(body, /\|/, 'no pipes survive')
  } finally {
    h.cleanup()
  }
})

test('a horizontal rule is not mistaken for a table', async () => {
  // The delimiter check ran on a single line, and `---` matched it, so every
  // report containing a rule was classified as a table and converted to plain
  // text: the markdown path was never taken at all. The live A/B test that was
  // supposed to confirm markdown rendering is what exposed this - both of its
  // messages came back looking identical.
  const h = harness({ markdownMode: 'auto' })
  try {
    await h.outbound.sendActive({
      key: 'private:U1',
      kind: 'private',
      peerId: 'U1',
      text: '## 报告\n\n- 一\n\n---\n\n结尾',
    })
    assert.equal(h.api.sent[0].body.msg_type, MSG_TYPE.markdown, 'a rule is not a table')
  } finally {
    h.cleanup()
  }
})

test('a delimiter row under a row of cells is still a table', () => {
  assert.equal(canRenderAsMarkdown('| 项 | 值 |\n| --- | --- |\n| a | 1 |'), false)
  assert.equal(canRenderAsMarkdown('项 | 值\n--- | ---\n1 | 2'), false, 'outer pipes are optional')
  assert.equal(canRenderAsMarkdown('路径 a | b 是管道符'), true, 'a pipe in a sentence is not a table')
})

test('a quoted reply sends its chunks, having no keyboard in scope', async () => {
  // `sendQuoted` prepared its text with an identifier that does not exist in its
  // scope, so every `qq_reply` call threw a ReferenceError before sending
  // anything. The tool tests could not see it: their sender is a double.
  const h = harness({ markdownMode: 'never' })
  try {
    await h.outbound.sendQuoted({ key: 'private:U1', kind: 'private', peerId: 'U1', text: '收到', msgId: 'msg_9', msgSeq: 1 })
    assert.equal(h.api.sent.length, 1)
    assert.equal(h.api.sent[0].body.content, '收到')
    assert.equal(h.api.sent[0].body.msg_id, 'msg_9', 'the quote still rides on the first chunk')
  } finally {
    h.cleanup()
  }
})

// ── a long answer becomes one message and one file ──────────────────────────

/**
 * Build a body of numbered lines.
 *
 * At the fixture's 200-byte budget ten of these lines fill one chunk, so 40
 * lines sit exactly on a limit of 4 and 60 exceed it.
 *
 * @param count - how many lines.
 * @returns The body.
 */
function numberedLines(count) {
  return Array.from({ length: count }, (_, index) => `第 ${String(index)} 行的内容`).join(String.fromCharCode(10))
}

test('an answer beyond the chunk limit is sent as its opening plus one .md file', async () => {
  // Measured on the deployment: a long answer exhausts the passive window
  // ("passive reply window spent" in the log), the rest then spends the active
  // quota, and with active messages switched off the tail is lost outright.
  // One file card is a single send.
  const h = harness({ maxBytes: 200, longAnswerChunks: 4, markdownMode: 'always' })
  try {
    h.sessions.setReplyTarget('private:U1', 'msg_1')
    const text = numberedLines(60)
    assert.ok(splitByBytes(text, 200).length > 4, 'the fixture must exceed the limit')
    await h.outbound.deliver({ key: 'private:U1', kind: 'private', peerId: 'U1', text })

    assert.equal(h.api.sent.length, 1, 'one message, not one per chunk')
    assert.equal(h.api.sent[0].body.msg_id, 'msg_1', 'it still takes the passive reply slot')
    const opening = bodyText(h.api.sent[0])
    assert.match(opening, /^第 0 行的内容/, 'the opening carries the start of the answer')
    assert.ok(Buffer.byteLength(opening, 'utf8') <= 200, 'the notice must not push the opening over the limit')

    assert.equal(h.api.uploads.length, 1)
    const upload = h.api.uploads[0]
    assert.match(upload.fileName, /\.md$/, 'the file is markdown')
    assert.equal(upload.data.toString('utf8'), text, 'the file carries the complete text, not the chunks')
    assert.match(opening, new RegExp(upload.fileName), 'the reader is told which file to open')
    assert.match(opening, /完整内容已作为文件发送/, 'and told that the rest is in it')
    assert.equal(h.api.media.length, 1, 'the file card is what actually reaches QQ')
    assert.equal(existsSync(join(tmpdir(), upload.fileName)), false, 'the temp file is removed after the send')
  } finally {
    h.cleanup()
  }
})

test('a failed upload falls back to sending every chunk rather than losing the answer', async () => {
  const h = harness({ maxBytes: 200, longAnswerChunks: 4, markdownMode: 'always' }, { uploadFails: true })
  try {
    const text = numberedLines(60)
    await h.outbound.deliver({ key: 'private:U1', kind: 'private', peerId: 'U1', text })

    assert.equal(h.api.uploads.length, 1, 'the upload was attempted')
    assert.equal(h.api.media.length, 0, 'and did not produce a file card')
    assert.equal(existsSync(join(tmpdir(), h.api.uploads[0].fileName)), false, 'the temp file goes even when the send fails')
    assert.ok(h.api.sent.length > 4, 'every chunk is sent instead')
    assert.match(h.api.sent.map(bodyText).join('\n'), /第 59 行的内容/, 'including the end of the answer')
    assert.equal(h.outbound.lastFailure, null, 'a delivery that succeeded is not recorded as a failure')
  } finally {
    h.cleanup()
  }
})

test('an answer at the limit is still chunked, and zero turns the file path off', async () => {
  const text = numberedLines(40)
  assert.equal(splitByBytes(text, 200).length, 4, 'the fixture sits exactly on the limit')

  const atLimit = harness({ maxBytes: 200, longAnswerChunks: 4 })
  try {
    await atLimit.outbound.sendActive({ key: 'private:U1', kind: 'private', peerId: 'U1', text })
    assert.equal(atLimit.api.sent.length, 4, 'the limit is "more than", not "at least"')
    assert.equal(atLimit.api.uploads.length, 0)
  } finally {
    atLimit.cleanup()
  }

  const disabled = harness({ maxBytes: 200, longAnswerChunks: 0 })
  try {
    await disabled.outbound.sendActive({ key: 'private:U1', kind: 'private', peerId: 'U1', text })
    assert.equal(disabled.api.sent.length, 4)
    assert.equal(disabled.api.uploads.length, 0, 'zero disables the file path')
  } finally {
    disabled.cleanup()
  }
})

test('a file card that cannot be sent also falls back, and leaves no temp file behind', async () => {
  // The send endpoint can fail after a successful upload. Nothing was delivered
  // then, so the chunks are still safe to send — and the opening must not claim
  // a file that never arrived.
  const h = harness({ maxBytes: 200, longAnswerChunks: 4 }, { mediaFails: true })
  try {
    const text = numberedLines(60)
    await h.outbound.deliver({ key: 'private:U1', kind: 'private', peerId: 'U1', text })
    assert.equal(h.api.uploads.length, 1)
    assert.equal(h.api.media.length, 1, 'the card was attempted')
    assert.equal(existsSync(join(tmpdir(), h.api.uploads[0].fileName)), false)
    assert.ok(h.api.sent.length > 4, 'the answer still arrives as chunks')
    assert.doesNotMatch(h.api.sent.map(bodyText).join('\n'), /完整内容已作为文件发送/, 'and nothing claims otherwise')
  } finally {
    h.cleanup()
  }
})
