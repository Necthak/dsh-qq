import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { QqApi, QqApiError, MSG_TYPE, buildMessageBody } from '../lib/qq/api.js'

/** A token provider that always answers immediately. */
const tokens = { get: async () => 'TOKEN', invalidate: () => {} }

/** Build a fetch stub returning one scripted response per call. */
function stubFetch(responses) {
  const calls = []
  const impl = async (url, init) => {
    // Rich-media parts are PUT as raw bytes, so the recorded body is only
    // parsed when the caller actually sent JSON.
    const body = init.body === undefined
      ? undefined
      : typeof init.body === 'string' ? JSON.parse(init.body) : Buffer.from(init.body).toString()
    calls.push({ url, method: init.method, headers: init.headers, body })
    const next = responses.shift()
    if (next === undefined) throw new Error('unexpected extra request')
    return {
      status: next.status ?? 200,
      statusText: next.statusText ?? 'OK',
      text: async () => JSON.stringify(next.body ?? {}),
    }
  }
  impl.calls = calls
  return impl
}

test('buildMessageBody produces a passive reply with an increasing msg_seq', () => {
  assert.deepEqual(buildMessageBody({ text: 'hi', replyToMessageId: 'm1', msgSeq: 3 }), {
    msg_type: MSG_TYPE.text,
    content: 'hi',
    msg_id: 'm1',
    msg_seq: 3,
  })
})

test('buildMessageBody omits the reply fields for an active message', () => {
  const body = buildMessageBody({ text: 'hi' })
  assert.equal(body.msg_id, undefined)
  assert.equal(body.msg_seq, undefined)
})

test('buildMessageBody prefers markdown when given', () => {
  const body = buildMessageBody({ text: 'ignored', markdown: '## hi' })
  assert.equal(body.msg_type, MSG_TYPE.markdown)
  assert.deepEqual(body.markdown, { content: '## hi' })
  assert.equal(body.content, undefined)
})

test('a send carrying a message id is accepted', async () => {
  const fetchImpl = stubFetch([{ body: { id: 'ROBOT1.0_x', timestamp: '2026-09-12T12:00:00+08:00' } }])
  const api = new QqApi({ tokens, fetchImpl, baseUrl: 'https://example.test' })

  const result = await api.sendC2C('U1', { msg_type: 0, content: 'hi' })
  assert.equal(result.id, 'ROBOT1.0_x')
  assert.equal(fetchImpl.calls[0].headers.Authorization, 'QQBot TOKEN')
  assert.match(fetchImpl.calls[0].url, /\/v2\/users\/U1\/messages$/)
})

test('a 200 response with no message id is treated as a failure', async () => {
  // Observed platform behaviour: HTTP 200 with a body that acknowledges nothing
  // while the message was never delivered. Silence here would lose the answer.
  const fetchImpl = stubFetch([{ body: { code: 0 } }])
  const api = new QqApi({ tokens, fetchImpl, baseUrl: 'https://example.test' })

  await assert.rejects(
    () => api.sendC2C('U1', { msg_type: 0, content: 'hi' }),
    (error) => {
      assert.ok(error instanceof QqApiError)
      assert.match(error.message, /without a message id/)
      return true
    },
  )
})

test('a non-zero platform code raises with that code', async () => {
  const fetchImpl = stubFetch([{ body: { code: 11253, message: 'rate limited' } }])
  const api = new QqApi({ tokens, fetchImpl, baseUrl: 'https://example.test' })

  await assert.rejects(
    () => api.sendGroup('G1', { msg_type: 0, content: 'hi' }),
    (error) => {
      assert.equal(error.code, 11253)
      assert.equal(error.rateLimited, true)
      return true
    },
  )
})

test('an authentication failure refreshes the token and retries once', async () => {
  let invalidated = 0
  const rotatingTokens = {
    get: async () => 'TOKEN',
    invalidate: () => { invalidated += 1 },
  }
  const fetchImpl = stubFetch([
    { status: 401, body: { message: 'unauthorized' } },
    { body: { id: 'ROBOT1.0_y' } },
  ])
  const api = new QqApi({ tokens: rotatingTokens, fetchImpl, baseUrl: 'https://example.test' })

  const result = await api.sendC2C('U1', { msg_type: 0, content: 'hi' })
  assert.equal(result.id, 'ROBOT1.0_y')
  assert.equal(invalidated, 1)
  assert.equal(fetchImpl.calls.length, 2)
})

