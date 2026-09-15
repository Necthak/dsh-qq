/**
 * Inbound path: a QQ message becomes a DSH prompt.
 *
 * The order of the checks is the design:
 *
 * 1. **Access** — an unlisted sender is dropped before anything else runs, so a
 *    stranger's message can never reach an agent with shell access.
 * 2. **Commands** — `/reset` and friends are answered by the bridge itself and
 *    never reach the model. A `/steer` or `/queue` prefix is not a command but a
 *    delivery override: the rest of the message is still an ordinary prompt.
 * 3. **Pending interactions** — while an approval or question is open, the next
 *    message answers it instead of starting a new turn. This is what makes the
 *    QQ conversation usable as a decision surface. An overridden message skips
 *    this step on purpose: `/steer 通过` asks to insert text, and consuming it as
 *    an approval answer would do the opposite of what was asked.
 * 4. **Prompt** — everything else is forwarded, either into the running turn
 *    (`steer`) or behind it (`queue`). See `./delivery.js` for that decision.
 *
 * Images are inlined as base64 blocks rather than referenced by URL, because
 * the platform's attachment URLs expire and the DSH attachment store wants the
 * bytes.
 *
 * @module dsh-qq/bridge/inbound
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { conversationKey } from './sessions.js'
import { pruneCaptures } from './capture.js'
import { isAllowed, isOwner } from './admission.js'
import { normalizeBusyDelivery, parseDeliveryOverride, resolveDeliveryMode } from './delivery.js'
import { explainChoice, explainEffort, flattenCatalog, formatCatalog, resolveChoice, resolveEffort } from './model.js'
import { MODEL_PAGE_SIZE, buildModelKeyboard } from './keyboard.js'
import { buildPromptText, imageAttachments } from '../qq/events.js'

// The admission predicates live in their own module so the inbound path, the
// agent's outbound tools, and the administration commands cannot drift apart.
// They stay re-exported here because this is where callers have always read
// them from.
export { isAllowed, isOwner }

/** Image MIME types DSH accepts as inline blocks. */
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * Chinese words that stand in for a command.
 *
 * One word per command, with no synonyms: a table with two spellings for the
 * same thing is longer to remember than the commands it replaces, which defeats
 * the purpose. The English spelling needs no table at all - see
 * {@link COMMAND_NAMES} - because the command name itself works without the
 * slash, so nothing new has to be learned.
 */
export const COMMAND_ALIASES = new Map([
  ['状态', 'status'],
  ['额度', 'usage'],
  ['任务', 'todos'],
  ['会话', 'sessions'],
  ['继续', 'resume'],
  ['模型', 'model'],
  ['搜索', 'find'],
  ['诊断', 'doctor'],
  ['截图', 'screen'],
  ['日志', 'log'],
  ['重启', 'restart'],
  ['停止', 'stop'],
  ['新对话', 'new'],
  ['重置', 'reset'],
  ['工作区', 'workspace'],
  ['菜单', 'menu'],
  ['帮助', 'help'],
])

/**
 * Command names that may be written without the leading slash.
 *
 * The rule replaces a second lookup table: `status` means `/status`, and there
 * is nothing extra to remember or to keep in sync. Matching is on the whole
 * message and is case-insensitive, so 「status」「Status」 and 「STATUS」 all work
 * while a sentence containing the word does not.
 */
export const COMMAND_NAMES = new Set([
  'help', 'status', 'model', 'new', 'reset', 'stop',
  'workspace', 'sessions', 'resume', 'usage', 'screen',
  'log', 'doctor', 'todos', 'find', 'menu', 'restart',
])

/**
 * Resolve one message into the command it means, if any.
 *
 * @param text - the trimmed message body.
 * @returns The command name, or null when this is an ordinary message.
 */
export function shortcutCommand(text) {
  const word = String(text ?? '').trim()
  const chinese = COMMAND_ALIASES.get(word)
  if (chinese !== undefined) return chinese
  const lower = word.toLowerCase()
  return COMMAND_NAMES.has(lower) ? lower : null
}

