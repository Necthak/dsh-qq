/**
 * Command surface and delivery guarantees.
 *
 * Two classes of defect are covered here, both of which used to be invisible
 * from QQ:
 *
 * - A send that failed (or had nothing to send) resolved as success, so a
 *   question prompt that never reached the phone looked delivered.
 * - The answer slot opened only after the prompt finished sending, so a fast
 *   reply could arrive while the slot was still closed.
 *
 * The commands themselves are covered through the same handler the bridge
 * wires, so the tests exercise the routing rather than the bodies alone.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionMap } from '../lib/bridge/sessions.js'
import { PendingInteractions } from '../lib/bridge/pending.js'
import { createInboundHandler } from '../lib/bridge/inbound.js'
import { createSessionCommands, sessionLabel } from '../lib/bridge/commands.js'
import { burnRate, compactNumber, currencySign, dayKey, daysRemaining, formatCreditReport, lowBalances, lowestBalance } from '../lib/bridge/credit.js'
import { Outbound } from '../lib/bridge/outbound.js'
import { registerQuestionAnswerer } from '../lib/bridge/questions.js'
import { registerApprovalAnswerer } from '../lib/bridge/approvals.js'

/** A normalized private message. */
let messageCounter = 0

function message(overrides = {}) {
  return {
    kind: 'private',
    peerId: 'OWNER',
    userId: 'OWNER',
    userName: '甲',
    messageId: `ROBOT1.0_cmd_${String((messageCounter += 1))}`,
    text: 'hi',
    attachments: [],
    ark: '',
    ...overrides,
  }
}

/** One recorded send. */
function recorder() {
  const sent = []
  return {
    sent,
    sink: {
      deliver: async (job) => { sent.push({ via: 'deliver', ...job }) },
      sendActive: async (job) => { sent.push({ via: 'sendActive', ...job }) },
    },
  }
}

/**
 * Build an inbound handler with a scripted Host.
 *
 * @param options - sessions to bind, settings, and scripted Host answers.
 * @returns The handler plus the collaborators a test asserts on.
 */