test('a second authentication failure is surfaced rather than retried forever', async () => {
  const fetchImpl = stubFetch([
    { status: 401, body: { message: 'unauthorized' } },
    { status: 401, body: { message: 'still unauthorized' } },
  ])
  const api = new QqApi({ tokens, fetchImpl, baseUrl: 'https://example.test' })

  await assert.rejects(() => api.sendC2C('U1', { msg_type: 0, content: 'hi' }), QqApiError)
  assert.equal(fetchImpl.calls.length, 2)
})

test('the gateway endpoint returns the socket URL', async () => {
  const fetchImpl = stubFetch([{ body: { url: 'wss://api.bot.qq.com/websocket/' } }])
  const api = new QqApi({ tokens, fetchImpl, baseUrl: 'https://example.test' })
  assert.equal(await api.getGateway(), 'wss://api.bot.qq.com/websocket/')
})

test('a gateway response without a url is refused', async () => {
  const fetchImpl = stubFetch([{ body: {} }])
  const api = new QqApi({ tokens, fetchImpl, baseUrl: 'https://example.test' })
  await assert.rejects(() => api.getGateway(), QqApiError)
})

test('buildMessageBody answers an event with event_id, never msg_id', () => {
  // A click's id is an EVENT id. Sending it as msg_id is refused with
  // 40034024 请求参数msg_id无效或越权, which is what a tapped button used to get.
  assert.deepEqual(buildMessageBody({ text: 'hi', eventId: 'EVENT1' }), {
    msg_type: MSG_TYPE.text,
    content: 'hi',
    event_id: 'EVENT1',
  })
})

test('buildMessageBody prefers the message target when both are known', () => {
  const body = buildMessageBody({ text: 'hi', replyToMessageId: 'm1', msgSeq: 2, eventId: 'EVENT1' })
  assert.equal(body.msg_id, 'm1')
  assert.equal(body.msg_seq, 2)
  assert.equal(body.event_id, undefined, 'the platform takes one passive target, not two')
})

test('an interaction is acknowledged with PUT and the outcome code', async () => {
  const fetchImpl = stubFetch([{ body: {} }])
  const api = new QqApi({ tokens, fetchImpl, baseUrl: 'https://example.test' })

  // An empty body is the documented success response, so the message-id check
  // that guards sends must not apply here.
  assert.deepEqual(await api.ackInteraction('a1b2c3', 0), {})
  assert.equal(fetchImpl.calls[0].method, 'PUT')
  assert.match(fetchImpl.calls[0].url, /\/interactions\/a1b2c3$/)
  assert.deepEqual(fetchImpl.calls[0].body, { code: 0 })
})

test('an interaction id carrying the event-name prefix is stripped', async () => {
  const fetchImpl = stubFetch([{ body: {} }])
  const api = new QqApi({ tokens, fetchImpl, baseUrl: 'https://example.test' })

  await api.ackInteraction('INTERACTION_CREATE:a1b2c3', 4)
  assert.match(fetchImpl.calls[0].url, /\/interactions\/a1b2c3$/)
  assert.deepEqual(fetchImpl.calls[0].body, { code: 4 })
})

test('acknowledging without an interaction id fails before any request', async () => {
  const fetchImpl = stubFetch([])
  const api = new QqApi({ tokens, fetchImpl, baseUrl: 'https://example.test' })
  await assert.rejects(() => api.ackInteraction('', 0), QqApiError)
  assert.equal(fetchImpl.calls.length, 0)
})

// ── rich media ──────────────────────────────────────────────────────────────