/**
 * A leading @-mention, which the platform puts into the message body itself.
 *
 * Matches one or more mentions, so a message that mentions two people before
 * its text is still read correctly.
 */
const LEADING_MENTION = /^\s*(?:<@!?[^>]{1,64}>\s*)+/

/** Upper bound on one inlined image, to keep a prompt from ballooning. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** Upper bound on one attachment downloaded to disk. */
const MAX_FILE_BYTES = 100 * 1024 * 1024

/** Where inbound attachments that cannot be inlined are parked. */
const FILE_DIR_NAME = 'dsh-qq-files'

/**
 * Build the inbound message handler.
 *
 * @param options - wiring.
 * @param options.ctx - the plugin context.
 * @param options.sessions - the conversation table.
 * @param options.outbound - the QQ sender, used for command replies.
 * @param options.pending - the pending-interaction registry.
 * @param options.models - the model catalog and switch operations behind `/model`.
 * @param options.commands - the session-administration commands, or undefined
 *   on a deployment that wires none.
 * @param options.config - live settings accessor.
 * @param options.log - diagnostics sink.
 * @param options.ensureSession - resolves the DSH session for a conversation.
 * @param options.fetchImpl - fetch used to download attachments.
 * @param options.status - reports live bridge state for `/status`.
 * @param options.progress - describes a live turn in one line for `/status`:
 *   `(sessionId, busy) => string`.
 * @param options.busy - reports whether a session's agent is mid-turn:
 *   `true`, `false`, or null when the agent registry is unavailable and the
 *   answer is unknown. Only `true` selects steering.
 * @param options.onRejected - called with a message that admission refused, so
 *   the operator can discover the sender's OpenID and allow it.
 * @param options.signal - cancellation for prompt admission; the Session
 *   Controller REQUIRES it (`prompt(request, signal)` dereferences it
 *   immediately), so omitting it fails the call outright.
 * @returns An async handler taking a normalized QQ message.
 */
