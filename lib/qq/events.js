/**
 * Normalization of QQ gateway dispatches into the bridge's own shape.
 *
 * The platform speaks three message event names this bridge consumes, and they
 * differ only in where the conversation identity lives:
 *
 * - `C2C_MESSAGE_CREATE` — private chat; `author.user_openid` identifies the
 *   person and is also the send target.
 * - `GROUP_AT_MESSAGE_CREATE` — a group message that @-mentioned the bot;
 *   `group_openid` is the send target and `author.member_openid` the person.
 *   The platform strips the @-prefix from `content` before delivery.
 * - `GROUP_MESSAGE_CREATE` — the same body for every group message, delivered
 *   only once a group administrator enables "receive all messages" for the bot
 *   in that group. Admission is what keeps the extra traffic from reaching the
 *   agent: a group in full mode still only answers the senders the allow list
 *   names.
 *
 * Everything downstream works on {@link NormalizedMessage}, so the rest of the
 * bridge never branches on the raw event name.
 *
 * @module dsh-qq/qq/events
 */

/** The dispatch names this bridge consumes. */
export const EVENT_C2C = 'C2C_MESSAGE_CREATE'
export const EVENT_GROUP_AT = 'GROUP_AT_MESSAGE_CREATE'
/**
 * Every group message, not only the ones that mention the bot.
 *
 * The platform sends this instead of {@link EVENT_GROUP_AT} once a group
 * administrator turns on "receive all messages" from the bot's profile page in
 * that group. Its body is documented as identical to the @-mention event, and
 * it rides the SAME intent, so consuming it costs nothing but this branch.
 */
export const EVENT_GROUP_ALL = 'GROUP_MESSAGE_CREATE'
export const EVENT_INTERACTION = 'INTERACTION_CREATE'

/**
 * Interaction kinds the bridge acts on.
 *
 * `11` is an inline-keyboard button — the kind every keyboard this bridge sends
 * produces. `12` is a custom-menu callback, which carries its identity in
 * `feature_id` rather than `button_data`; it is accepted so a menu entry can be
 * wired to the same handlers without touching this layer again.
 */
const INTERACTION_TYPE = {
  inlineKeyboard: 11,
  callbackCommand: 12,
}

/** `message_type` values the platform documents. */
const MESSAGE_TYPE = {
  text: 0,
  ark: 3,
  parallel: 101,
  chatRecord: 102,
  quote: 103,
}

/** Attachment MIME types that can be admitted as a DSH image block. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * Parse `message_scene.ext`, which the platform sends as a list of
 * `key=value` strings rather than an object.
 *
 * @param ext - the raw list.
 * @returns A plain object of the decoded pairs.
 */
export function parseSceneExt(ext) {
  const out = {}
  if (!Array.isArray(ext)) return out
  for (const entry of ext) {
    if (typeof entry !== 'string') continue
    const at = entry.indexOf('=')
    if (at <= 0) continue
    out[entry.slice(0, at)] = entry.slice(at + 1)
  }
  return out
}

/**
 * Extract the quoted message a reply carries.
 *
 * A quote arrives as `message_type: 103` plus a `msg_elements` list and a
 * `ref_msg_idx` naming which element was quoted. Resolving it lets the agent
 * see who said what, instead of a bare reply with no antecedent.
 *
 * @param data - the raw dispatch body.
 * @returns The quoted author and text, or null when this is not a quote.
 */
export function extractQuote(data) {
  if (data?.message_type !== MESSAGE_TYPE.quote) return null
  const elements = Array.isArray(data?.msg_elements) ? data.msg_elements : []
  if (elements.length === 0) return null
  const refIdx = parseSceneExt(data?.message_scene?.ext)?.ref_msg_idx
  const chosen = (refIdx === undefined ? undefined : elements.find((element) => element?.msg_idx === refIdx)) ?? elements[0]
  if (chosen === null || typeof chosen !== 'object') return null
  const author = typeof chosen.author?.username === 'string' && chosen.author.username !== ''
    ? chosen.author.username
    : (typeof chosen.author?.member_openid === 'string' ? chosen.author.member_openid : '某人')
  const content = typeof chosen.content === 'string' ? chosen.content : ''
  return { author, content }
}

/**
 * Render a card (ARK) message as text, since the model cannot read the card.
 *
 * @param arkData - the raw `ark_data`.
 * @returns A readable one-line summary, or an empty string.
 */
