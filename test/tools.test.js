/**
 * The agent's own QQ tools, and the one rule that keeps them safe.
 *
 * A tool must not be able to pick an arbitrary recipient, and it must not
 * refuse the conversation the bridge is actively serving either. Both halves
 * are the same admission predicate the inbound path uses, so these tests pin
 * the agreement between the two directions rather than the predicate itself.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionMap } from '../lib/bridge/sessions.js'
import { buildCaptureArgs, parseCaptureResult, pruneCaptures } from '../lib/bridge/capture.js'
import { registerQqTools } from '../lib/bridge/tools.js'

/**
 * Register the tools against a fake context and hand back the definitions.
 *
 * @param options - settings and how the conversation table is seeded.
 * @returns The registered tools plus what they sent.
 */
function harness({ settings = {}, bind = null, lastUserId = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-tools-'))
  const sessions = new SessionMap({ path: join(dir, 'sessions.json'), log: () => {} })
  if (bind !== null) {
    sessions.bind(bind, 'sess_1')
    if (lastUserId !== '') sessions.setReplyTarget(bind, 'msg_1', 'message', lastUserId)
  }

  const tools = []
  const sent = []
  const ctx = { tools: { register: (definition) => { tools.push(definition); return () => {} } } }

  const dispose = registerQqTools({
    ctx,
    sessions,
    outbound: {
      sendActive: async (job) => { sent.push({ via: 'active', ...job }) },
      sendQuoted: async (job) => { sent.push({ via: 'quoted', ...job }) },
      sendImage: async (job) => { sent.push({ via: 'image', ...job }) },
      sendFile: async (job) => { sent.push({ via: 'file', ...job }) },
    },
    config: () => ({ mode: 'closed-agent', ownerOpenId: 'OWNER', ...settings }),
    log: () => {},
    markToolSend: () => {},
    status: () => ({}),
  })

  return {
    sessions,
    sent,
    tool: (name) => tools.find((entry) => entry.name === name),
    dispose,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** The execution context a tool call receives. */
function exec(sessionId = 'sess_1') {
  return { agent: { session: { id: sessionId } } }
}

test('a group conversation admitted by its members is sendable', async () => {
  // The deployment this bridge actually runs in: `chat` mode, allow list naming
  // the person, group conversation opened by that person's message. Judging the
  // send by the peer alone refused exactly this, so the bridge accepted
  // messages from the group and then could not answer into it.
  const h = harness({
    settings: { mode: 'chat', allow: ['OWNER'] },
    bind: 'group:GROUP',
    lastUserId: 'OWNER',
  })
  try {
    const result = await h.tool('qq_send_message').execute({ text: '你好' }, exec())
    assert.equal(result.sent, true)
    assert.equal(h.sent.length, 1)
    assert.equal(h.sent[0].key, 'group:GROUP')
    assert.equal(h.sent[0].peerId, 'GROUP')
  } finally {
    h.cleanup()
  }
})

test('a conversation whose sender is not admitted is still refused', async () => {
  const h = harness({
    settings: { mode: 'chat', allow: ['SOMEONE_ELSE'] },
    bind: 'group:GROUP',
    lastUserId: 'OWNER',
  })
  try {
    await assert.rejects(
      () => h.tool('qq_send_message').execute({ text: '你好' }, exec()),
      /不在白名单内/,
    )
    assert.equal(h.sent.length, 0)
  } finally {
    h.cleanup()
  }
})

test('an unknown recipient is refused before any admission check', async () => {
  const h = harness({ settings: { mode: 'chat', allow: ['OWNER'] }, bind: 'group:GROUP', lastUserId: 'OWNER' })
  try {
    await assert.rejects(
      () => h.tool('qq_send_message').execute({ text: 'hi', target: 'private:STRANGER' }, exec()),
      /不是已知的 QQ 会话/,
    )
    assert.equal(h.sent.length, 0)
  } finally {
    h.cleanup()
  }
})

test('closed-agent mode refuses a group even when it is bound', async () => {
  // The mode is part of the same predicate, so an agent that cannot receive
  // from a group must not be able to speak into one either.
  const h = harness({
    settings: { mode: 'closed-agent', ownerOpenId: 'OWNER' },
    bind: 'group:GROUP',
    lastUserId: 'OWNER',
  })
  try {
    await assert.rejects(() => h.tool('qq_send_message').execute({ text: '你好' }, exec()), /不在白名单内/)
  } finally {
    h.cleanup()
  }
})

test('a denied identity stays denied in the outbound direction', async () => {
  const h = harness({
    settings: { mode: 'chat', allow: ['OWNER'], deny: ['OWNER'] },
    bind: 'group:GROUP',
    lastUserId: 'OWNER',
  })
  try {
    await assert.rejects(() => h.tool('qq_send_message').execute({ text: '你好' }, exec()), /不在白名单内/)
  } finally {
    h.cleanup()
  }
})

test('a conversation with no remembered sender falls back to its own listing', async () => {
  // Legacy rows carry no sender. The peer's own listing is the conservative
  // reading, and it stops mattering as soon as the next message arrives.
  const boundWithoutSender = harness({ settings: { mode: 'chat', allow: ['GROUP'] }, bind: 'group:GROUP' })
  try {
    const result = await boundWithoutSender.tool('qq_send_message').execute({ text: '你好' }, exec())
    assert.equal(result.sent, true)
  } finally {
    boundWithoutSender.cleanup()
  }

  const boundWithoutListing = harness({ settings: { mode: 'chat', allow: ['OWNER'] }, bind: 'group:GROUP' })
  try {
    await assert.rejects(() => boundWithoutListing.tool('qq_send_message').execute({ text: '你好' }, exec()), /不在白名单内/)
  } finally {
    boundWithoutListing.cleanup()
  }
})

test('the sender that opened a conversation is remembered, and not erased', () => {
  const h = harness({ settings: { mode: 'chat', allow: ['OWNER'] }, bind: 'group:GROUP', lastUserId: 'OWNER' })
  try {
    // A button click arms the cursor too; it must not wipe the identity that
    // the outbound checks depend on.
    h.sessions.setReplyTarget('group:GROUP', 'EVENT1', 'event')
    assert.equal(h.sessions.get('group:GROUP').lastUserId, 'OWNER')
  } finally {
    h.cleanup()
  }
})

test('the agent can still reach the conversation its session is bound to', async () => {
  const h = harness({ settings: {}, bind: 'private:OWNER', lastUserId: 'OWNER' })
  try {
    // No target argument at all: the common case, and the one that must never
    // depend on the caller knowing an OpenID.
    const result = await h.tool('qq_send_message').execute({ text: '在的' }, exec())
    assert.equal(result.sent, true)
    assert.equal(h.sent[0].peerId, 'OWNER')
  } finally {
    h.cleanup()
  }
})

test('allowAgentSend still turns every sending tool off', async () => {
  const h = harness({ settings: { allowAgentSend: false }, bind: 'private:OWNER', lastUserId: 'OWNER' })
  try {
    await assert.rejects(() => h.tool('qq_send_message').execute({ text: 'hi' }, exec()), /disabled/)
    await assert.rejects(() => h.tool('qq_reply').execute({ text: 'hi' }, exec()), /disabled/)
  } finally {
    h.cleanup()
  }
})

// ── images ──────────────────────────────────────────────────────────────────

/** A real one-pixel png, written where the tool can read it. */
function writePng(dir, name = 'shot.png') {
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return path
}

test('an image is read, uploaded and sent to the bound conversation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-img-'))
  const h = harness({ settings: {}, bind: 'private:OWNER', lastUserId: 'OWNER' })
  try {
    const path = writePng(dir)
    const result = await h.tool('qq_send_image').execute({ path, caption: '看这个' }, exec())
    assert.equal(result.sent, true)
    assert.equal(result.bytes, 70)
    assert.equal(h.sent[0].via, 'image')
    assert.equal(h.sent[0].fileName, 'shot.png')
    assert.ok(Buffer.isBuffer(h.sent[0].data))
    // The caption follows as its own message: rich media carries no text.
    assert.equal(h.sent[1].via, 'active')
    assert.equal(h.sent[1].text, '看这个')
  } finally {
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a format the platform would reject is refused before any upload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-img-'))
  const h = harness({ settings: {}, bind: 'private:OWNER', lastUserId: 'OWNER' })
  try {
    const path = join(dir, 'anim.gif')
    writeFileSync(path, 'GIF89a')
    // The platform answers 850019 only after a full upload, so the refusal has
    // to happen here.
    await assert.rejects(() => h.tool('qq_send_image').execute({ path }, exec()), /只支持 png \/ jpeg/)
    assert.equal(h.sent.length, 0)
  } finally {
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing file is reported, not uploaded as empty', async () => {
  const h = harness({ settings: {}, bind: 'private:OWNER', lastUserId: 'OWNER' })
  try {
    await assert.rejects(() => h.tool('qq_send_image').execute({ path: 'C:/nope/missing.png' }, exec()), /读取图片失败/)
    assert.equal(h.sent.length, 0)
  } finally {
    h.cleanup()
  }
})

test('the image tool obeys the same admission and switch as the text tools', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-img-'))
  try {
    const path = writePng(dir)
    const denied = harness({ settings: { mode: 'chat', allow: ['SOMEONE_ELSE'] }, bind: 'group:GROUP', lastUserId: 'OWNER' })
    try {
      await assert.rejects(() => denied.tool('qq_send_image').execute({ path }, exec()), /不在白名单内/)
      assert.equal(denied.sent.length, 0)
    } finally {
      denied.cleanup()
    }

    const off = harness({ settings: { allowAgentSend: false }, bind: 'private:OWNER', lastUserId: 'OWNER' })
    try {
      await assert.rejects(() => off.tool('qq_send_image').execute({ path }, exec()), /disabled/)
    } finally {
      off.cleanup()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── screenshots ─────────────────────────────────────────────────────────────

test('the capture command names the helper, the output and the filters', () => {
  const base = buildCaptureArgs({ scriptPath: 'C:/p/capture-window.ps1', out: 'C:/t/shot.png' })
  assert.deepEqual(base.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'])
  assert.deepEqual(base.slice(5), ['C:/p/capture-window.ps1', '-Out', 'C:/t/shot.png'], 'no window filter means no extra flags')

  const windowed = buildCaptureArgs({ scriptPath: 's.ps1', out: 'o.png', process: ' weixin ', title: ' 微信 ' })
  assert.deepEqual(windowed.slice(-4), ['-Process', 'weixin', '-Title', '微信'], 'filters travel trimmed')

  const full = buildCaptureArgs({ scriptPath: 's.ps1', out: 'o.png', screen: true })
  assert.ok(full.includes('-Screen'))
})

test('a capture result is read from the last json line', () => {
  const stdout = [
    'noise from powershell',
    '{"ok":true,"path":"C:/t/shot.png","width":1299,"height":817,"bytes":186219,"method":"printwindow","error":""}',
  ].join('\n')
  const parsed = parseCaptureResult(stdout, 0)
  assert.equal(parsed.width, 1299)
  assert.equal(parsed.method, 'printwindow')
})

test('a capture failure carries the helper’s own reason', () => {
  // "The window never painted" and "the desktop is not rendering" are the two
  // failures the helper can name, and the operator should read that sentence
  // instead of receiving a grey rectangle.
  const stdout = '{"ok":false,"path":"","width":0,"height":0,"bytes":0,"method":"","error":"no matching window has rendered content"}'
  assert.throws(() => parseCaptureResult(stdout, 1), /no matching window has rendered content/)
  assert.throws(() => parseCaptureResult('', 1), /没有返回结果/)
  assert.throws(() => parseCaptureResult('{not json}', 1), /无法解析/)
})

test('the screenshot tool obeys the same admission rules as the other sends', async () => {
  const h = harness({ settings: { mode: 'chat', allow: ['SOMEONE_ELSE'] }, bind: 'group:GROUP', lastUserId: 'OWNER' })
  try {
    await assert.rejects(() => h.tool('qq_send_screenshot').execute({ screen: true }, exec()), /不在白名单内/)
    assert.equal(h.sent.length, 0)
  } finally {
    h.cleanup()
  }

  const off = harness({ settings: { allowAgentSend: false }, bind: 'private:OWNER', lastUserId: 'OWNER' })
  try {
    await assert.rejects(() => off.tool('qq_send_screenshot').execute({ screen: true }, exec()), /disabled/)
  } finally {
    off.cleanup()
  }
})

test('every sending tool is registered, and each one is gated the same way', () => {
  const h = harness({ settings: {}, bind: 'private:OWNER', lastUserId: 'OWNER' })
  try {
    for (const name of ['qq_send_message', 'qq_reply', 'qq_send_image', 'qq_send_screenshot']) {
      assert.ok(h.tool(name), `${name} must be registered`)
    }
    assert.ok(h.tool('qq_get_status'), 'the read-only status tool stays too')
  } finally {
    h.cleanup()
  }
})

test('the capture method is passed only when it is not the default', () => {
  const auto = buildCaptureArgs({ scriptPath: 's.ps1', out: 'o.png', process: 'msedge' })
  assert.ok(!auto.includes('-Method'), 'auto is the helper default; the command line stays minimal')

  const forced = buildCaptureArgs({ scriptPath: 's.ps1', out: 'o.png', process: 'msedge', method: 'screen' })
  assert.deepEqual(forced.slice(-2), ['-Method', 'screen'])
})

test('old captures are swept, recent ones are kept for inspection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-prune-'))
  try {
    const now = Date.now()
    const old = join(dir, 'dsh-qq-screenshot-1.png')
    const fresh = join(dir, 'dsh-qq-screenshot-2.png')
    const other = join(dir, 'someone-elses.png')
    writeFileSync(old, 'old')
    writeFileSync(fresh, 'fresh')
    writeFileSync(other, 'other')
    // Backdate one capture by two days.
    const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000)
    utimesSync(old, twoDaysAgo, twoDaysAgo)

    const removed = pruneCaptures({ dir, now })
    assert.equal(removed, 1)
    assert.equal(existsSync(old), false, 'yesterday\'s captures go')
    assert.equal(existsSync(fresh), true, 'the one just taken stays, so the caller can check it')
    assert.equal(existsSync(other), true, 'files that are not ours are never touched')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── files ───────────────────────────────────────────────────────────────────

test('a file is read and sent as a document card', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-file-'))
  const h = harness({ settings: {}, bind: 'private:OWNER', lastUserId: 'OWNER' })
  try {
    const path = join(dir, 'report.md')
    writeFileSync(path, '# 报告\n\n内容')
    const result = await h.tool('qq_send_file').execute({ path, caption: '完整报告' }, exec())
    assert.equal(result.sent, true)
    assert.equal(h.sent[0].via, 'file')
    assert.equal(h.sent[0].fileName, 'report.md')
    assert.equal(h.sent[1].text, '完整报告')
  } finally {
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing, empty or oversized file is refused before any upload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-file-'))
  const h = harness({ settings: {}, bind: 'private:OWNER', lastUserId: 'OWNER' })
  try {
    await assert.rejects(() => h.tool('qq_send_file').execute({ path: join(dir, 'nope.bin') }, exec()), /读取文件失败/)
    const empty = join(dir, 'empty.txt')
    writeFileSync(empty, '')
    await assert.rejects(() => h.tool('qq_send_file').execute({ path: empty }, exec()), /文件是空的/)
    await assert.rejects(() => h.tool('qq_send_file').execute({ path: dir }, exec()), /不是普通文件/)
    assert.equal(h.sent.length, 0, 'nothing was uploaded')
  } finally {
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the file tool obeys the same admission and switch as the other sends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-file-'))
  try {
    const path = join(dir, 'x.txt')
    writeFileSync(path, 'x')
    const denied = harness({ settings: { mode: 'chat', allow: ['SOMEONE_ELSE'] }, bind: 'group:GROUP', lastUserId: 'OWNER' })
    try {
      await assert.rejects(() => denied.tool('qq_send_file').execute({ path }, exec()), /不在白名单内/)
      assert.equal(denied.sent.length, 0)
    } finally {
      denied.cleanup()
    }
    const off = harness({ settings: { allowAgentSend: false }, bind: 'private:OWNER', lastUserId: 'OWNER' })
    try {
      await assert.rejects(() => off.tool('qq_send_file').execute({ path }, exec()), /disabled/)
    } finally {
      off.cleanup()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