export function createInboundHandler({ ctx, sessions, outbound, pending, models, commands, config, log, ensureSession, fetchImpl, status, busy, progress, onRejected, signal }) {
  const doFetch = fetchImpl ?? globalThis.fetch

  /**
   * The message ids most recently handled per conversation.
   *
   * The platform states that the same `msg_id` may be pushed more than once,
   * and a repeat that reaches the agent is not harmless: an instruction to
   * delete, commit, push or restart would simply be executed twice, with no
   * sign that anything was duplicated. Ids are compared per conversation and
   * bounded, because this exists to absorb a redelivery within seconds, not to
   * keep a history.
   */
  const handledIds = new Map()
  const HANDLED_LIMIT = 50

  /**
   * Record one message id, reporting whether it has been seen before.
   *
   * @param key - the conversation.
   * @param messageId - the platform's id, or '' when none was supplied.
   * @returns Whether this exact message has already been handled.
   */
  function isRepeat(key, messageId) {
    if (messageId === '') return false
    let ids = handledIds.get(key)
    if (ids === undefined) {
      ids = []
      handledIds.set(key, ids)
    }
    if (ids.includes(messageId)) return true
    ids.push(messageId)
    if (ids.length > HANDLED_LIMIT) ids.shift()
    return false
  }

  return async function handleMessage(message) {
    const settings = config() ?? {}
    const key = conversationKey(message.kind, message.peerId)

    if (!isAllowed(message, settings)) {
      log(`${key}: dropped, the sender is not admitted by the current mode and allow list`)
      try {
        onRejected?.(message)
      } catch (error) {
        log(`${key}: rejection listener failed: ${String(error?.message ?? error)}`)
      }
      return
    }

    // Deduplication happens after admission so that a repeat from a stranger
    // cannot consume an entry, and before anything is dispatched so that no
    // command and no prompt is ever executed twice.
    if (isRepeat(key, message.messageId)) {
      log(`${key}: dropped, message ${message.messageId} was already handled (the platform redelivers)`)
      return
    }

    const text = message.text.trim()

    // Arm the reply cursor for EVERY admitted message, before anything is
    // dispatched. A command's answer is a reply too, and it used to leave the
    // cursor pointing at whatever older message last reached the agent: in a
    // group, whose passive window is five minutes, every command answered more
    // than five minutes after that older message was refused by the platform
    // and the operator saw nothing at all.
    if (message.messageId !== '') sessions.setReplyTarget(key, message.messageId, 'message', message.userId)

    // A delivery override is split off before command matching, because the
    // remainder is an ordinary prompt and must keep running through the one
    // path that owns sessions, attachments, and request ids.
    const override = text.startsWith('/') ? parseDeliveryOverride(text) : null
    const body = override === null ? text : override.text

    // Commands are matched BEFORE an open interaction is offered the message.
    // That is what keeps `/new` usable as an escape hatch while the agent is
    // waiting on an answer: a command always runs, and anything else is the
    // answer.
    // A shortcut is rewritten into the command it stands for, so every rule
    // downstream - admission, owner checks, output - stays exactly where it was.
    // Detection looks past a leading mention: in a group the natural way to
    // address the bot is to mention it, and the platform puts `<@openid>` into
    // the body itself, so `/usage` arrives as `<@ABC> /usage` and stops being a
    // command. Only detection sees the stripped copy; the agent still receives
    // the body exactly as it was sent.
    //
    // The stripped copy is what the slash check below must see too. Falling back
    // to the original text when the word is not a shortcut - which is every
    // slash command - put the mention straight back and left `/usage` broken.
    const commandSource = text.replace(LEADING_MENTION, '')
    const shortcut = shortcutCommand(commandSource)
    const commandText = shortcut === null ? commandSource : `/${shortcut}`

    if (override === null && commandText.startsWith('/')) {
      const handled = await runCommand({ models, commands, sessions, outbound, config, log, message, key, text: commandText, status, busy, progress, signal })
      if (handled) return
    }

    // An overridden message is never offered to an open interaction: the
    // operator named the delivery on purpose, and answering an approval with
    // the text they asked to insert would invert that intent.
    if (override === null && pending.offer(key, body)) {
      log(`${key}: message consumed as an answer to an open interaction`)
      return
    }

    if (body === '' && message.attachments.length === 0 && message.ark === '') {
      if (override !== null) {
        await reply(outbound, message, key, '用法：/steer <要插入当前回合的内容>，或 /queue <排队到下一回合的内容>。')
        return
      }
      log(`${key}: empty message ignored`)
      return
    }

    let sessionId
    try {
      sessionId = await ensureSession(key)
    } catch (error) {
      log(`${key}: session could not be created: ${String(error?.message ?? error)}`)
      await reply(outbound, message, key, `⚠️ 无法创建 DSH 会话：${String(error?.message ?? error)}`)
      return
    }

    // A conversation created by this very message had no record when the cursor
    // was armed above, so arm it again now that one exists. Arming before the
    // prompt (rather than after it) keeps the target fresh even when the prompt
    // is refused: attaching a reply to the newest inbound message is always the
    // right answer, and a refused prompt is still a message the user sent.
    if (message.messageId !== '') sessions.setReplyTarget(key, message.messageId, 'message', message.userId)

    const content = await buildContent({ message: { ...message, text: body }, doFetch, log, key })

    // Probed after `ensureSession`, because a conversation created by this
    // message has no session to ask about until now. The probe answers null
    // when the agent registry is unreachable, and only a proven running turn
    // steers; a stale "idle" merely queues, and the race the other way — the
    // turn ending between this probe and the prompt — is handled by the driver,
    // which degrades steering into the next turn instead of failing.
    const mode = resolveDeliveryMode({
      policy: settings.busyDelivery,
      forced: override === null ? null : override.mode,
      busy: typeof busy === 'function' ? busy(sessionId) === true : false,
    })

    try {
      await ctx.sessionController.prompt({
        requestId: promptRequestId(message),
        sessionId,
        mode,
        content,
      }, signal)
      log(`${key}: delivered to session ${sessionId} (${mode})`)
    } catch (error) {
      log(`${key}: prompt rejected: ${String(error?.message ?? error)}`)
      await reply(outbound, message, key, `⚠️ DSH 拒绝了这个请求：${String(error?.message ?? error)}`)
    }
  }
}

