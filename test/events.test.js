import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EVENT_C2C,
  EVENT_GROUP_AT,
  buildPromptText,
  describeArk,
  describeAttachments,
  extractQuote,
  imageAttachments,
  normalizeAttachments,
  normalizeMessage,
  parseSceneExt,
} from '../lib/qq/events.js'

const C2C = {
  id: 'ROBOT1.0_abc',
  author: { id: 'A1', user_openid: 'USER_OPENID', username: '小明', bot: false },
  content: '你好',
  timestamp: '2026-09-12T04:00:00Z',
  message_type: 0,
  message_scene: { source: 'default', ext: ['msg_idx=REFIDX_1==', 'auth_token=TOK'] },
}

const GROUP = {
  id: 'ROBOT1.0_def',
  author: { id: 'B1', member_openid: 'MEMBER_OPENID', username: '小红', member_role: 'admin' },
  group_openid: 'GROUP_OPENID',
  content: '在吗',
  timestamp: '2026-09-12T04:01:00Z',
  message_type: 0,
}

test('parseSceneExt turns the key=value list into an object', () => {
  assert.deepEqual(parseSceneExt(['msg_idx=X==', 'auth_token=T', 'noequals']), { msg_idx: 'X==', auth_token: 'T' })
  assert.deepEqual(parseSceneExt(undefined), {})
})

test('a private message normalizes with the user OpenID as the send target', () => {
  const message = normalizeMessage(EVENT_C2C, C2C)
  assert.equal(message.kind, 'private')
  assert.equal(message.peerId, 'USER_OPENID')
  assert.equal(message.userId, 'USER_OPENID')
  assert.equal(message.userName, '小明')
  assert.equal(message.messageId, 'ROBOT1.0_abc')
  assert.equal(message.text, '你好')
  assert.equal(message.authToken, 'TOK')
})

test('a group @-message normalizes with the group OpenID as the send target', () => {
  const message = normalizeMessage(EVENT_GROUP_AT, GROUP)
  assert.equal(message.kind, 'group')
  assert.equal(message.peerId, 'GROUP_OPENID')
  assert.equal(message.userId, 'MEMBER_OPENID')
  assert.equal(message.memberRole, 'admin')
})

test('unknown dispatches and malformed bodies are ignored', () => {
  assert.equal(normalizeMessage('SOMETHING_ELSE', C2C), null)
  assert.equal(normalizeMessage(EVENT_C2C, null), null)
  // No OpenID means there is no one to answer, so the message is unusable.
  assert.equal(normalizeMessage(EVENT_C2C, { id: 'x', author: {} }), null)
})

test('a quote resolves the referenced element by ref_msg_idx', () => {
  const quoted = extractQuote({
    message_type: 103,
    message_scene: { ext: ['ref_msg_idx=IDX2'] },
    msg_elements: [
      { msg_idx: 'IDX1', author: { username: '甲' }, content: '第一条' },
      { msg_idx: 'IDX2', author: { username: '乙' }, content: '第二条' },
    ],
  })
  assert.deepEqual(quoted, { author: '乙', content: '第二条' })
})

test('a quote without a matching index falls back to the first element', () => {
  const quoted = extractQuote({
    message_type: 103,
    message_scene: { ext: [] },
    msg_elements: [{ msg_idx: 'IDX1', author: { username: '甲' }, content: '只有一条' }],
  })
  assert.deepEqual(quoted, { author: '甲', content: '只有一条' })
})

test('a non-quote message carries no quote', () => {
  assert.equal(extractQuote(C2C), null)
})

test('attachments classify images and keep the voice transcode', () => {
  const list = normalizeAttachments([
    { url: 'https://x/1.png', content_type: 'image/png', filename: 'a.png', width: 10, height: 20 },
    { url: 'https://x/2.silk', content_type: 'voice', voice_wav_url: 'https://x/2.wav', asr_refer_text: '你好' },
    { url: '', content_type: 'image/png' },
  ])
  assert.equal(list.length, 2, 'an attachment without a URL is dropped')
  assert.equal(list[0].isImage, true)
  assert.equal(list[1].isImage, false)
  assert.equal(list[1].asrText, '你好')
})

test('non-image attachments are announced in the prompt text', () => {
  const list = normalizeAttachments([
    { url: 'https://x/1.png', content_type: 'image/png' },
    { url: 'https://x/2.zip', content_type: 'file', filename: '报告.zip', size: 2048 },
    { url: 'https://x/3.silk', content_type: 'voice', asr_refer_text: '喂' },
  ])
  const text = describeAttachments(list)
  assert.match(text, /附件：报告\.zip 2KB/)
  assert.match(text, /语音消息 转写：喂/)
  assert.doesNotMatch(text, /1\.png/, 'images travel as real image blocks, not as text')
})

test('the prompt text names the group speaker and the quoted message', () => {
  const message = normalizeMessage(EVENT_GROUP_AT, {
    ...GROUP,
    message_type: 103,
    message_scene: { ext: ['ref_msg_idx=I1'] },
    msg_elements: [{ msg_idx: 'I1', author: { username: '小刚' }, content: '原文' }],
  })
  const text = buildPromptText(message)
  assert.match(text, /\[QQ群 小红\]/)
  assert.match(text, /\[引用 小刚：原文\]/)
  assert.match(text, /在吗/)
})

test('an empty message still produces a placeholder rather than an empty prompt', () => {
  const message = normalizeMessage(EVENT_C2C, { ...C2C, content: '' })
  assert.equal(buildPromptText(message), '（空消息）')
})

test('a card message is summarized because the model cannot read it', () => {
  const described = describeArk({
    prompt: '[分享]',
    ark_name: '图文卡片',
    fields: { title: '标题', desc: '描述', source: '来源' },
  })
  assert.match(described, /\[分享\]/)
  assert.match(described, /图文卡片 标题/)
  assert.match(described, /来源：来源/)
})

test('only image attachments are offered as inline blocks', () => {
  const message = normalizeMessage(EVENT_C2C, {
    ...C2C,
    attachments: [
      { url: 'https://x/1.png', content_type: 'image/png' },
      { url: 'https://x/2.mp4', content_type: 'video/mp4' },
    ],
  })
  const images = imageAttachments(message)
  assert.equal(images.length, 1)
  assert.equal(images[0].contentType, 'image/png')
})

test('a full-mode group message normalizes exactly like an @-mention', () => {
  const body = {
    id: 'ROBOT1.0_x',
    group_openid: 'GROUP1',
    content: '大家早上好呀',
    timestamp: '2026-09-12T08:00:00+08:00',
    author: { member_openid: 'MEMBER1', username: '小明', member_role: 'member' },
  }

  const at = normalizeMessage('GROUP_AT_MESSAGE_CREATE', body)
  const all = normalizeMessage('GROUP_MESSAGE_CREATE', body)

  assert.deepEqual(all, at, 'the platform documents the bodies as identical')
  assert.equal(all.kind, 'group')
  assert.equal(all.peerId, 'GROUP1', 'the group is still the send target')
  assert.equal(all.userId, 'MEMBER1', 'and the member is still the sender')
})

test('an event the bridge does not consume is still dropped', () => {
  assert.equal(normalizeMessage('GROUP_ADD_ROBOT', { group_openid: 'G1' }), null)
  assert.equal(normalizeMessage('C2C_MSG_RECEIVE', {}), null)
})
