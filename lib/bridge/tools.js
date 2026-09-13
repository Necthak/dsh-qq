/**
 * Agent-facing QQ tools.
 *
 * These let the agent act on QQ on its own initiative — send a message, quote a
 * specific one, or check the channel — instead of only answering what arrived.
 *
 * The safety property is that **the agent cannot choose an arbitrary
 * recipient**. A target must already be a known conversation (which only an
 * allow-listed sender can create) and must still pass the allow list at send
 * time. The default target is the conversation the calling session is bound to,
 * so the common case needs no target at all and cannot be pointed elsewhere.
 *
 * Sends made through these tools are recorded, and the outbound path skips its
 * automatic forward for a turn that used one, so the agent's own message is not
 * duplicated by the bridge.
 *
 * @module dsh-qq/bridge/tools
 */

import { readFileSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { captureScreen, pruneCaptures } from './capture.js'
import { FILE_MAX_BYTES, IMAGE_MAX_BYTES, IMAGE_MEDIA_TYPES } from '../qq/api.js'
import { isAllowed } from './inbound.js'
import { splitConversationKey } from './sessions.js'

/**
 * Resolve the conversation a tool call belongs to.
 *
 * @param options - lookup context.
 * @param options.exec - the tool execution context carrying the agent.
 * @param options.sessions - the conversation table.
 * @param options.target - an explicit target from the tool arguments, if any.
 * @returns The resolved conversation, or an error description.
 */
function resolveTarget({ exec, sessions, target }) {
  if (typeof target === 'string' && target.trim() !== '') {
    const key = target.trim()
    const parsed = splitConversationKey(key)
    if (parsed === null) return { error: `target 格式无效：${key}（应为 private:<openid> 或 group:<openid>）` }
    if (sessions.get(key) === undefined) {
      return { error: `target 不是已知的 QQ 会话：${key}` }
    }
    return { key, ...parsed }
  }

  const sessionId = exec?.agent?.session?.id
  const key = typeof sessionId === 'string' ? sessions.keyForSession(sessionId) : undefined
  if (key === undefined) {
    return { error: '当前 DSH 会话没有绑定任何 QQ 会话，请显式传入 target。' }
  }
  const parsed = splitConversationKey(key)
  if (parsed === null) return { error: `绑定的 QQ 会话键无效：${key}` }
  return { key, ...parsed }
}

/**
 * Whether the agent may send into one resolved conversation.
 *
 * The check has to be the SAME one the inbound path applies, evaluated with the
 * identity that actually opened the conversation. Asking `isAllowed` with the
 * peer as the sender — which is what this used to do — silently refuses the
 * common `chat`-mode deployment: the allow list names the person, so a group
 * conversation is admitted on the strength of `userId`, and a check that only
 * knows `peerId` can never reproduce that. The result was a bridge that
 * accepted messages from a group and then refused to answer into it.
 *
 * The remembered sender is what makes the two agree. When a conversation
 * predates this field there is no identity to speak for it, so the rule falls
 * back to the peer's own listing — conservative, and it stops mattering as soon
 * as the next message arrives.
 *
 * @param options - what to check.
 * @param options.sessions - the conversation table.
 * @param options.settings - live settings.
 * @param options.key - the conversation key.
 * @param options.kind - `'private'` or `'group'`.
 * @param options.peerId - the target's OpenID.
 * @returns Null when the send is allowed, or the reason to refuse it.
 */
function refuseSend({ sessions, settings, key, kind, peerId }) {
  const record = sessions.get(key)
  if (record === undefined) return `target 不是已知的 QQ 会话：${key}`
  const userId = typeof record.lastUserId === 'string' ? record.lastUserId : ''
  if (!isAllowed({ kind, peerId, userId }, settings)) {
    return `目标 ${key} 不在白名单内，拒绝发送`
  }
  return null
}

/**
 * Register the QQ tools on a context.
 *
 * @param options - wiring.
 * @param options.ctx - the plugin context.
 * @param options.sessions - the conversation table.
 * @param options.outbound - the QQ sender.
 * @param options.config - live settings accessor.
 * @param options.log - diagnostics sink.
 * @param options.markToolSend - records that a turn sent its own QQ message.
 * @param options.status - reports live bridge state for `qq_get_status`.
 * @returns A disposer unregistering every tool.
 */
export function registerQqTools({ ctx, sessions, outbound, config, log, markToolSend, status }) {
  const disposers = []

  disposers.push(ctx.tools.register(defineTool({
    name: 'qq_send_message',
    description: [
      'Send a text message to a QQ conversation through the official QQ bot.',
      'By default this sends to the QQ conversation this session belongs to.',
      'Use it to speak proactively; ordinary replies are delivered automatically, so do not repeat your answer with this tool.',
    ].join(' '),
    parameters: {
      text: { type: 'string', required: true, description: 'Message text to send. Plain text; markdown is not rendered by QQ.' },
      target: { type: 'string', description: 'Optional conversation key (private:<openid> or group:<openid>). Defaults to this session\'s QQ conversation.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { sent: { type: 'boolean' }, target: { type: 'string' }, chunks: { type: 'number' } },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.sent === true
          ? `已发送到 ${value.target}（${value.chunks} 条）`
          : `发送失败：${value.target}`,
      }],
    },
    execute: async (args, exec) => {
      const settings = config() ?? {}
      if (settings.allowAgentSend === false) throw new Error('qq_send_message is disabled by the dsh-qq settings')

      const resolved = resolveTarget({ exec, sessions, target: args.target })
      if (resolved.error !== undefined) throw new Error(resolved.error)

      // Re-check at send time: the conversation may have been removed from the
      // allow list, or the mode tightened, since it was first mapped.
      const refusal = refuseSend({ sessions, settings, key: resolved.key, kind: resolved.kind, peerId: resolved.peerId })
      if (refusal !== null) throw new Error(refusal)

      const chunks = splitCount(args.text, settings)
      await outbound.sendActive({ key: resolved.key, kind: resolved.kind, peerId: resolved.peerId, text: args.text })
      markToolSend(exec)
      log(`agent sent ${chunks} QQ message(s) to ${resolved.key}`)
      return { sent: true, target: resolved.key, chunks }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'qq_reply',
    description: [
      'Reply to a specific earlier QQ message, quoting it so the recipient sees which message is being answered.',
      'Pass the message id from a qq_send_message result or from the conversation context.',
    ].join(' '),
    parameters: {
      text: { type: 'string', required: true, description: 'Reply text.' },
      message_id: { type: 'string', description: 'The QQ message id to quote. Defaults to the most recent inbound message of this conversation.' },
      target: { type: 'string', description: 'Optional conversation key. Defaults to this session\'s QQ conversation.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { sent: { type: 'boolean' }, target: { type: 'string' }, quoted: { type: 'string' } },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.sent === true ? `已引用回复 ${value.target}` : `回复失败：${value.target}`,
      }],
    },
    execute: async (args, exec) => {
      const settings = config() ?? {}
      if (settings.allowAgentSend === false) throw new Error('qq_reply is disabled by the dsh-qq settings')

      const resolved = resolveTarget({ exec, sessions, target: args.target })
      if (resolved.error !== undefined) throw new Error(resolved.error)
      const refusal = refuseSend({ sessions, settings, key: resolved.key, kind: resolved.kind, peerId: resolved.peerId })
      if (refusal !== null) throw new Error(refusal)

      const record = sessions.get(resolved.key)
      const requested = typeof args.message_id === 'string' ? args.message_id.trim() : ''
      const messageId = requested !== '' ? requested : (record?.replyToMessageId ?? '')
      if (messageId === '') throw new Error('没有可引用的消息 id：请显式传入 message_id')

      // A quote needs msg_id, which is only available while the passive window
      // for THAT message is open and tracked. When it is not, speaking plainly
      // still serves the agent's intent better than failing the call.
      let quoted = ''
      if (messageId === record?.replyToMessageId) {
        const limit = resolved.kind === 'group' ? 5 : 4
        const slot = sessions.takeReplySlot(resolved.key, limit)
        if (slot !== null) {
          await outbound.sendQuoted({
            key: resolved.key,
            kind: resolved.kind,
            peerId: resolved.peerId,
            text: args.text,
            msgId: slot.msgId,
            msgSeq: slot.msgSeq,
          })
          quoted = messageId
        }
      }
      if (quoted === '') {
        await outbound.sendActive({ key: resolved.key, kind: resolved.kind, peerId: resolved.peerId, text: args.text })
        log(`${resolved.key}: quote window unavailable for ${messageId}; sent without quoting`)
      }

      markToolSend(exec)
      log(`agent replied in ${resolved.key}${quoted === '' ? '' : ' with a quote'}`)
      return { sent: true, target: resolved.key, quoted }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'qq_send_image',
    description: [
      'Send an image from this machine to a QQ conversation through the official QQ bot.',
      'Use it when a screenshot, chart, diagram, or rendered file says more than a description — the operator is usually on a phone.',
      'The platform renders png and jpeg only; convert anything else first.',
      'By default this sends to the QQ conversation this session belongs to.',
    ].join(' '),
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path of a png or jpeg file on this machine.' },
      caption: { type: 'string', description: 'Optional text sent as a separate message right after the image.' },
      target: { type: 'string', description: "Optional conversation key (private:<openid> or group:<openid>). Defaults to this session's QQ conversation." },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { sent: { type: 'boolean' }, target: { type: 'string' }, bytes: { type: 'number' } },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.sent === true
          ? `已发送图片到 ${value.target}（${String(value.bytes)} 字节）`
          : `图片发送失败：${value.target}`,
      }],
    },
    execute: async (args, exec) => {
      const settings = config() ?? {}
      if (settings.allowAgentSend === false) throw new Error('qq_send_image is disabled by the dsh-qq settings')

      const resolved = resolveTarget({ exec, sessions, target: args.target })
      if (resolved.error !== undefined) throw new Error(resolved.error)
      const refusal = refuseSend({ sessions, settings, key: resolved.key, kind: resolved.kind, peerId: resolved.peerId })
      if (refusal !== null) throw new Error(refusal)

      const path = String(args.path ?? '').trim()
      if (path === '') throw new Error('path 不能为空')
      const mediaType = IMAGE_MEDIA_TYPES.get(mediaTypeOf(path))
      if (mediaType === undefined) {
        // The platform answers `850019 不支持的文件格式` for anything else, and
        // that arrives after a full upload — refuse here instead.
        throw new Error(`只支持 png / jpeg：${path}（可先转换格式）`)
      }

      let data
      try {
        data = readFileSync(path)
      } catch (error) {
        throw new Error(`读取图片失败：${String(error?.message ?? error)}`)
      }
      if (data.byteLength === 0) throw new Error(`图片是空文件：${path}`)
      if (data.byteLength > IMAGE_MAX_BYTES) {
        throw new Error(`图片超过 ${String(Math.round(IMAGE_MAX_BYTES / 1024 / 1024))}MB 软限制：${String(data.byteLength)} 字节`)
      }

      await outbound.sendImage({
        key: resolved.key,
        kind: resolved.kind,
        peerId: resolved.peerId,
        data,
        fileName: basename(path),
      })
      const caption = typeof args.caption === 'string' ? args.caption.trim() : ''
      if (caption !== '') {
        await outbound.sendActive({ key: resolved.key, kind: resolved.kind, peerId: resolved.peerId, text: caption })
      }
      // Deliberately NOT `markToolSend`: an image does not duplicate the turn's
      // written answer, so that answer must still be forwarded.
      log(`agent sent an image (${String(data.byteLength)} bytes) to ${resolved.key}`)
      return { sent: true, target: resolved.key, bytes: data.byteLength }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'qq_send_file',
    description: [
      'Send a file from this machine to a QQ conversation through the official QQ bot.',
      'Use it when the answer is long, or when the operator should keep the artifact: a report, a log, a diff, a rendered document.',
      'The platform shows it as a file card they can open; prefer this over splitting a long answer into many chat messages.',
      'By default this sends to the QQ conversation this session belongs to.',
    ].join(' '),
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path of the file to send on this machine.' },
      caption: { type: 'string', description: 'Optional text sent as a separate message right after the file.' },
      target: { type: 'string', description: "Optional conversation key (private:<openid> or group:<openid>). Defaults to this session's QQ conversation." },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { sent: { type: 'boolean' }, target: { type: 'string' }, bytes: { type: 'number' } },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.sent === true
          ? `已发送文件到 ${value.target}（${String(value.bytes)} 字节）`
          : `文件发送失败：${value.target}`,
      }],
    },
    execute: async (args, exec) => {
      const settings = config() ?? {}
      if (settings.allowAgentSend === false) throw new Error('qq_send_file is disabled by the dsh-qq settings')

      const resolved = resolveTarget({ exec, sessions, target: args.target })
      if (resolved.error !== undefined) throw new Error(resolved.error)
      const refusal = refuseSend({ sessions, settings, key: resolved.key, kind: resolved.kind, peerId: resolved.peerId })
      if (refusal !== null) throw new Error(refusal)

      const path = String(args.path ?? '').trim()
      if (path === '') throw new Error('path 不能为空')
      let stats
      try {
        stats = statSync(path)
      } catch (error) {
        throw new Error(`读取文件失败：${String(error?.message ?? error)}`)
      }
      if (!stats.isFile()) throw new Error(`不是普通文件：${path}`)
      if (stats.size === 0) throw new Error(`文件是空的：${path}`)
      if (stats.size > FILE_MAX_BYTES) {
        throw new Error(`文件超过 ${String(Math.round(FILE_MAX_BYTES / 1024 / 1024))}MB 软限制：${String(stats.size)} 字节`)
      }
      const data = readFileSync(path)

      await outbound.sendFile({
        key: resolved.key,
        kind: resolved.kind,
        peerId: resolved.peerId,
        data,
        fileName: basename(path) === '' ? 'file.bin' : basename(path),
      })
      const caption = typeof args.caption === 'string' ? args.caption.trim() : ''
      if (caption !== '') {
        await outbound.sendActive({ key: resolved.key, kind: resolved.kind, peerId: resolved.peerId, text: caption })
      }
      log(`agent sent a file (${String(data.byteLength)} bytes) to ${resolved.key}`)
      return { sent: true, target: resolved.key, bytes: data.byteLength }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'qq_send_screenshot',
    description: [
      'Capture a screenshot on this machine and send it to a QQ conversation through the official QQ bot.',
      'Use it when the operator is away from the machine and asks what is on screen, or when a picture settles a question faster than prose.',
      'Default captures the whole screen; pass process (for example "weixin" or "msedge") to capture one application window instead, which also works when that window is covered.',
      'A window that has never painted - hidden, or a remote session that is not rendering - is reported as a failure rather than sent as a blank image.',
    ].join(' '),
    parameters: {
      process: { type: 'string', description: 'Process name to capture, as a regular expression (e.g. "weixin"). Omit to capture the whole screen.' },
      title: { type: 'string', description: 'Window title to capture, as a regular expression. Narrows process further.' },
      screen: { type: 'boolean', description: 'Capture the whole primary screen. Implied when neither process nor title is given.' },
      method: { type: 'string', description: 'How to read the pixels: "auto" (default; screen for browsers and Electron, PrintWindow otherwise), "screen" (always copy from the screen - use it when the window is in front and PrintWindow returns a stale frame), or "printwindow" (captures a covered window).' },
      caption: { type: 'string', description: 'Optional text sent as a separate message right after the image.' },
      target: { type: 'string', description: "Optional conversation key (private:<openid> or group:<openid>). Defaults to this session's QQ conversation." },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sent: { type: 'boolean' },
          target: { type: 'string' },
          bytes: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          method: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.sent === true
          ? `已发送截图到 ${value.target}（${String(value.width)}x${String(value.height)}，${value.method}）`
          : `截图发送失败：${value.target}`,
      }],
    },
    execute: async (args, exec) => {
      const settings = config() ?? {}
      if (settings.allowAgentSend === false) throw new Error('qq_send_screenshot is disabled by the dsh-qq settings')
      if (process.platform !== 'win32') throw new Error('qq_send_screenshot 目前只在 Windows 上实现')

      const resolved = resolveTarget({ exec, sessions, target: args.target })
      if (resolved.error !== undefined) throw new Error(resolved.error)
      const refusal = refuseSend({ sessions, settings, key: resolved.key, kind: resolved.kind, peerId: resolved.peerId })
      if (refusal !== null) throw new Error(refusal)

      const shot = await captureScreen({ process: args.process, title: args.title, screen: args.screen, method: args.method, log })
      const data = shot.data

      await outbound.sendImage({ key: resolved.key, kind: resolved.kind, peerId: resolved.peerId, data, fileName: basename(shot.path) })
      const caption = typeof args.caption === 'string' ? args.caption.trim() : ''
      if (caption !== '') {
        await outbound.sendActive({ key: resolved.key, kind: resolved.kind, peerId: resolved.peerId, text: caption })
      }
      log(`agent sent a screenshot (${String(data.byteLength)} bytes, ${String(result.method)}) to ${resolved.key}`)
      return {
        sent: true,
        target: resolved.key,
        bytes: data.byteLength,
        width: Number.isSafeInteger(result.width) ? result.width : 0,
        height: Number.isSafeInteger(result.height) ? result.height : 0,
        method: String(result.method ?? ''),
      }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'qq_get_status',
    description: 'Report the dsh-qq bridge status: channel state, bound conversations, and open interactions. Read-only.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          gateway: { type: 'string' },
          conversations: { type: 'number' },
          pending: { type: 'number' },
          mode: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `QQ 通道：${value.gateway}；已绑定会话：${value.conversations}；待应答：${value.pending}；模式：${value.mode}`,
      }],
    },
    execute: async () => {
      const settings = config() ?? {}
      const live = typeof status === 'function' ? status() : {}
      return {
        gateway: String(live.gateway ?? 'unknown'),
        conversations: sessions.size,
        pending: Number.isSafeInteger(live.pending) ? live.pending : 0,
        mode: String(settings.mode ?? 'closed-agent'),
      }
    },
  })))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error) {
        log(`tool disposer failed: ${String(error?.message ?? error)}`)
      }
    }
  }
}

/**
 * Guess an image's media type from its path.
 *
 * Extension-based on purpose: the read happens next anyway, and the platform's
 * own check is on the encoded bytes, so a cheap mismatch here only decides
 * which error the caller sees first.
 *
 * @param path - the file path.
 * @returns A media type string, or '' when the extension means nothing here.
 */
function mediaTypeOf(path) {
  switch (extname(String(path)).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    default: return ''
  }
}

/**
 * Count how many chunks a text will become, for reporting.
 *
 * @param text - the message text.
 * @param settings - live settings.
 * @returns The chunk count.
 */
function splitCount(text, settings) {
  const maxBytes = Number.isSafeInteger(settings.maxBytes) && settings.maxBytes > 0 ? settings.maxBytes : 3_500
  const bytes = Buffer.byteLength(String(text ?? ''), 'utf8')
  return Math.max(1, Math.ceil(bytes / maxBytes))
}