/**
 * Mint the durable identity recorded on the accepted user message.
 *
 * The platform's message ids are opaque and may contain characters that mean
 * something to other layers (a `:` in particular is used as a separator in
 * several id schemes), so they are reduced to a safe alphabet here.
 *
 * @param message - the normalized inbound message.
 * @returns A request id unique to this message.
 */
function promptRequestId(message) {
  const raw = typeof message.messageId === 'string' && message.messageId !== ''
    ? message.messageId
    : String(Date.now())
  return `qq-${raw.replace(/[^A-Za-z0-9_.-]/g, '_')}`
}

/**
 * Handle a `/`-prefixed message.
 *
 * @param options - handler context.
 * @returns Whether the message was consumed.
 */
async function runCommand({ models, commands, sessions, outbound, config, log, message, key, text, status, busy, progress, signal }) {
  const [rawName, ...args] = text.slice(1).trim().split(/\s+/)
  const name = rawName.toLowerCase()
  const settings = config() ?? {}
  const send = (body, keyboard) => reply(outbound, message, key, body, keyboard)

  if (name === 'help') {
    await send([
      '🤖 DSH QQ 桥接',
      '',
      '【对话】',
      '/status — 通道、会话、当前模型、回合状态、最近一次发送失败',
      '/new、/reset — 为当前会话开启全新上下文',
      '/stop — 中止正在运行的回合（收件箱里的消息会在之后继续）',
      '/steer <内容> — 把内容插入正在运行的回合，不必等它跑完',
      '/queue <内容> — 反过来：排队到当前回合结束之后',
      '（不带前缀时按设置里的「运行中投递」决定，见设置卡片）',
      '',
      '【模型】',
      '/model — 列出模型（带数字键盘，点数字即切换）',
      '/model <编号> — 切换模型',
      '/model <编号> <强度> — 同时指定思考强度',
      '/model 提供方/模型 id — 精确指定',
      '（切换后若该模型支持强度，会给出一排强度按钮）',
      '',
      '【会话与工作区】',
      '/sessions [数量] — 列出最近会话',
      '/find <关键词> — 在会话内容里搜索，结果可直接用 /resume 编号 切过去',
      '/resume <编号|会话 ID> — 把本对话切到某个已有会话',
      '/workspace — 查看新会话目录',
      '/workspace <路径> — 设置新会话目录（配合 /new 生效）',
      '/usage — 余额、套餐窗口、今日花费与按当前速度可用天数（读 DSH 的额度账本）',
      '/log [行数] — 查看最近的本插件日志（仅 owner，默认 15 条）',
      '/doctor — 主动自检：通道、看门狗、凭据、owner、余额、发送失败（仅 owner）',
      '/todos — 查看 agent 本轮的任务清单与进度',
      '/help — 显示本帮助',
      '/menu install — 安装或更新 / 下拉选择器里的指令面板（仅 owner，启动时自动刷新）',
      '不打斜杠也行：命令名本身（status、usage、todos…，大小写不敏感），或中文词：状态、额度、任务、会话、继续、模型、搜索、诊断、截图、日志、重启、停止、新对话、重置、工作区、菜单、帮助',
      '/screen [进程名] — 截图并发到本对话（仅 owner；不带参数截全屏）',
      '/restart — 重启 DSH 进程（仅 owner；重启前自检，回来时把新地址发到本对话）',
      '/restart force — 回合正在运行时的确认形式',
      '',
      '直接发消息即可与 agent 对话。',
      '审批与单选题会给按钮，点一下即可，也可以回复文字。',
    ].join('\n'))
    return true
  }

  if (name === 'status') {
    const record = sessions.get(key)
    const live = typeof status === 'function' ? status() : {}
    const lines = [
      '📊 状态',
      `QQ 通道：${String(live.gateway ?? 'unknown')}`,
      `已绑定会话：${String(live.conversations ?? 0)} 个`,
      `DSH 会话：${record === undefined ? '尚未创建' : record.sessionId}`,
      `待应答交互：${String(live.pending ?? 0)}`,
    ]
    if (record !== undefined && models !== undefined) {
      const current = await models.current(record.sessionId)
      lines.push(`当前模型：${current === undefined ? '未知（无法读取）' : `${current.provider}/${current.model}${current.reasoningEffort === undefined ? '' : ` · ${current.reasoningEffort}`}`}`)
    }
    // The policy and the turn state are reported together because the pair is
    // what an operator needs to predict where the next message lands: the policy
    // alone does not say whether a turn is running, and the turn state alone
    // does not say what happens to a message sent into it. The policy prints
    // even before a session exists, since it is a deployment fact and "why is my
    // message late" is exactly the question `/status` is opened to answer.
    const policy = normalizeBusyDelivery(settings.busyDelivery)
    const running = record === undefined || typeof busy !== 'function' ? null : busy(record.sessionId)
    const turn = record === undefined
      ? '尚未创建'
      : typeof progress === 'function'
        // The tracker knows the elapsed time, the step count and the tool in
        // flight; without it the best available answer is the Host's own status.
        ? progress(record.sessionId, running)
        : running === null || running === undefined ? '未知（agent 注册表不可读）' : running === true ? '运行中' : '空闲'
    lines.push([
      `投递：${policy === 'steer' ? '运行中插入当前回合（steer）' : '一律排队到下一回合（queue）'}`,
      `当前回合：${turn}`,
    ].join(' · '))
    // A silent channel is the hardest failure to diagnose from a phone, so the
    // most recent send failure is reported here rather than only in the log.
    const failure = live.lastFailure
    if (failure !== null && failure !== undefined) {
      lines.push('', `⚠️ 最近一次发送失败（${new Date(failure.at).toLocaleString()}）：${failure.message}`)
    }
    await send(lines.join('\n'))
    return true
  }

  if (name === 'model') {
    await handleModel({ models, sessions, outbound, message, key, text, log, settings })
    return true
  }

  // The session-administration commands are grouped in their own module so the
  // Host calls they need stay out of the message-routing path.
  if (typeof commands === 'function') {
    const handled = await commands({ name, args, message, key, settings, signal, reply: send })
    if (handled) return true
  }

  return false
}