test('a local image is hashed, prepared, uploaded in parts, merged, then sent', async () => {
  const image = Buffer.from('fake png bytes for the upload path')
  const fetchImpl = stubFetch([
    // upload_prepare
    {
      body: {
        upload_id: 'UP1',
        block_size: '16',
        // 34 bytes over 16-byte blocks: the third part is the 2-byte remainder.
        // The indices are 1-based because that is what the LIVE platform
        // returns, documentation notwithstanding — and a positional slice
        // computed from them is what uploaded zero bytes for every part.
        parts: [
          { index: 1, presigned_url: 'https://cos.test/part0', block_size: '16' },
          { index: 2, presigned_url: 'https://cos.test/part1', block_size: '16' },
          { index: 3, presigned_url: 'https://cos.test/part2', block_size: '2' },
        ],
      },
    },
    { status: 200, body: {} },                       // PUT part 0 (raw)
    { body: {} },                                    // upload_part_finish 0
    { status: 200, body: {} },                       // PUT part 1
    { body: {} },                                    // upload_part_finish 1
    { status: 200, body: {} },                       // PUT part 2 (remainder)
    { body: {} },                                    // upload_part_finish 2
    { body: { file_info: 'FILEINFO', ttl: 3600 } },  // merge
    { body: { id: 'ROBOT1.0_img' } },                // send
  ])
  const api = new QqApi({ tokens, fetchImpl, baseUrl: 'https://example.test' })

  const info = await api.uploadImage('group', 'G1', { data: image, fileName: 'shot.png' })
  assert.equal(info, 'FILEINFO')
  await api.sendImage('group', 'G1', info)

  const prepare = fetchImpl.calls[0]
  assert.match(prepare.url, /\/v2\/groups\/G1\/upload_prepare$/)
  assert.equal(prepare.body.file_type, 1)
  assert.equal(prepare.body.file_size, String(image.byteLength), 'the platform takes the size as a string')
  assert.equal(prepare.body.file_name, 'shot.png')
  assert.equal(prepare.body.md5, createHash('md5').update(image).digest('hex'))
  assert.equal(prepare.body.sha1, createHash('sha1').update(image).digest('hex'))

  // Parts go to the presigned URL with NO Authorization header, and in index
  // order: the upload is positional, so a swapped part corrupts the image.
  const puts = fetchImpl.calls.filter((call) => call.method === 'PUT')
  assert.deepEqual(puts.map((call) => call.url), ['https://cos.test/part0', 'https://cos.test/part1', 'https://cos.test/part2'])
  assert.equal(puts.at(-1).body, image.subarray(32).toString(), 'the tail is uploaded, not dropped')
  assert.equal(puts[0].headers, undefined, 'the presigned URL carries its own authorization')
  assert.equal(puts[0].body, image.subarray(0, 16).toString())

  const finishes = fetchImpl.calls.filter((call) => /upload_part_finish$/.test(call.url))
  assert.deepEqual(finishes.map((call) => call.body.part_index), [1, 2, 3], 'the platform index is echoed back verbatim')
  assert.deepEqual(finishes.map((call) => call.body.block_size), ['16', '16', '2'], 'no part may be empty')
  assert.equal(puts[0].body, image.subarray(0, 16).toString(), 'the first part is the head of the file')
  assert.equal(finishes[1].body.md5, createHash('md5').update(image.subarray(16, 32)).digest('hex'))
  assert.equal(finishes[2].body.block_size, '2', 'each part reports its own size')

  const merge = fetchImpl.calls.find((call) => /\/files$/.test(call.url))
  assert.equal(merge.body.upload_id, 'UP1')
  assert.equal(merge.body.srv_send_msg, false, 'the merge must not also send a message')

  const sent = fetchImpl.calls.at(-1)
  assert.equal(sent.body.msg_type, MSG_TYPE.media)
  assert.deepEqual(sent.body.media, { file_info: 'FILEINFO' })
})

test('a private conversation uploads through the user path', async () => {
  const fetchImpl = stubFetch([
    { body: { upload_id: 'UP2', block_size: '4', parts: [{ index: 0, presigned_url: 'https://cos.test/u0' }] } },
    { status: 200, body: {} },
    { body: {} },
    { body: { file_info: 'F2' } },
  ])
  const api = new QqApi({ tokens, fetchImpl, baseUrl: 'https://example.test' })
  await api.uploadImage('private', 'U1', { data: Buffer.from('abcd'), fileName: 'a.png' })
  assert.match(fetchImpl.calls[0].url, /\/v2\/users\/U1\/upload_prepare$/)
})

test('a prepare response without parts is refused instead of uploading nothing', async () => {
  const fetchImpl = stubFetch([{ body: { upload_id: 'UP3' } }])
  const api = new QqApi({ tokens, fetchImpl, baseUrl: 'https://example.test' })
  await assert.rejects(() => api.uploadImage('group', 'G1', { data: Buffer.from('x'), fileName: 'x.png' }), /upload id or parts/)
})

test('a rejected part PUT stops the upload', async () => {
  const fetchImpl = stubFetch([
    { body: { upload_id: 'UP4', block_size: '4', parts: [{ index: 0, presigned_url: 'https://cos.test/p0' }] } },
    { status: 403, body: {} },
  ])
  const api = new QqApi({ tokens, fetchImpl, baseUrl: 'https://example.test' })
  await assert.rejects(() => api.uploadImage('group', 'G1', { data: Buffer.from('abcd'), fileName: 'x.png' }), /HTTP 403/)
})