export function describeArk(arkData) {
  if (arkData === null || typeof arkData !== 'object') return ''
  const fields = arkData.fields !== null && typeof arkData.fields === 'object' ? arkData.fields : {}
  const parts = []
  if (typeof arkData.prompt === 'string' && arkData.prompt !== '') parts.push(arkData.prompt)
  const name = typeof arkData.ark_name === 'string' ? arkData.ark_name : ''
  const title = typeof fields.title === 'string' ? fields.title : ''
  const desc = typeof fields.desc === 'string' ? fields.desc : ''
  const source = typeof fields.source === 'string' ? fields.source : ''
  const head = [name, title].filter((part) => part !== '').join(' ')
  if (head !== '') parts.push(head)
  if (desc !== '') parts.push(desc)
  if (source !== '') parts.push(`（来源：${source}）`)
  return parts.join('：')
}

/**
 * Normalize one attachment list into the bridge's shape.
 *
 * @param attachments - the raw `attachments` array.
 * @returns One entry per usable attachment.
 */
export function normalizeAttachments(attachments) {
  if (!Array.isArray(attachments)) return []
  const out = []
  for (const item of attachments) {
    if (item === null || typeof item !== 'object') continue
    const url = typeof item.url === 'string' ? item.url : ''
    if (url === '') continue
    const contentType = typeof item.content_type === 'string' ? item.content_type : ''
    out.push({
      url,
      contentType,
      isImage: IMAGE_TYPES.has(contentType),
      filename: typeof item.filename === 'string' ? item.filename : '',
      size: typeof item.size === 'number' ? item.size : undefined,
      width: typeof item.width === 'number' ? item.width : undefined,
      height: typeof item.height === 'number' ? item.height : undefined,
      /** Present for `content_type: 'voice'`; the platform's WAV transcode. */
      voiceWavUrl: typeof item.voice_wav_url === 'string' ? item.voice_wav_url : '',
      /** Present for voice; the platform's own speech-to-text hint. */
      asrText: typeof item.asr_refer_text === 'string' ? item.asr_refer_text : '',
    })
  }
  return out
}

/**
 * Describe attachments the model cannot receive inline, so a file or video at
 * least announces itself instead of vanishing.
 *
 * @param attachments - normalized attachments.
 * @returns One bracketed line per attachment, or an empty string.
 */
export function describeAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return ''
  const lines = []
  for (const attachment of attachments) {
    if (attachment.isImage) continue
    if (attachment.contentType === 'voice') {
      const heard = attachment.asrText !== '' ? `转写：${attachment.asrText}` : '（无法转写）'
      lines.push(`[语音消息 ${heard}]`)
      continue
    }
    const name = attachment.filename !== '' ? attachment.filename : '未命名文件'
    const size = attachment.size === undefined ? '' : ` ${Math.max(1, Math.round(attachment.size / 1024))}KB`
    lines.push(`[附件：${name}${size}（${attachment.contentType || '未知类型'}）]`)
  }
  return lines.join('\n')
}

/**
 * Normalize a gateway dispatch.
 *
 * @param eventName - the dispatch `t` value.
 * @param data - the dispatch `d` value.
 * @returns The normalized message, or null for an event this bridge ignores.
 */
export function normalizeMessage(eventName, data) {
  if (data === null || typeof data !== 'object') return null

  let kind
  let peerId
  let userId
  let userName
  let memberRole
  if (eventName === EVENT_C2C) {
    kind = 'private'
    peerId = data.author?.user_openid
    userId = data.author?.user_openid
    userName = data.author?.username
  } else if (eventName === EVENT_GROUP_AT || eventName === EVENT_GROUP_ALL) {
    // Full-mode and @-mention events carry the same body; the only difference
    // is whether the group had to mention the bot to be delivered at all.
    kind = 'group'
    peerId = data.group_openid
    userId = data.author?.member_openid
    userName = data.author?.username
    memberRole = data.author?.member_role
  } else {
    return null
  }

  if (typeof peerId !== 'string' || peerId === '') return null

  const attachments = normalizeAttachments(data.attachments)
  const scene = parseSceneExt(data.message_scene?.ext)

  return {
    kind,
    /** The send target: a user OpenID in private, a group OpenID in a group. */
    peerId,
    /** The person who spoke. */
    userId: typeof userId === 'string' ? userId : '',
    userName: typeof userName === 'string' && userName !== '' ? userName : 'QQ 用户',
    memberRole: typeof memberRole === 'string' ? memberRole : undefined,
    /** The inbound message id, required to answer passively. */
    messageId: typeof data.id === 'string' ? data.id : '',
    text: typeof data.content === 'string' ? data.content : '',
    timestamp: typeof data.timestamp === 'string' ? data.timestamp : '',
    messageType: typeof data.message_type === 'number' ? data.message_type : MESSAGE_TYPE.text,
    quote: extractQuote(data),
    ark: describeArk(data.ark_data),
    attachments,
    /** The per-message authorization token the platform attaches, if any. */
    authToken: typeof scene.auth_token === 'string' ? scene.auth_token : '',
    /** The platform's message index, useful for correlation. */
    msgIdx: typeof scene.msg_idx === 'string' ? scene.msg_idx : '',
  }
}