/**
 * Answer `/model`.
 *
 * Listing is open to any admitted sender because it reveals nothing the model
 * picker does not; switching is owner-only, because it also rewrites the
 * deployment default that every new Session inherits.
 *
 * @param options - handler context.
 * @param options.models - the model catalog and switch operations.
 * @param options.sessions - the conversation table.
 * @param options.outbound - the QQ sender.
 * @param options.message - the inbound message.
 * @param options.key - the conversation key.
 * @param options.text - the full command text.
 * @param options.log - diagnostics sink.
 * @param options.settings - live settings.
 */
async function handleModel({ models, sessions, outbound, message, key, text, log, settings }) {
  if (models === undefined || models === null) {
    await reply(outbound, message, key, '⚠️ 模型服务不可用。')
    return
  }

  const record = sessions.get(key)
  if (record === undefined) {
    await reply(outbound, message, key, '⚠️ 当前还没有 DSH 会话。先发一条消息建立会话，再用 /model。')
    return
  }

  let catalog
  try {
    catalog = await models.catalog()
  } catch (error) {
    log(`${key}: model catalog read failed: ${String(error?.message ?? error)}`)
    await reply(outbound, message, key, `⚠️ 读取模型列表失败：${String(error?.message ?? error)}`)
    return
  }

  const current = await models.current(record.sessionId)
  const args = text.slice(1).trim().split(/\s+/).slice(1)

  if (args.length === 0) {
    // The keypad is what makes this usable from a phone: the numbers in the
    // body and the numbers on the buttons are the same numbering.
    await reply(
      outbound,
      message,
      key,
      formatCatalog(catalog, current, { page: 0, pageSize: MODEL_PAGE_SIZE }),
      buildModelKeyboard(flattenCatalog(catalog), 0, MODEL_PAGE_SIZE),
    )
    return
  }

  if (!isOwner(message, settings)) {
    await reply(outbound, message, key, '⛔ 只有 owner 可以切换模型。')
    return
  }

  const choice = resolveChoice(catalog, args[0], current?.provider)
  if (choice.kind !== 'row') {
    await reply(outbound, message, key, explainChoice(choice))
    return
  }

  const effort = resolveEffort(choice.row, args[1])
  if (effort.kind === 'unsupported') {
    await reply(outbound, message, key, explainEffort(choice.row, effort))
    return
  }

  const wanted = {
    provider: choice.row.provider,
    model: choice.row.model.id,
    ...effort.kind === 'effort' ? { reasoningEffort: effort.id } : {},
  }

  try {
    const result = await models.select(record.sessionId, wanted)
    const selected = result?.selected ?? wanted
    log(`${key}: model switched to ${selected.provider}/${selected.model}${selected.reasoningEffort === undefined ? '' : ` (${selected.reasoningEffort})`}`)
    await reply(outbound, message, key, [
      `✅ 已切换：${selected.provider}/${selected.model}${selected.reasoningEffort === undefined ? '' : ` · ${selected.reasoningEffort}`}`,
      '下一条消息起生效；本会话上下文保留。',
    ].join('\n'))
  } catch (error) {
    log(`${key}: model switch rejected: ${String(error?.message ?? error)}`)
    await reply(outbound, message, key, `⚠️ 切换失败：${String(error?.message ?? error)}`)
  }
}