function harness({ settings = {}, bindings = [], sessionsList = [], cancelResult = { accepted: true }, scope, restart, busy, credit, screenshot, projects = [], archived = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-cmd-'))
  const sessions = new SessionMap({ path: join(dir, 'sessions.json'), log: () => {} })
  for (const [key, sessionId] of bindings) sessions.bind(key, sessionId)

  const out = recorder()
  const updates = []
  const cancels = []
  const controller = new AbortController()

  const ctx = {
    get: (service) => {
      if (service !== 'workspaceRegistry') return undefined
      return { list: () => projects, archivedSessionIds: archived }
    },
    sessionController: {
      prompt: async () => { throw new Error('a command must never reach the agent') },
      list: async () => ({ items: sessionsList }),
      cancel: async (request) => { cancels.push(request); return cancelResult },
    },
  }

  const commands = createSessionCommands({
    ctx,
    sessions,
    pending: new PendingInteractions({ log: () => {} }),
    settingsScope: scope === undefined ? { update: async (patch) => { updates.push(patch) } } : scope,
    restart,
    busy,
    credit,
    screenshot,
    log: () => {},
  })

  const handler = createInboundHandler({
    ctx,
    sessions,
    outbound: out.sink,
    pending: new PendingInteractions({ log: () => {} }),
    commands,
    config: () => ({ mode: 'closed-agent', ownerOpenId: 'OWNER', ...settings }),
    log: () => {},
    ensureSession: async () => 'sess_1',
    status: () => ({}),
    signal: controller.signal,
  })

  return { handler, ...out, updates, cancels, sessions, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// ── delivery is a fact, not an assumption ───────────────────────────────────

test('a failed send rejects instead of reporting success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-out-'))
  try {
    const sessions = new SessionMap({ path: join(dir, 'sessions.json'), log: () => {} })
    sessions.bind('private:OWNER', 'sess_1')
    const delivered = []
    const outbound = new Outbound({
      api: { sendC2C: async () => { throw new Error('platform said no') } },
      sessions,
      log: () => {},
      config: () => ({}),
    })

    await assert.rejects(
      () => outbound.sendActive({ key: 'private:OWNER', kind: 'private', peerId: 'OWNER', text: 'hi' }),
      /platform said no/,
    )
    assert.equal(outbound.lastFailure?.message, 'platform said no')
    assert.equal(delivered.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an empty body is a failure rather than a silent no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-out-'))
  try {
    const sessions = new SessionMap({ path: join(dir, 'sessions.json'), log: () => {} })
    sessions.bind('private:OWNER', 'sess_1')
    const outbound = new Outbound({ api: { sendC2C: async () => {} }, sessions, log: () => {}, config: () => ({}) })

    await assert.rejects(
      () => outbound.sendActive({ key: 'private:OWNER', kind: 'private', peerId: 'OWNER', text: '' }),
      /内容为空/,
    )
    assert.equal(outbound.lastFailure?.message, '消息内容为空，未发送')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a reply refused as expired is retried as an active message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-out-'))
  try {
    const sessions = new SessionMap({ path: join(dir, 'sessions.json'), log: () => {} })
    sessions.bind('group:G1', 'sess_1')
    sessions.setReplyTarget('group:G1', 'MSG1')

    const bodies = []
    const outbound = new Outbound({
      api: {
        sendGroup: async (_peer, body) => {
          bodies.push(body)
          // The platform refuses the passive form once its five-minute window
          // has closed, even though the local reply counter still has room.
          if (body.msg_id !== undefined) throw new Error('QQ POST ... failed: msgid已经过期,不能回复')
        },
      },
      sessions,
      log: () => {},
      config: () => ({}),
    })

    await outbound.deliver({ key: 'group:G1', kind: 'group', peerId: 'G1', text: '你好' })

    assert.equal(bodies.length, 2, 'the passive attempt is followed by an active one')
    assert.equal(bodies[0].msg_id, 'MSG1')
    assert.equal(bodies[1].msg_id, undefined, 'the retry must not carry the dead target')
    assert.equal(bodies[1].content, '你好')
    assert.equal(outbound.lastFailure, null)
    assert.equal(sessions.get('group:G1').replyToMessageId, '', 'the dead target is forgotten')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a successful send clears the recorded failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-out-'))
  try {
    const sessions = new SessionMap({ path: join(dir, 'sessions.json'), log: () => {} })
    sessions.bind('private:OWNER', 'sess_1')
    let fail = true
    const outbound = new Outbound({
      api: { sendC2C: async () => { if (fail) throw new Error('boom') } },
      sessions,
      log: () => {},
      config: () => ({}),
    })

    await assert.rejects(() => outbound.sendActive({ key: 'private:OWNER', kind: 'private', peerId: 'OWNER', text: 'hi' }))
    assert.notEqual(outbound.lastFailure, null)

    fail = false
    await outbound.sendActive({ key: 'private:OWNER', kind: 'private', peerId: 'OWNER', text: 'hi' })
    assert.equal(outbound.lastFailure, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── the answer slot is open before the prompt is sent ───────────────────────

test('a question answer arriving while the prompt is still queueing is accepted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-q-'))
  try {
    const sessions = new SessionMap({ path: join(dir, 'sessions.json'), log: () => {} })
    sessions.bind('private:OWNER', 'sess_1')
    const pending = new PendingInteractions({ log: () => {} })

    let releaseSend
    const gate = new Promise((resolve) => { releaseSend = resolve })
    const sent = []
    const ctx = {
      on: (name, handler, options) => { ctx.handlers[name] = handler; ctx.options[name] = options; return () => {} },
      handlers: {},
      options: {},
    }

    registerQuestionAnswerer({
      ctx,
      sessions,
      outbound: {
        deliver: async (job) => { sent.push(job); await gate },
        sendActive: async () => { throw new Error('a question prompt must use the passive-capable path') },
      },
      pending,
      config: () => ({}),
      log: () => {},
    })

    // Without `prepend` the Remote bridge that feeds the desktop registers
    // first and claims the request, so this answerer would never run at all.
    assert.equal(ctx.options['user-questions/request']?.prepend, true)

    const questions = [{ id: 'q1', question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] }]
    const answer = ctx.handlers['user-questions/request'](
      { questions, agent: { session: { id: 'sess_1' } } },
      async () => { throw new Error('the desktop must not be the only answerer') },
    )

    // The prompt is still in flight; the operator answers anyway.
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(pending.size, 1, 'the slot is open before the send completes')
    assert.equal(pending.offer('private:OWNER', '2'), true)

    releaseSend()
    const resolved = await answer
    assert.deepEqual(resolved, { answers: [{ id: 'q1', selected: ['乙'] }] })
    assert.equal(sent.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an undeliverable question prompt delegates to the desktop instead of waiting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-q-'))
  try {
    const sessions = new SessionMap({ path: join(dir, 'sessions.json'), log: () => {} })
    sessions.bind('private:OWNER', 'sess_1')
    const pending = new PendingInteractions({ log: () => {} })
    const ctx = {
      on: (name, handler, options) => { ctx.handlers[name] = handler; ctx.options[name] = options; return () => {} },
      handlers: {},
      options: {},
    }

    registerQuestionAnswerer({
      ctx,
      sessions,
      outbound: { deliver: async () => { throw new Error('channel offline') } },
      pending,
      config: () => ({}),
      log: () => {},
    })

    const result = await ctx.handlers['user-questions/request'](
      { questions: [{ id: 'q1', question: '选哪个？' }], agent: { session: { id: 'sess_1' } } },
      async () => ({ answers: [{ id: 'q1', selected: ['桌面答案'] }] }),
    )
    assert.deepEqual(result, { answers: [{ id: 'q1', selected: ['桌面答案'] }] })
    assert.equal(pending.size, 0, 'a prompt that never arrived must not hold the slot')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a question for an unbound session declines loudly, not silently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-q-'))
  try {
    const sessions = new SessionMap({ path: join(dir, 'sessions.json'), log: () => {} })
    const lines = []
    const ctx = {
      on: (name, handler, options) => { ctx.handlers[name] = handler; ctx.options[name] = options; return () => {} },
      handlers: {},
      options: {},
    }

    registerQuestionAnswerer({
      ctx,
      sessions,
      outbound: { deliver: async () => { throw new Error('must not send for an unbound session') } },
      pending: new PendingInteractions({ log: () => {} }),
      config: () => ({}),
      log: (line) => lines.push(line),
    })

    const desktop = { answers: [{ id: 'q1', selected: ['桌面'] }] }
    const result = await ctx.handlers['user-questions/request'](
      { questions: [{ id: 'q1', question: '选哪个？' }], agent: { session: { id: 'session-not-ours' } } },
      async () => desktop,
    )

    assert.deepEqual(result, desktop)
    assert.equal(lines.length, 1, 'declining must leave a trace')
    assert.match(lines[0], /not bound to a QQ conversation/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an approval prompt also prefers the passive-capable path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-a-'))
  try {
    const sessions = new SessionMap({ path: join(dir, 'sessions.json'), log: () => {} })
    sessions.bind('private:OWNER', 'sess_1')
    const sent = []
    const ctx = {
      on: (name, handler, options) => { ctx.handlers[name] = handler; ctx.options[name] = options; return () => {} },
      handlers: {},
      options: {},
    }

    registerApprovalAnswerer({
      ctx,
      sessions,
      outbound: {
        deliver: async (job) => { sent.push(job) },
        sendActive: async () => { throw new Error('approvals must use deliver') },
      },
      pending: new PendingInteractions({ log: () => {} }),
      config: () => ({ approvalTimeoutMs: 20 }),
      log: () => {},
    })

    const request = { agent: { session: { id: 'sess_1' } }, toolName: 'bash' }
    const handler = ctx.handlers['approval/request']

    // The QQ slot expires long before the desktop answers, which is the case
    // that must hand the decision back rather than strand the turn.
    const desktopAnswer = { kind: 'desktop' }
    const decision = await handler(request, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60))
      return desktopAnswer
    })

    assert.deepEqual(decision, desktopAnswer, 'an expired QQ slot delegates instead of deciding')
    assert.equal(sent.length, 1)
    assert.match(sent[0].text, /工具审批请求/)
    assert.match(sent[0].text, /bash/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── workspace, sessions, resume, stop ───────────────────────────────────────

test('/workspace lists the registered projects and the bound session directory', async () => {
  const h = harness({
    bindings: [['private:OWNER', 'session-aaaa1111bbbb']],
    settings: { workspacePath: 'C:\\work' },
    sessionsList: [{ sessionId: 'session-aaaa1111bbbb', updatedAt: 1, cwd: 'C:\\work' }],
    projects: [
      { path: 'C:\\work', title: '工作' },
      { path: 'D:\\play', title: '折腾' },
    ],
  })
  try {
    await h.handler(message({ text: '/workspace' }))
    const body = h.sent[0].text
    assert.match(body, /1\. 工作 · C:\\work ←/, 'the configured project is marked')
    assert.match(body, /2\. 折腾 · D:\\play/)
    assert.match(body, /当前会话目录：C:\\work/)
    assert.match(body, /切换只影响\*\*新\*\*会话/)
  } finally {
    h.cleanup()
  }
})

test('/workspace <编号> picks a listed project so a phone never types a path', async () => {
  const h = harness({
    bindings: [['private:OWNER', 'sess_1']],
    projects: [
      { path: 'C:\\work', title: '工作' },
      { path: 'D:\\play', title: '折腾' },
    ],
  })
  try {
    await h.handler(message({ text: '/workspace' }))
    await h.handler(message({ text: '/workspace 2', messageId: 'm2' }))
    assert.deepEqual(h.updates, [{ workspacePath: 'D:\\play' }])
    assert.match(h.sent.at(-1).text, /已设为：D:\\play/)
  } finally {
    h.cleanup()
  }
})

test('/workspace with an out-of-range number refuses instead of guessing a path', async () => {
  const h = harness({ bindings: [['private:OWNER', 'sess_1']], projects: [{ path: 'C:\\work', title: '工作' }] })
  try {
    await h.handler(message({ text: '/workspace' }))
    await h.handler(message({ text: '/workspace 7', messageId: 'm2' }))
    assert.deepEqual(h.updates, [], 'a directory literally named 7 is not what anyone means')
    assert.match(h.sent.at(-1).text, /不在上次列出的工作区范围内/)
  } finally {
    h.cleanup()
  }
})

test('/workspace <path> writes the setting and says when it applies', async () => {
  const h = harness()
  try {
    await h.handler(message({ text: '/workspace D:\\projects\\我的 项目' }))
    assert.deepEqual(h.updates, [{ workspacePath: 'D:\\projects\\我的 项目' }], 'a path with a space survives without quoting')
    assert.match(h.sent[0].text, /接着发 \/new 立刻开新对话/)
    assert.match(h.sent[0].text, /当前会话的工作目录不变/)
  } finally {
    h.cleanup()
  }
})

test('/sessions hides archived sessions', async () => {
  // Archiving is the operator saying "stop showing me this"; a phone menu that
  // lists it anyway makes the desktop's archive useless.
  const h = harness({
    sessionsList: [
      { sessionId: 'session-live1111', updatedAt: 2, cwd: 'C:\\work' },
      { sessionId: 'session-arch2222', updatedAt: 1, cwd: 'C:\\work' },
    ],
    archived: ['session-arch2222'],
  })
  try {
    await h.handler(message({ text: '/sessions' }))
    const body = h.sent[0].text
    assert.match(body, /live1111/)
    assert.doesNotMatch(body, /arch2222/, 'an archived session is not offered for /resume')
  } finally {
    h.cleanup()
  }
})

test('/workspace is refused for a non-owner and when settings are unwritable', async () => {
  const member = harness({ settings: { mode: 'chat', allow: ['MEMBER'], ownerOpenId: 'OWNER' } })
  try {
    await member.handler(message({ kind: 'group', peerId: 'GROUP', userId: 'MEMBER', text: '/workspace /tmp' }))
    assert.equal(member.updates.length, 0)
    assert.match(member.sent[0].text, /只有 owner/)
  } finally {
    member.cleanup()
  }

  const locked = harness({ scope: null })
  try {
    await locked.handler(message({ text: '/workspace /tmp' }))
    assert.match(locked.sent[0].text, /设置命名空间不可用/)
  } finally {
    locked.cleanup()
  }
})

test('/sessions lists recent sessions by title and marks the bound one', async () => {
  const h = harness({
    bindings: [['private:OWNER', 'session-current1']],
    sessionsList: [
      // The title projection is what the desktop sidebar shows; a phone listing
      // that agrees with it is one the operator can act on. A session with no
      // cached row falls back to an id fragment plus its directory.
      { sessionId: 'session-current1', updatedAt: Date.UTC(2026, 8, 12, 6, 30), running: true, blank: false, cwd: 'C:\\work', projections: { asOfSeq: 1, values: { title: '调试 QQ 按钮' } } },
      { sessionId: 'session-other222', updatedAt: Date.UTC(2026, 8, 11, 3, 5), running: false, blank: false, cwd: 'D:\\work' },
      { sessionId: 'session-sub333', updatedAt: Date.UTC(2026, 8, 10), running: false, blank: false, origin: 'subagent' },
    ],
  })
  try {
    await h.handler(message({ text: '/sessions' }))
    const body = h.sent[0].text
    assert.match(body, /1\. 调试 QQ 按钮 · .* · 运行中 ←/, 'the title is what identifies a conversation')
    assert.match(body, /2\. other222 · work · /, 'without a title the id fragment and directory still distinguish it')
    assert.doesNotMatch(body, /sub333/, 'subagent sessions are not resumable from QQ')
  } finally {
    h.cleanup()
  }
})

test('/resume <number> rebinds the conversation to that session', async () => {
  const h = harness({
    bindings: [['private:OWNER', 'session-current1']],
    sessionsList: [
      { sessionId: 'session-current1', updatedAt: 1, running: false, blank: false },
      { sessionId: 'session-other222', updatedAt: 2, running: false, blank: false },
    ],
  })
  try {
    await h.handler(message({ text: '/sessions' }))
    await h.handler(message({ text: '/resume 2' }))
    assert.match(h.sent[1].text, /已切换到会话 other222/)
  } finally {
    h.cleanup()
  }
})

test('/resume without a fresh listing refuses rather than guessing', async () => {
  const h = harness({ bindings: [['private:OWNER', 'session-current1']] })
  try {
    await h.handler(message({ text: '/resume 3' }))
    assert.match(h.sent[0].text, /不在你最近一次 \/sessions 列表里/)
  } finally {
    h.cleanup()
  }
})

test('/stop cancels the bound session', async () => {
  const h = harness({ bindings: [['private:OWNER', 'session-current1']] })
  try {
    await h.handler(message({ text: '/stop' }))
    assert.deepEqual(h.cancels, [{ sessionId: 'session-current1' }])
    assert.match(h.sent[0].text, /已请求取消/)
  } finally {
    h.cleanup()
  }
})

test('/help advertises every command the bridge answers', async () => {
  const h = harness()
  try {
    await h.handler(message({ text: '/help' }))
    const body = h.sent[0].text
    for (const command of ['/status', '/new', '/stop', '/model', '/sessions', '/resume', '/workspace']) {
      assert.ok(body.includes(command), `${command} must be discoverable from /help`)
    }
  } finally {
    h.cleanup()
  }
})

test('an open interaction still lets an escape-hatch command through', async () => {
  const h = harness({ bindings: [['private:OWNER', 'session-current1']] })
  try {
    await h.handler(message({ text: '/new' }))
    assert.match(h.sent[0].text, /已开新对话/)
    assert.match(h.sent[0].text, /旧对话没有丢/, 'starting a new one must not read as throwing the old one away')
  } finally {
    h.cleanup()
  }
})

// ── /restart ────────────────────────────────────────────────────────────────

test('/restart is owner-only', async () => {
  const h = harness({
    settings: { mode: 'chat', allow: ['MEMBER'], ownerOpenId: 'OWNER' },
    bindings: [['group:GROUP', 'sess_g']],
    restart: { prepare: () => ({ launcher: 'C:/l.cmd', port: 3080 }), go: () => { throw new Error('must not restart') } },
  })
  try {
    await h.handler(message({ kind: 'group', peerId: 'GROUP', userId: 'MEMBER', text: '/restart' }))
    assert.match(h.sent[0].text, /只有 owner/)
  } finally {
    h.cleanup()
  }
})

test('/restart relays why it cannot restart instead of exiting anyway', async () => {
  const restarts = []
  const h = harness({
    bindings: [['private:OWNER', 'sess_1']],
    restart: { prepare: () => ({ error: '没有可用的启动器。' }), go: () => restarts.push('go') },
  })
  try {
    await h.handler(message({ text: '/restart' }))
    assert.match(h.sent[0].text, /无法重启：没有可用的启动器/)
    assert.deepEqual(restarts, [], 'a refused restart must not take the server down')
  } finally {
    h.cleanup()
  }
})

test('/restart answers before it hands the process over', async () => {
  // Ordering is the whole point: the confirmation is the last thing this
  // process ever sends, and a restart that exits first leaves the operator with
  // no idea whether the command was even received.
  const seen = []
  const h = harness({
    bindings: [['private:OWNER', 'sess_1']],
    restart: {
      prepare: () => ({ launcher: 'C:/launcher.cmd', port: 3080 }),
      // Runs after the handler awaited its reply, so this snapshot is the proof.
      go: (options) => seen.push({ repliesSoFar: h.sent.length, ...options }),
    },
  })
  try {
    await h.handler(message({ text: '/restart' }))

    assert.equal(seen.length, 1)
    assert.equal(seen[0].repliesSoFar, 1, 'the confirmation must already be on the wire')
    assert.match(h.sent[0].text, /正在重启/)
    assert.equal(seen[0].key, 'private:OWNER', 'the marker names the conversation to announce into')
    assert.equal(seen[0].launcher, 'C:/launcher.cmd')
    assert.equal(seen[0].port, 3080)
  } finally {
    h.cleanup()
  }
})

// ── /restart guards ─────────────────────────────────────────────────────────

test('/restart refuses while a turn is running, and names the escape hatch', async () => {
  const restarts = []
  const h = harness({
    bindings: [['private:OWNER', 'sess_1']],
    busy: () => true,
    restart: {
      prepare: () => ({ launcher: 'C:/l.cmd', port: 3080 }),
      preflight: async () => ({ ok: true }),
      go: () => restarts.push('go'),
    },
  })
  try {
    await h.handler(message({ text: '/restart' }))
    assert.match(h.sent[0].text, /正在运行/)
    assert.match(h.sent[0].text, /\/restart force/)
    assert.deepEqual(restarts, [], 'a running turn must not be discarded by one message')
  } finally {
    h.cleanup()
  }
})

test('/restart force goes through while the turn runs', async () => {
  const restarts = []
  const h = harness({
    bindings: [['private:OWNER', 'sess_1']],
    busy: () => true,
    restart: {
      prepare: () => ({ launcher: 'C:/l.cmd', port: 3080 }),
      preflight: async () => ({ ok: true }),
      go: (options) => restarts.push(options),
    },
  })
  try {
    await h.handler(message({ text: '/restart force' }))
    assert.equal(restarts.length, 1)
  } finally {
    h.cleanup()
  }
})

test('a failed preflight cancels the restart and reports the real error', async () => {
  const restarts = []
  const h = harness({
    bindings: [['private:OWNER', 'sess_1']],
    restart: {
      prepare: () => ({ launcher: 'C:/l.cmd', port: 3080 }),
      preflight: async () => ({ ok: false, error: 'SyntaxError: Unexpected token }' }),
      go: () => restarts.push('go'),
    },
  })
  try {
    await h.handler(message({ text: '/restart' }))
    const body = h.sent.map((entry) => entry.text).join('\n')
    assert.match(body, /自检没通过/)
    assert.match(body, /SyntaxError/)
    assert.deepEqual(restarts, [], 'a broken edit must leave a working bridge behind')
  } finally {
    h.cleanup()
  }
})

// ── /usage and /screen ──────────────────────────────────────────────────────

test('/usage reports the balance, the plan, and today usage', async () => {
  // The figures are DSH's own, so the phone cannot disagree with the desktop.
  const h = harness({
    bindings: [['private:OWNER', 'sess_1']],
    credit: async () => ({
      snapshots: {
        providers: {
          'deepseek-official': { provider: 'deepseek-official', displayName: 'DeepSeek', balance: { currency: 'CNY', totalBalance: '20.23', updatedAt: Date.now() } },
          'opencode-go': { provider: 'opencode-go', displayName: 'opencode-go', plan: { windows: [{ key: '5h', percent: 0 }, { key: 'week', percent: 28, resetsAt: '2026-09-14T00:00:00.000Z' }] } },
          'kimi-coding': { provider: 'kimi-coding', displayName: 'kimi-coding' },
        },
      },
      ledger: { days: { [dayKey(new Date())]: { 'opencode-go': { 'deepseek-v4.1-flash': { calls: 97, inputTokens: 115_100, outputTokens: 84_500, cacheReadTokens: 32_900_000, cost: 0 } } } } },
    }),
  })
  try {
    await h.handler(message({ text: '/usage' }))
    const body = h.sent[0].text
    assert.match(body, /DeepSeek 余额：¥20\.23/)
    assert.match(body, /opencode-go 套餐：5 小时 0% · 本周 28%/)
    assert.match(body, /今日（\d\d-\d\d）/)
    assert.match(body, /97 次 · 入 115\.1K · 出 84\.5K · 缓存 32\.9M/)
    assert.doesNotMatch(body, /kimi-coding/, 'a provider with nothing to say is not listed')
    assert.doesNotMatch(body, /轮次|步骤/, 'the session round counter was the part nobody wanted')
  } finally {
    h.cleanup()
  }
})

test('/usage says so when DSH has not polled anything yet', async () => {
  const h = harness({ bindings: [['private:OWNER', 'sess_1']], credit: async () => ({ snapshots: null, ledger: null }) })
  try {
    await h.handler(message({ text: '/usage' }))
    assert.match(h.sent[0].text, /读不到用量数据/)
  } finally {
    h.cleanup()
  }
})

test('the same balance under two provider ids is shown once', () => {
  // `deepseek` and `deepseek-official` are two rows for one account; printing
  // the same number twice reads as two accounts.
  const body = formatCreditReport({
    snapshots: { providers: {
      'deepseek-official': { displayName: 'DeepSeek', balance: { currency: 'CNY', totalBalance: '20.23' } },
      deepseek: { displayName: 'deepseek', balance: { currency: 'CNY', totalBalance: '20.23' } },
    } },
    ledger: null,
  })
  assert.equal(body.split('余额').length - 1, 1)
})

test('a stale balance is dated, a fresh one is not', () => {
  const now = new Date('2026-09-13T12:00:00')
  const stale = formatCreditReport({ snapshots: { providers: { a: { displayName: 'A', balance: { currency: 'CNY', totalBalance: '1.00', updatedAt: now.getTime() - 3 * 3600_000 } } } }, ledger: null, now })
  assert.match(stale, /3 小时前/)
  const fresh = formatCreditReport({ snapshots: { providers: { a: { displayName: 'A', balance: { currency: 'CNY', totalBalance: '1.00', updatedAt: now.getTime() } } } }, ledger: null, now })
  assert.doesNotMatch(fresh, /小时前/)
})

test('token counts are compacted the way a person reads them', () => {
  assert.equal(compactNumber(470_026_749), '470.0M')
  assert.equal(compactNumber(115_100), '115.1K')
  assert.equal(compactNumber(812), '812')
  assert.equal(compactNumber(0), '0')
  assert.equal(compactNumber(undefined), '0')
})

test('/screen is owner-only', async () => {
  const shots = []
  const h = harness({
    settings: { mode: 'chat', allow: ['MEMBER'], ownerOpenId: 'OWNER' },
    bindings: [['group:GROUP', 'sess_g']],
    screenshot: async (options) => { shots.push(options); return { width: 1, height: 1, method: 'screen' } },
  })
  try {
    await h.handler(message({ kind: 'group', peerId: 'GROUP', userId: 'MEMBER', text: '/screen' }))
    assert.match(h.sent[0].text, /只有 owner/)
    assert.deepEqual(shots, [], 'a group member must not be able to photograph the machine')
  } finally {
    h.cleanup()
  }
})

test('/screen captures the whole screen, or one named window', async () => {
  const shots = []
  const h = harness({
    bindings: [['private:OWNER', 'sess_1']],
    screenshot: async (options) => { shots.push(options); return { width: 1299, height: 817, method: 'printwindow' } },
  })
  try {
    await h.handler(message({ text: '/screen' }))
    assert.match(h.sent[0].text, /截取整个屏幕/)
    assert.equal(shots[0].process, undefined)

    await h.handler(message({ text: '/screen weixin', messageId: 'm2' }))
    assert.match(h.sent[1].text, /截取窗口：weixin/)
    assert.equal(shots[1].process, 'weixin')
  } finally {
    h.cleanup()
  }
})

test('/screen reports why a capture failed, on the same conversation', async () => {
  const h = harness({
    bindings: [['private:OWNER', 'sess_1']],
    screenshot: async () => { throw new Error('no matching window has rendered content') },
  })
  try {
    await h.handler(message({ text: '/screen weixin' }))
    const body = h.sent.map((entry) => entry.text).join('\n')
    assert.match(body, /截图失败/)
    assert.match(body, /no matching window has rendered content/, 'the helper\'s reason reaches the operator')
  } finally {
    h.cleanup()
  }
})

test('/new <编号> opens a conversation in that project in one step', async () => {
  const h = harness({
    bindings: [['private:OWNER', 'sess_old']],
    projects: [
      { path: 'C:\work', title: '工作' },
      { path: 'D:\play', title: '折腾' },
    ],
  })
  try {
    await h.handler(message({ text: '/workspace' }))
    await h.handler(message({ text: '/new 2', messageId: 'm2' }))
    assert.deepEqual(h.updates, [{ workspacePath: 'D:\play' }], 'the workspace is switched and the conversation started')
    assert.match(h.sent.at(-1).text, /已开新对话/)
    assert.match(h.sent.at(-1).text, /下一.*D:\play/)
  } finally {
    h.cleanup()
  }
})

test('/new <编号> with a bad number opens nothing at all', async () => {
  const h = harness({ bindings: [['private:OWNER', 'sess_old']], projects: [{ path: 'C:\work', title: '工作' }] })
  try {
    await h.handler(message({ text: '/workspace' }))
    await h.handler(message({ text: '/new 9', messageId: 'm2' }))
    assert.deepEqual(h.updates, [])
    assert.match(h.sent.at(-1).text, /未开新对话/)
    // Half-applying the request would leave the operator believing both parts
    // happened; refusing the whole command is the only honest answer.
    assert.equal(h.sessions.get('private:OWNER').sessionId, 'sess_old', 'the binding is untouched')
  } finally {
    h.cleanup()
  }
})

test('a balance below the threshold is reported once, and an alias is not a second account', () => {
  const snapshots = { providers: {
    'deepseek-official': { displayName: 'DeepSeek', balance: { currency: 'CNY', totalBalance: '4.10' } },
    deepseek: { displayName: 'deepseek', balance: { currency: 'CNY', totalBalance: '4.10' } },
    'opencode-go': { displayName: 'opencode-go', plan: { windows: [{ key: 'week', percent: 28 }] } },
    kimi: { displayName: 'kimi', balance: { currency: 'CNY', totalBalance: '99.00' } },
  } }
  const low = lowBalances(snapshots, 5)
  assert.equal(low.length, 1, 'the same balance under two ids is one warning')
  assert.equal(low[0].name, 'DeepSeek')
  assert.equal(low[0].amount, 4.1)
  assert.equal(currencySign('CNY'), '¥')
  assert.equal(currencySign('USD'), '$')
})

test('the balance warning is off at threshold zero and silent when nothing is low', () => {
  const snapshots = { providers: { a: { displayName: 'A', balance: { currency: 'CNY', totalBalance: '20.23' } } } }
  assert.deepEqual(lowBalances(snapshots, 0), [], 'zero disables the check')
  assert.deepEqual(lowBalances(snapshots, 5), [], 'a healthy balance says nothing')
  assert.deepEqual(lowBalances(null, 5), [])
  assert.deepEqual(lowBalances({ providers: { a: { displayName: 'A', balance: { currency: 'CNY', totalBalance: 'not a number' } } } }, 5), [])
})

test('the burn rate counts real money only, and skips days with no entry', () => {
  const now = new Date('2026-09-13T12:00:00')
  const ledger = { days: {
    '2026-09-13': { 'deepseek-official': { m: { calls: 5, cost: 1.5 } }, 'opencode-go': { m: { calls: 900, cost: 0 } } },
    '2026-09-12': { 'deepseek-official': { m: { calls: 3, cost: 0.5 } } },
    // 09-11 has no entry at all: skipped, not counted as a zero-spend day.
  } }
  const rate = burnRate(ledger, now, 3)
  assert.equal(rate.days, 2, 'only days with entries are averaged')
  assert.equal(rate.perDay, 1, '(1.5 + 0.5) / 2')
  // A subscription provider reports zero and must not dilute the figure.
  assert.equal(burnRate({ days: { '2026-09-13': { sub: { m: { calls: 10, cost: 0 } } } } }, now, 3).perDay, 0)
  assert.equal(burnRate(null, now).perDay, 0)
})

test('a balance estimate needs a real daily cost behind it', () => {
  assert.equal(daysRemaining(20, 0.05), 400)
  assert.equal(daysRemaining(20, 0), null, 'no spend means no meaningful estimate')
  assert.equal(daysRemaining(undefined, 5), null)
  const snapshots = { providers: {
    a: { displayName: 'A', balance: { currency: 'CNY', totalBalance: '20.23' } },
    b: { displayName: 'B', balance: { currency: 'CNY', totalBalance: '3.10' } },
    c: { displayName: 'C', balance: { currency: 'CNY', totalBalance: '20.23' } },
  } }
  assert.deepEqual(lowestBalance(snapshots), { amount: 3.1, currency: 'CNY' }, 'the smallest balance runs out first')
  assert.equal(lowestBalance(null), null)
})

test('the report shows a projection only when money is actually being charged', () => {
  const now = new Date('2026-09-13T12:00:00')
  const snapshots = { providers: { a: { displayName: 'A', balance: { currency: 'CNY', totalBalance: '20.00' } } } }
  const spend = { days: { '2026-09-13': { a: { m: { calls: 1, cost: 2 } } } } }
  assert.match(formatCreditReport({ snapshots, ledger: spend, now }), /近 1 天平均：¥2\.00\/天 · 余额约可用 10 天/)
  const subscription = { days: { '2026-09-13': { a: { m: { calls: 900, cost: 0 } } } } }
  assert.doesNotMatch(formatCreditReport({ snapshots, ledger: subscription, now }), /余额约可用/)
})