/**
 * Compose the text handed to the DSH agent for one inbound QQ message.
 *
 * Group traffic is prefixed with the speaker so the agent can tell members
 * apart, and a quote is rendered as context rather than as the message itself,
 * mirroring how the reference bridge taught the model who was being answered.
 *
 * Every optional field is tested for presence rather than compared against a
 * sentinel: this assembles text from an external protocol, where an absent
 * field arrives as `undefined` and a `!== null` guard would let it through.
 *
 * @param message - a normalized message.
 * @returns The prompt text.
 */
export function buildPromptText(message) {
  const parts = []
  if (message?.kind === 'group') parts.push(`[QQ群 ${message.userName ?? 'QQ 用户'}]`)

  const quote = message?.quote
  if (quote !== null && quote !== undefined) {
    const quoted = typeof quote.content === 'string' && quote.content !== '' ? quote.content : '（非文本消息）'
    parts.push(`[引用 ${quote.author ?? '某人'}：${quoted}]`)
  }

  if (typeof message?.text === 'string' && message.text !== '') parts.push(message.text)
  if (typeof message?.ark === 'string' && message.ark !== '') parts.push(`[卡片消息：${message.ark}]`)

  const attachmentText = describeAttachments(message?.attachments)
  if (attachmentText !== '') parts.push(attachmentText)
  if (parts.length === 0) parts.push('（空消息）')
  return parts.join(' ')
}

/**
 * Select the attachments that can be admitted to DSH as inline images.
 *
 * @param message - a normalized message.
 * @returns The image attachments, in arrival order.
 */
export function imageAttachments(message) {
  const attachments = message?.attachments
  if (!Array.isArray(attachments)) return []
  return attachments.filter((attachment) => attachment.isImage)
}


/**
 * Normalize one `INTERACTION_CREATE` dispatch into the bridge's shape.
 *
 * A button click is a message the operator sent by other means, so it is
 * normalized to the same conversation identity a typed message would carry —
 * that is what lets the existing admission rules, pending-interaction registry,
 * and command handlers apply to it unchanged.
 *
 * Two different ids ride on one click, and they are not interchangeable. The
 * payload's own `id` is the INTERACTION id, which is what `PUT
 * /interactions/{id}` acknowledges. The ENVELOPE's id is the event id, which is
 * what a passive reply message sends as `event_id` — the platform's send
 * endpoint documents that field as coming from "the outermost id of the event",
 * and sending the payload id there is refused with `40034025 请求参数event_id
 * 无效`. The envelope one is only available from the transport, so it arrives
 * as a separate argument.
 *
 * @param eventName - the raw dispatch name.
 * @param data - the raw dispatch body.
 * @param envelopeId - the dispatch frame's own id, when it carried one.
 * @returns A normalized interaction, or null when it is not one this bridge acts on.
 */
export function normalizeInteraction(eventName, data, envelopeId = '') {
  if (eventName !== EVENT_INTERACTION) return null
  if (data === null || typeof data !== 'object') return null

  const type = data.data?.type
  if (type !== INTERACTION_TYPE.inlineKeyboard && type !== INTERACTION_TYPE.callbackCommand) return null

  let kind
  let peerId
  let userId
  if (data.scene === 'c2c') {
    kind = 'private'
    peerId = data.user_openid
    userId = data.user_openid
  } else if (data.scene === 'group') {
    kind = 'group'
    peerId = data.group_openid
    userId = data.group_member_openid
  } else {
    // Channel and direct-message scenes have no send target this bridge owns.
    return null
  }
  if (typeof peerId !== 'string' || peerId === '') return null

  const resolved = data.data?.resolved ?? {}
  const payload = type === INTERACTION_TYPE.callbackCommand ? resolved.feature_id : resolved.button_data
  if (typeof payload !== 'string' || payload === '') return null

  return {
    kind,
    /** The send target, as for an inbound message. */
    peerId,
    /** The person who clicked. */
    userId: typeof userId === 'string' ? userId : '',
    /** The interaction id `PUT /interactions/{id}` acknowledges. */
    interactionId: typeof data.id === 'string' ? data.id : '',
    /**
     * The envelope id a passive reply message sends as `event_id`. Empty when
     * the frame carried none, in which case the caller has no event target and
     * must fall back to the conversation's own reply cursor.
     */
    eventId: typeof envelopeId === 'string' ? envelopeId : '',
    /** The opaque payload the button carried. */
    buttonData: payload,
    buttonId: typeof resolved.button_id === 'string' ? resolved.button_id : '',
    timestamp: typeof data.timestamp === 'string' ? data.timestamp : '',
  }
}