/**
 * Compose the prompt content for one QQ message.
 *
 * @param options - message and transport.
 * @returns The DSH `PromptContentPart` list.
 */
async function buildContent({ message, doFetch, log, key }) {
  const content = [{ type: 'text', text: buildPromptText(message) }]
  const notes = []

  for (const attachment of message.attachments) {
    // Voice is already transcribed into the prompt text by `buildPromptText`,
    // so there is nothing to carry.
    if (attachment.contentType === 'voice') continue

    const inlineable = attachment.isImage && INLINE_IMAGE_TYPES.has(attachment.contentType)
    if (inlineable) {
      try {
        const response = await doFetch(attachment.url)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const buffer = Buffer.from(await response.arrayBuffer())
        if (buffer.byteLength === 0) throw new Error('empty body')
        if (buffer.byteLength <= MAX_IMAGE_BYTES) {
          content.push({
            type: 'image',
            mediaType: attachment.contentType,
            data: buffer.toString('base64'),
            ...(attachment.filename === '' ? {} : { name: attachment.filename }),
          })
          continue
        }
        // Too big to inline: fall through and hand over a path instead of
        // dropping what the operator sent.
        log(`${key}: image ${attachment.filename || '(unnamed)'} exceeds the inline limit; saving it to disk`)
        const saved = saveAttachment({ attachment, buffer, log, key })
        if (saved !== '') notes.push(saved)
      } catch (error) {
        log(`${key}: image download failed (${String(error?.message ?? error)}); continuing with text only`)
      }
      continue
    }

    // A document the model cannot see at all: everything that is not an inline
    // image used to arrive as one line of prose — "[附件：报告.pdf 230KB]" — and
    // the agent could not open it. Writing the bytes somewhere real is what
    // turns "you were sent a file" into "you can read the file".
    try {
      const response = await doFetch(attachment.url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.byteLength === 0) throw new Error('empty body')
      if (buffer.byteLength > MAX_FILE_BYTES) throw new Error(`${String(buffer.byteLength)} bytes exceeds the limit`)
      const saved = saveAttachment({ attachment, buffer, log, key })
      if (saved !== '') notes.push(saved)
    } catch (error) {
      log(`${key}: attachment ${attachment.filename || '(unnamed)'} could not be saved (${String(error?.message ?? error)})`)
      notes.push(`[附件未能保存：${attachment.filename || '未命名'}（${String(error?.message ?? error)}）]`)
    }
  }

  // One extra text block, so the paths sit together and read as a list.
  if (notes.length > 0) content.push({ type: 'text', text: notes.join(String.fromCharCode(10)) })
  return content
}