// ── deadlines ───────────────────────────────────────────────────────────────

/** A fetch that never answers, and rejects only when its signal is aborted. */
function hangingFetch() {
  return (url, options = {}) => new Promise((resolve, reject) => {
    const signal = options.signal
    if (signal === undefined) return   // no signal: hang forever, which is the bug
    if (signal.aborted) { reject(new Error('aborted')); return }
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
}

test('a stalled request is abandoned instead of hanging forever', async () => {
  // Without a deadline a stalled call never settles: nothing retries, nothing is
  // logged, and the channel is silently mute. That is exactly how a restart once
  // left the bot unresponsive for fifteen minutes.
  const tokens = { get: async () => 'token', invalidate: () => {} }
  const api = new QqApi({ tokens, fetchImpl: hangingFetch(), log: () => {}, timeoutMs: 20 })
  const started = Date.now()
  await assert.rejects(() => api.getGateway(), /abort|timed out|failed/i)
  const took = Date.now() - started
  assert.ok(took < 2_000, `it gave up quickly (took ${String(took)}ms)`)
})

test('every request carries a deadline', async () => {
  const seen = []
  const tokens = { get: async () => 'token', invalidate: () => {} }
  const api = new QqApi({
    tokens,
    log: () => {},
    timeoutMs: 5_000,
    fetchImpl: async (url, options = {}) => {
      seen.push(options.signal !== undefined)
      return { status: 200, statusText: 'OK', text: async () => JSON.stringify({ url: 'wss://example.test' }) }
    },
  })
  await api.getGateway()
  assert.deepEqual(seen, [true], 'the request was issued with a timeout signal')
})

test('an upload part gets the longer deadline, not the API one', async () => {
  const seen = []
  const tokens = { get: async () => 'token', invalidate: () => {} }
  const api = new QqApi({
    tokens,
    log: () => {},
    timeoutMs: 5_000,
    uploadTimeoutMs: 60_000,
    fetchImpl: async (url, options = {}) => {
      seen.push({ method: options.method, hasSignal: options.signal !== undefined })
      const body = options.method === 'PUT'
        ? {}
        : url.endsWith('/upload_prepare')
          ? { upload_id: 'u1', block_size: '4', parts: [{ index: 1, presigned_url: 'https://up/1' }] }
          : { file_info: 'fi' }
      return { status: 200, statusText: 'OK', text: async () => JSON.stringify(body) }
    },
  })
  await api.uploadFile('group', 'G', { data: Buffer.from('abcd'), fileName: 'a.txt' })
  const put = seen.find((entry) => entry.method === 'PUT')
  assert.ok(put !== undefined && put.hasSignal, 'the chunk upload is bounded too')
})

test('panel calls use the /v2 prefix every other API call uses', async () => {
  // The first version asked for `/panels`, and the platform answered
  // "不支持的调用" - an unsupported call - because the base URL carries no
  // version segment and each path must bring its own. This asserts the paths
  // rather than the behaviour, because that is what was wrong.
  const fetchImpl = stubFetch([
    { body: { records: [] } },
    { body: { panel_id: 'p_1' } },
    { body: { code: 0 } },
  ])
  const api = new QqApi({ tokens, fetchImpl, baseUrl: 'https://example.test' })
  await api.listPanels('group')
  await api.createPanel({ scope: 'group', target_type: 'specific', group_openids: ['G'], panel: { items: [], remark: 'dsh-qq' } })
  await api.updatePanel('p_1', { items: [], remark: 'dsh-qq' })

  const calls = fetchImpl.calls
  assert.equal(calls[0].method, 'GET')
  assert.match(calls[0].url, /\/v2\/panels\?scope=group$/, 'scope is required: without it the platform answers 40030011')
  assert.equal(calls[1].method, 'POST')
  assert.match(calls[1].url, /\/v2\/panels$/)
  assert.equal(calls[2].method, 'PUT')
  assert.match(calls[2].url, /\/v2\/panels\/p_1$/)
  assert.equal(calls[1].body.scope, 'group')
  assert.equal(calls[1].body.panel.remark, 'dsh-qq')
  assert.equal(calls[2].body.panel.remark, 'dsh-qq', 'the update wraps the panel, not the item list')
})
