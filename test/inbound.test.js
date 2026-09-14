import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionMap } from '../lib/bridge/sessions.js'
import { PendingInteractions } from '../lib/bridge/pending.js'
import { COMMAND_NAMES, createInboundHandler, shortcutCommand } from '../lib/bridge/inbound.js'
import { createSessionCommands } from '../lib/bridge/commands.js'

/** A normalized private message. */
let messageCounter = 0

function message(overrides = {}) {
  // Every real delivery carries its own id, and the bridge now drops a repeated
  // id as a platform redelivery. A fixed id here would make the second message
  // in any test look like a duplicate of the first.
  messageCounter += 1
  return {
    kind: 'private',
    peerId: 'OWNER',
    userId: 'OWNER',
    userName: '甲',
    messageId: `ROBOT1.0_${String(messageCounter)}`,
    text: '你好',
    attachments: [],
    ark: '',
    ...overrides,
  }
}

function harness({ settings = {}, promptFails = false, busy } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-in-'))
  const sessions = new SessionMap({ path: join(dir, 'sessions.json'), log: () => {} })
  const prompts = []
  const sent = []
  const controller = new AbortController()

  const ctx = {
    sessionController: {
      // Mirrors the real controller: the second argument is dereferenced
      // immediately, so a caller that forgets it fails loudly here too.
      prompt: async (request, signal) => {
        signal.throwIfAborted()
        if (promptFails) throw new Error('prompt refused')
        prompts.push({ request, signal })
        return { accepted: true }
      },
    },
  }

  const handler = createInboundHandler({
    ctx,
    sessions,
    outbound: {
      deliver: async (job) => { sent.push(job) },
      sendActive: async (job) => { sent.push(job) },
    },
    pending: new PendingInteractions({ log: () => {} }),
    config: () => ({ mode: 'closed-agent', ownerOpenId: 'OWNER', ...settings }),
    log: () => {},
    ensureSession: async (key) => { sessions.bind(key, 'sess_1'); return 'sess_1' },
    fetchImpl: async () => { throw new Error('no network expected') },
    status: () => ({ gateway: 'online', conversations: 1, pending: 0 }),
    busy,
    signal: controller.signal,
  })

  return { handler, prompts, sent, sessions, controller, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('an admitted message is delivered with a cancellation signal', async () => {
  const h = harness()
  try {
    await h.handler(message())

    assert.equal(h.prompts.length, 1)
    const { request, signal } = h.prompts[0]
    assert.equal(request.sessionId, 'sess_1')
    assert.equal(request.mode, 'queue')
    assert.deepEqual(request.content, [{ type: 'text', text: '你好' }])
    assert.ok(signal instanceof AbortSignal, 'the Session Controller requires a real AbortSignal')
    assert.equal(signal.aborted, false)
  } finally {
    h.cleanup()
  }
})

test('every admitted message arms the reply cursor, commands included', async () => {
  const h = harness()
  try {
    await h.handler(message())
    assert.match(h.sessions.get('private:OWNER').replyToMessageId, /^ROBOT1\.0_/)

    // A command is answered by the bridge, but its answer is still a reply to
    // this message — and it used to leave the cursor on an older message, which
    // the platform then refused once that message's window closed.
    await h.handler(message({ text: '/status', messageId: 'ROBOT1.0_cmd' }))
    assert.equal(h.sessions.get('private:OWNER').replyToMessageId, 'ROBOT1.0_cmd')
  } finally {
    h.cleanup()
  }
})

test('a refused prompt leaves a fresh reply target, never a stale one', async () => {
  const h = harness({ promptFails: true })
  try {
    await h.handler(message())
    assert.equal(h.prompts.length, 0)
    const record = h.sessions.get('private:OWNER')
    assert.match(record?.replyToMessageId ?? '', /^ROBOT1\.0_/, 'the cursor points at the newest message, refused or not')
    assert.equal(h.sent.length, 1, 'the user is told the request was refused')
    assert.match(h.sent[0].text, /DSH 拒绝了这个请求/)
  } finally {
    h.cleanup()
  }
})

test('the request id is reduced to a safe alphabet', async () => {
  const h = harness()
  try {
    // Ids from other layers may carry separators such as `:`; they must not
    // survive into an identity other systems parse.
    await h.handler(message({ messageId: 'a:b/c d' }))
    assert.equal(h.prompts[0].request.requestId, 'qq-a_b_c_d')
  } finally {
    h.cleanup()
  }
})

test('a message with no id still gets a usable request id', async () => {
  const h = harness()
  try {
    await h.handler(message({ messageId: '' }))
    assert.match(h.prompts[0].request.requestId, /^qq-\d+$/)
  } finally {
    h.cleanup()
  }
})

test('a sender outside the admission rules never reaches the agent', async () => {
  const h = harness()
  const rejected = []
  try {
    const handler = createInboundHandler({
      ctx: { sessionController: { prompt: async () => { throw new Error('must not be called') } } },
      sessions: h.sessions,
      outbound: { deliver: async () => {}, sendActive: async () => {} },
      pending: new PendingInteractions({ log: () => {} }),
      config: () => ({ mode: 'closed-agent', ownerOpenId: 'OWNER' }),
      log: () => {},
      ensureSession: async () => 'sess_1',
      status: () => ({}),
      signal: h.controller.signal,
      onRejected: (m) => rejected.push(m),
    })
    await handler(message({ peerId: 'STRANGER', userId: 'STRANGER' }))
    assert.equal(rejected.length, 1, 'the refusal is recorded so the operator can allow it')
    assert.equal(rejected[0].userId, 'STRANGER')
  } finally {
    h.cleanup()
  }
})

test('/status answers without reaching the agent', async () => {
  const h = harness()
  try {
    await h.handler(message({ text: '/status' }))
    assert.equal(h.prompts.length, 0)
    assert.equal(h.sent.length, 1)
    assert.match(h.sent[0].text, /QQ 通道：online/)
  } finally {
    h.cleanup()
  }
})

test('/reset is refused for a non-owner', async () => {
  // `/new` and `/reset` are session administration, so they live with the other
  // administration commands — which means this handler needs them wired, as the
  // plugin always does.
  const h = harness({ settings: { mode: 'chat', allow: ['MEMBER'], ownerOpenId: 'OWNER' } })
  try {
    const handler = createInboundHandler({
      ctx: { sessionController: { prompt: async () => { throw new Error('must not be called') } } },
      sessions: h.sessions,
      outbound: { deliver: async (job) => { h.sent.push(job) }, sendActive: async (job) => { h.sent.push(job) } },
      pending: new PendingInteractions({ log: () => {} }),
      commands: createSessionCommands({
        ctx: {},
        sessions: h.sessions,
        pending: new PendingInteractions({ log: () => {} }),
        settingsScope: { update: async () => {} },
        log: () => {},
      }),
      config: () => ({ mode: 'chat', allow: ['MEMBER'], ownerOpenId: 'OWNER' }),
      log: () => {},
      ensureSession: async () => 'sess_1',
      status: () => ({}),
      signal: h.controller.signal,
    })
    await handler(message({ kind: 'group', peerId: 'GROUP', userId: 'MEMBER', text: '/reset' }))
    assert.equal(h.prompts.length, 0)
    assert.match(h.sent[0].text, /只有 owner/)
  } finally {
    h.cleanup()
  }
})

test('an open approval consumes the next message instead of prompting', async () => {
  const h = harness()
  try {
    const pending = new PendingInteractions({ log: () => {} })
    const handler = createInboundHandler({
      ctx: { sessionController: { prompt: async () => { throw new Error('must not be called') } } },
      sessions: h.sessions,
      outbound: { deliver: async () => {}, sendActive: async () => {} },
      pending,
      config: () => ({ mode: 'closed-agent', ownerOpenId: 'OWNER' }),
      log: () => {},
      ensureSession: async () => 'sess_1',
      status: () => ({}),
      signal: h.controller.signal,
    })
    const decision = pending.open('private:OWNER', {
      kind: 'approval',
      timeoutMs: 1_000,
      parse: (text) => (text === '通过' ? 'allowed-once' : undefined),
    })
    await handler(message({ text: '通过' }))
    assert.equal(await decision, 'allowed-once')
  } finally {
    h.cleanup()
  }
})

test('a message sent while the turn runs is inserted into it', async () => {
  const h = harness({ busy: () => true })
  try {
    await h.handler(message({ text: '顺便看一下测试' }))
    assert.equal(h.prompts.length, 1)
    assert.equal(h.prompts[0].request.mode, 'steer', 'the running turn reads it at the next step boundary')
    assert.deepEqual(h.prompts[0].request.content, [{ type: 'text', text: '顺便看一下测试' }])
  } finally {
    h.cleanup()
  }
})

test('an idle session queues, and so does an unreadable agent registry', async () => {
  for (const busy of [() => false, () => null, undefined]) {
    const h = harness({ busy })
    try {
      await h.handler(message())
      assert.equal(h.prompts[0].request.mode, 'queue', 'queueing is the behaviour that cannot be wrong, only slow')
    } finally {
      h.cleanup()
    }
  }
})

test('the queue policy keeps messages behind the running turn', async () => {
  const h = harness({ busy: () => true, settings: { busyDelivery: 'queue' } })
  try {
    await h.handler(message())
    assert.equal(h.prompts[0].request.mode, 'queue')
  } finally {
    h.cleanup()
  }
})

test('/steer inserts even when the deployment queues, and strips the prefix', async () => {
  const h = harness({ busy: () => false, settings: { busyDelivery: 'queue' } })
  try {
    await h.handler(message({ text: '/steer 换个思路' }))
    assert.equal(h.prompts.length, 1)
    assert.equal(h.prompts[0].request.mode, 'steer')
    assert.deepEqual(h.prompts[0].request.content, [{ type: 'text', text: '换个思路' }])
  } finally {
    h.cleanup()
  }
})

test('/queue holds a message back even while the turn runs', async () => {
  const h = harness({ busy: () => true })
  try {
    await h.handler(message({ text: '/queue 等我说完' }))
    assert.equal(h.prompts[0].request.mode, 'queue')
    assert.deepEqual(h.prompts[0].request.content, [{ type: 'text', text: '等我说完' }])
  } finally {
    h.cleanup()
  }
})

test('an override with no content is answered with usage, not prompted', async () => {
  const h = harness({ busy: () => true })
  try {
    await h.handler(message({ text: '/steer' }))
    assert.equal(h.prompts.length, 0)
    assert.equal(h.sent.length, 1)
    assert.match(h.sent[0].text, /用法/)
  } finally {
    h.cleanup()
  }
})

test('a group message is inserted exactly like a private one', async () => {
  const h = harness({ busy: () => true, settings: { mode: 'chat', allow: ['GROUP'] } })
  try {
    await h.handler(message({ kind: 'group', peerId: 'GROUP', userId: 'MEMBER', userName: '乙', text: '插一句' }))
    assert.equal(h.prompts.length, 1)
    assert.equal(h.prompts[0].request.mode, 'steer', 'the delivery decision never consults the chat kind')
  } finally {
    h.cleanup()
  }
})

test('an override is never consumed as the answer to an open interaction', async () => {
  const h = harness({ busy: () => true })
  try {
    const pending = new PendingInteractions({ log: () => {} })
    const handler = createInboundHandler({
      ctx: {
        sessionController: {
          prompt: async (request, signal) => {
            signal.throwIfAborted()
            h.prompts.push({ request, signal })
            return { accepted: true }
          },
        },
      },
      sessions: h.sessions,
      outbound: { deliver: async (job) => { h.sent.push(job) }, sendActive: async (job) => { h.sent.push(job) } },
      pending,
      config: () => ({ mode: 'closed-agent', ownerOpenId: 'OWNER' }),
      log: () => {},
      ensureSession: async () => 'sess_1',
      status: () => ({}),
      busy: () => true,
      signal: h.controller.signal,
    })
    pending.open('private:OWNER', {
      kind: 'approval',
      timeoutMs: 60_000,
      parse: (text) => (text === '通过' ? 'allowed-once' : undefined),
    })

    // The operator named the delivery on purpose; answering the approval with
    // the text they asked to insert would invert that intent.
    await handler(message({ text: '/steer 通过' }))
    assert.equal(h.prompts.length, 1)
    assert.equal(h.prompts[0].request.mode, 'steer')
    assert.equal(pending.size, 1, 'the approval is still waiting for a real answer')
    pending.closeAll()
  } finally {
    h.cleanup()
  }
})

test('/status reports the delivery policy next to the turn state', async () => {
  const h = harness({ busy: () => true })
  try {
    // The turn state needs a bound session, so the conversation is opened first.
    await h.handler(message())
    await h.handler(message({ text: '/status', messageId: 'ROBOT1.0_cmd' }))
    const body = h.sent.at(-1).text
    assert.match(body, /投递：运行中插入当前回合（steer）/)
    assert.match(body, /当前回合：运行中/)
  } finally {
    h.cleanup()
  }
})

test('/status answers the delivery question before a session exists', async () => {
  const h = harness()
  try {
    await h.handler(message({ text: '/status' }))
    assert.match(h.sent[0].text, /投递：运行中插入当前回合（steer）/, 'the policy is a deployment fact, not a session one')
    assert.match(h.sent[0].text, /当前回合：尚未创建/)
  } finally {
    h.cleanup()
  }
})

test('a document attachment is written to disk and its path reaches the agent', async () => {
  // Before this, a PDF arrived as the single line "[附件：报告.pdf 230KB]" and the
  // agent could not open it. The bytes have to land somewhere real.
  const h = harness()
  try {
    const handler = createInboundHandler({
      ctx: {
        sessionController: {
          prompt: async (request, signal) => { signal.throwIfAborted(); h.prompts.push({ request, signal }); return { accepted: true } },
        },
      },
      sessions: h.sessions,
      outbound: { deliver: async () => {}, sendActive: async () => {} },
      pending: new PendingInteractions({ log: () => {} }),
      config: () => ({ mode: 'closed-agent', ownerOpenId: 'OWNER' }),
      log: () => {},
      ensureSession: async () => 'sess_1',
      fetchImpl: async () => ({
        ok: true,
        arrayBuffer: async () => Buffer.from('%PDF-1.4 fake'),
      }),
      status: () => ({}),
      signal: h.controller.signal,
    })

    await handler(message({
      text: '看下这个',
      attachments: [{ url: 'https://example.test/a.pdf', contentType: 'application/pdf', isImage: false, filename: '报告.pdf', size: 230 }],
    }))

    const text = h.prompts[0].request.content.map((part) => part.text ?? '').join('\n')
    const path = /\[附件已保存到本机：([^\]]+?)(（|」)/.exec(text)?.[1]
    assert.ok(path !== undefined, `the prompt names a saved path: ${text}`)
    assert.ok(existsSync(path), 'and that file really exists')
    assert.equal(readFileSync(path, 'utf8'), '%PDF-1.4 fake', 'with the bytes that were downloaded')
    assert.ok(path.includes('报告.pdf'), 'the original name is preserved')
    rmSync(path, { force: true })
  } finally {
    h.cleanup()
  }
})

test('an attachment that cannot be downloaded says so instead of vanishing', async () => {
  const h = harness()
  try {
    const handler = createInboundHandler({
      ctx: {
        sessionController: {
          prompt: async (request, signal) => { signal.throwIfAborted(); h.prompts.push({ request, signal }); return { accepted: true } },
        },
      },
      sessions: h.sessions,
      outbound: { deliver: async () => {}, sendActive: async () => {} },
      pending: new PendingInteractions({ log: () => {} }),
      config: () => ({ mode: 'closed-agent', ownerOpenId: 'OWNER' }),
      log: () => {},
      ensureSession: async () => 'sess_1',
      fetchImpl: async () => ({ ok: false, status: 410 }),
      status: () => ({}),
      signal: h.controller.signal,
    })

    await handler(message({
      text: '文件',
      attachments: [{ url: 'https://example.test/gone.zip', contentType: 'application/zip', isImage: false, filename: 'gone.zip', size: 10 }],
    }))

    const text = h.prompts[0].request.content.map((part) => part.text ?? '').join('\n')
    assert.match(text, /附件未能保存/, 'a failed download is stated, not silent')
  } finally {
    h.cleanup()
  }
})

test('a redelivered message is handled once', async () => {
  // The platform documents that the same msg_id may be pushed more than once.
  // A repeat reaching the agent is not harmless: "delete that file", "commit
  // and push" or "restart" would simply be executed a second time, silently.
  const h = harness()
  try {
    const handler = createInboundHandler({
      ctx: {
        sessionController: {
          prompt: async (request, signal) => { signal.throwIfAborted(); h.prompts.push({ request, signal }); return { accepted: true } },
        },
      },
      sessions: h.sessions,
      outbound: { deliver: async () => {}, sendActive: async () => {} },
      pending: new PendingInteractions({ log: () => {} }),
      config: () => ({ mode: 'closed-agent', ownerOpenId: 'OWNER' }),
      log: () => {},
      ensureSession: async () => 'sess_1',
      status: () => ({}),
      signal: h.controller.signal,
    })

    const first = message({ text: '删掉那个文件', messageId: 'msg_dup_1' })
    await handler(first)
    await handler({ ...first })                       // the platform pushes it again
    assert.equal(h.prompts.length, 1, 'the agent sees it once')

    await handler(message({ text: '删掉那个文件', messageId: 'msg_dup_2' }))
    assert.equal(h.prompts.length, 2, 'a different message id is a different message')
  } finally {
    h.cleanup()
  }
})

test('a duplicate command is not executed twice either', async () => {
  const h = harness({ bindings: [['private:OWNER', 'sess_1']] })
  const replies = []
  try {
    const handler = createInboundHandler({
      ctx: { sessionController: { prompt: async () => { throw new Error('must not be called') } } },
      sessions: h.sessions,
      outbound: {
        deliver: async (job) => { replies.push(job) },
        sendActive: async (job) => { replies.push(job) },
      },
      pending: new PendingInteractions({ log: () => {} }),
      commands: createSessionCommands({
        ctx: {},
        sessions: h.sessions,
        pending: new PendingInteractions({ log: () => {} }),
        settingsScope: { update: async () => {} },
        log: () => {},
      }),
      config: () => ({ mode: 'closed-agent', ownerOpenId: 'OWNER' }),
      log: () => {},
      ensureSession: async () => 'sess_1',
      status: () => ({}),
      signal: h.controller.signal,
    })
    const dup = message({ text: '/sessions', messageId: 'msg_cmd_1' })
    await handler(dup)
    const afterFirst = replies.length
    await handler({ ...dup })
    assert.ok(afterFirst > 0, 'the command answered')
    assert.equal(replies.length, afterFirst, 'the repeated command produced nothing further')
  } finally {
    h.cleanup()
  }
})

test('a shortcut word runs the command it stands for', async () => {
  // Typing a slash on a phone is awkward, and a voice message arrives as
  // exactly this text, so the words are the shortest path to a command.
  const h = harness({ bindings: [['private:OWNER', 'sess_1']] })
  try {
    const handler = createInboundHandler({
      ctx: { sessionController: { prompt: async () => { throw new Error('must not reach the agent') } } },
      sessions: h.sessions,
      outbound: { deliver: async (job) => { h.sent.push(job) }, sendActive: async (job) => { h.sent.push(job) } },
      pending: new PendingInteractions({ log: () => {} }),
      commands: createSessionCommands({
        ctx: {},
        sessions: h.sessions,
        pending: new PendingInteractions({ log: () => {} }),
        settingsScope: { update: async () => {} },
        log: () => {},
      }),
      config: () => ({ mode: 'closed-agent', ownerOpenId: 'OWNER' }),
      log: () => {},
      ensureSession: async () => 'sess_1',
      status: () => ({ gateway: 'online' }),
      signal: h.controller.signal,
    })

    await handler(message({ text: '状态' }))
    assert.ok(h.sent.length > 0, 'the shortcut produced the status answer')
    assert.equal(h.prompts.length, 0, 'and never reached the agent')
  } finally {
    h.cleanup()
  }
})

test('a sentence that merely contains a shortcut word is not a command', async () => {
  // Exact match on the whole message is what keeps this safe.
  const h = harness({ bindings: [['private:OWNER', 'sess_1']] })
  try {
    const handler = createInboundHandler({
      ctx: {
        sessionController: {
          prompt: async (request, signal) => { signal.throwIfAborted(); h.prompts.push({ request, signal }); return { accepted: true } },
        },
      },
      sessions: h.sessions,
      outbound: { deliver: async () => {}, sendActive: async () => {} },
      pending: new PendingInteractions({ log: () => {} }),
      config: () => ({ mode: 'closed-agent', ownerOpenId: 'OWNER' }),
      log: () => {},
      ensureSession: async () => 'sess_1',
      status: () => ({}),
      signal: h.controller.signal,
    })

    await handler(message({ text: '任务完成了' }))
    await handler(message({ text: '看一下状态怎么样' }))
    assert.equal(h.prompts.length, 2, 'both went to the agent as ordinary messages')
  } finally {
    h.cleanup()
  }
})

test('/menu answers with buttons that carry command payloads', async () => {
  const h = harness({ bindings: [['private:OWNER', 'sess_1']] })
  try {
    const handler = createInboundHandler({
      ctx: { sessionController: { prompt: async () => { throw new Error('must not reach the agent') } } },
      sessions: h.sessions,
      outbound: { deliver: async (job) => { h.sent.push(job) }, sendActive: async (job) => { h.sent.push(job) } },
      pending: new PendingInteractions({ log: () => {} }),
      config: () => ({ mode: 'closed-agent', ownerOpenId: 'OWNER' }),
      log: () => {},
      ensureSession: async () => 'sess_1',
      status: () => ({}),
      signal: h.controller.signal,
    })

    await handler(message({ text: '菜单' }))
    const delivered = h.sent[0]
    assert.match(delivered.text, /快捷菜单/)
    const buttons = delivered.keyboard.content.rows.flatMap((row) => row.buttons)
    assert.deepEqual(buttons.map((b) => b.action.data), ['cmd|status', 'cmd|usage', 'cmd|todos', 'cmd|sessions', 'cmd|doctor', 'cmd|screen'])
    for (const b of buttons) assert.ok(b.action.unsupport_tips !== '', 'every button keeps the required field')
    assert.equal(h.prompts.length, 0)
  } finally {
    h.cleanup()
  }
})

test('a shortcut resolves to one command, and only for a whole message', () => {
  // One word per command: a table with two spellings for the same thing is
  // longer to remember than the commands it replaces.
  assert.equal(shortcutCommand('状态'), 'status')
  assert.equal(shortcutCommand('额度'), 'usage')
  assert.equal(shortcutCommand('任务'), 'todos')
  assert.equal(shortcutCommand('菜单'), 'menu')

  // The English spelling needs no table: the command name itself works, in any
  // case, so there is nothing extra to learn.
  assert.equal(shortcutCommand('status'), 'status')
  assert.equal(shortcutCommand('Status'), 'status')
  assert.equal(shortcutCommand('STATUS'), 'status')
  assert.equal(shortcutCommand('  todos  '), 'todos')

  // A sentence that merely contains a word is an ordinary message.
  assert.equal(shortcutCommand('任务完成了'), null)
  assert.equal(shortcutCommand('看一下状态'), null)
  assert.equal(shortcutCommand('status 怎么样'), null)
  assert.equal(shortcutCommand('随便一句话'), null)
})

test('every advertised command is reachable without its slash', async () => {
  // The set and the help text describe the same thing, so a command added to one
  // and forgotten in the other fails here rather than surprising the operator.
  const h = harness()
  try {
    const handler = createInboundHandler({
      ctx: { sessionController: { prompt: async () => { throw new Error('must not reach the agent') } } },
      sessions: h.sessions,
      outbound: { deliver: async (job) => { h.sent.push(job) }, sendActive: async (job) => { h.sent.push(job) } },
      pending: new PendingInteractions({ log: () => {} }),
      config: () => ({ mode: 'closed-agent', ownerOpenId: 'OWNER' }),
      log: () => {},
      ensureSession: async () => 'sess_1',
      status: () => ({}),
      signal: h.controller.signal,
    })
    await handler(message({ text: '/help' }))
    const help = h.sent.map((entry) => entry.text).join(String.fromCharCode(10))
    for (const name of COMMAND_NAMES) {
      assert.ok(help.includes(`/${name}`), `/${name} is advertised`)
    }
    assert.ok(COMMAND_NAMES.has(shortcutCommand('帮助')), 'the Chinese word points at an advertised command')
  } finally {
    h.cleanup()
  }
})