/**
 * Write one attachment into the temp directory and describe where it landed.
 *
 * The directory is swept on every inbound file, keeping a day of history: recent
 * attachments stay readable while a session is being worked, and old ones do not
 * accumulate for the life of the machine.
 *
 * @param options - the attachment and its bytes.
 * @param options.attachment - the normalized attachment.
 * @param options.buffer - the downloaded bytes.
 * @param options.log - diagnostics sink.
 * @param options.key - the conversation, for diagnostics.
 * @returns A prompt line naming the saved path, or '' when it could not be written.
 */
function saveAttachment({ attachment, buffer, log, key }) {
  const dir = join(tmpdir(), FILE_DIR_NAME)
  try {
    mkdirSync(dir, { recursive: true })
    try {
      const pruned = pruneCaptures({ dir, prefix: 'att-', suffix: '' })
      if (pruned > 0) log(`${key}: removed ${String(pruned)} attachment(s) older than a day`)
    } catch { /* housekeeping must not cost the message */ }
    const name = safeFileName(attachment.filename, attachment.contentType)
    const path = join(dir, `att-${String(Date.now())}-${name}`)
    writeFileSync(path, buffer)
    return `[附件已保存到本机：${path}（原名 ${name}，${String(Math.round(buffer.byteLength / 1024))}KB，${attachment.contentType || '未知类型'}）]`
  } catch (error) {
    log(`${key}: attachment could not be written (${String(error?.message ?? error)})`)
    return ''
  }
}

/**
 * Reduce a platform-supplied name to something safe to join onto a directory.
 *
 * The name comes from the network, so it is stripped of separators and of
 * anything that could climb out of the directory it is written into.
 *
 * @param filename - the attachment's name, possibly empty.
 * @param contentType - its declared type, used to invent an extension.
 * @returns A bare file name.
 */
function safeFileName(filename, contentType) {
  const base = basename(String(filename ?? '').replace(/[\/]+/g, '_')).trim()
  const cleaned = base.replace(/[^0-9A-Za-z._一-龥-]/g, '_').slice(0, 80)
  if (cleaned !== '' && cleaned !== '.' && cleaned !== '..') return cleaned
  const extension = contentType === 'image/png' ? '.png' : contentType === 'application/pdf' ? '.pdf' : '.bin'
  return `attachment${extension}`
}

/**
 * Send a bridge-authored reply that attaches to the inbound message when the
 * passive window still allows it.
 *
 * @param outbound - the QQ sender.
 * @param message - the inbound message.
 * @param key - the conversation key.
 * @param text - the reply text.
 * @param keyboard - optional inline keyboard attached to the reply.
 */
async function reply(outbound, message, key, text, keyboard) {
  try {
    await outbound.deliver({
      key,
      kind: message.kind,
      peerId: message.peerId,
      text,
      ...(keyboard === undefined ? {} : { keyboard }),
    })
  } catch {
    // A failed bridge notice must not fail the inbound path.
  }
}
