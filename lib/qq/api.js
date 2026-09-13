/**
 * QQ Bot OpenAPI client: the HTTPS half of the official channel.
 *
 * Every call goes to the unified host `https://api.bot.qq.com` with
 * `Authorization: QQBot <access_token>`. The platform reports business
 * failures as HTTP 200 with a non-zero `code` in the body, so the body — not
 * the status line — decides success; {@link QqApiError} carries that code.
 *
 * An authentication failure (HTTP 401, or the platform's token codes) drops the
 * cached token and retries the call exactly once, which is what makes a token
 * that expired mid-flight self-heal instead of surfacing to the agent.
 *
 * @module dsh-qq/qq/api
 */

import { createHash } from 'node:crypto'

/** Unified OpenAPI host. */
export const API_BASE = 'https://api.bot.qq.com'

/** `msg_type` values the send endpoints accept. */
export const MSG_TYPE = {
  /** Plain text, carried in `content`. */
  text: 0,
  /** Markdown, carried in `markdown`. */
  markdown: 2,
  /** Typing indicator, carried in `input_notify`. */
  inputNotify: 6,
  /** Rich media, carried in `media`. */
  media: 7,
}

/** `file_type` values the rich-media endpoints accept. */
export const FILE_TYPE = {
  image: 1,
  video: 2,
  voice: 3,
  file: 4,
}

/**
 * Image types the platform actually renders as an image.
 *
 * The docs name png and jpg; anything else is refused by the platform with
 * `850019 不支持的文件格式`, which is a worse error to surface than a refusal
 * that says to convert it first.
 */
export const IMAGE_MEDIA_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
])

/** The platform's soft limit for an image; larger files degrade to a document. */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024

/**
 * How long one OpenAPI call may take before it is abandoned.
 *
 * Without a deadline a stalled request is not a failure: the promise never
 * settles, so nothing retries and nothing is logged. That is how a restart once
 * left the channel mute for fifteen minutes — the gateway-discovery call simply
 * hung, and the reconnect logic never got a chance to run.
 */
export const REQUEST_TIMEOUT_MS = 30 * 1000

/**
 * How long one presigned upload PUT may take.
 *
 * Longer than an API call because it carries a chunk of a file, and a slow link
 * is not a broken one.
 */
export const UPLOAD_TIMEOUT_MS = 120 * 1000

/** The platform's soft limit for a document attachment. */
export const FILE_MAX_BYTES = 200 * 1024 * 1024

/** How much of the file the platform wants hashed on its own (`md5_10m`). */
const TEN_MEGABYTES = 10_024_320

/** Platform error codes that mean "the token is no longer good". */
const AUTH_ERROR_CODES = new Set([11244, 11245, 100007])

/**
 * The media path prefix for a conversation kind.
 *
 * Private and group share every rich-media endpoint's shape and differ only in
 * this segment, so the two are built from one place rather than duplicated.
 *
 * @param kind - `'private'` or `'group'`.
 * @param peerId - the conversation's OpenID.
 * @returns A path prefix such as `/v2/groups/<openid>`.
 */
function mediaBase(kind, peerId) {
  const segment = kind === 'group' ? 'groups' : 'users'
  return `/v2/${segment}/${encodeURIComponent(peerId)}`
}

/**
 * Hash a buffer the way the upload API names it.
 *
 * @param algorithm - `'md5'` or `'sha1'`.
 * @param data - the bytes.
 * @returns Lowercase hex.
 */
function hashOf(algorithm, data) {
  return createHash(algorithm).update(data).digest('hex')
}

/**
 * Parts in upload order.
 *
 * The response is documented as ordered, but the upload is positional: a part
 * PUT to the wrong index corrupts the file, so the order is made explicit.
 *
 * @param parts - the prepared parts.
 * @returns The same parts sorted by index.
 */
function orderedParts(parts) {
  return [...parts].sort((left, right) => Number(left?.index ?? 0) - Number(right?.index ?? 0))
}

/**
 * The block size to slice parts by.
 *
 * @param prepared - the `upload_prepare` response.
 * @param parts - its parts.
 * @returns A positive byte count.
 */
function blockSizeOf(prepared, parts) {
  const declared = Number.parseInt(String(prepared?.block_size ?? ''), 10)
  if (Number.isSafeInteger(declared) && declared > 0) return declared
  const perPart = Number.parseInt(String(parts[0]?.block_size ?? ''), 10)
  return Number.isSafeInteger(perPart) && perPart > 0 ? perPart : 5 * 1024 * 1024
}

/** Platform error code for "you are sending too fast". */
const RATE_LIMIT_CODES = new Set([100001, 11253])

/** Raised when the platform refuses an OpenAPI call. */
export class QqApiError extends Error {
  /**
   * @param message - human-readable failure summary.
   * @param options - platform code, HTTP status, and cause.
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'QqApiError'
    /** Platform business code, when the body carried one. */
    this.code = options.code
    /** HTTP status line. */
    this.status = options.status
    /** Whether the failure was the platform throttling this bot. */
    this.rateLimited = RATE_LIMIT_CODES.has(options.code)
    /** Whether the failure was an unusable token. */
    this.authFailed = options.status === 401 || AUTH_ERROR_CODES.has(options.code)
  }
}

/**
 * The HTTPS client for one bot.
 */
export class QqApi {
  #tokens
  #fetch
  #base
  #timeoutMs
  #uploadTimeoutMs
  #log
  /**
   * @param options - token source, transport, and base URL.
   * @param options.tokens - the bot's {@link import('./token.js').QqTokenProvider}.
   * @param options.fetchImpl - fetch implementation; defaults to the global.
   * @param options.baseUrl - OpenAPI host override (tests).
   * @param options.log - sink for request diagnostics.
   */
  constructor({ tokens, fetchImpl, baseUrl, log, timeoutMs = REQUEST_TIMEOUT_MS, uploadTimeoutMs = UPLOAD_TIMEOUT_MS }) {
    this.#timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : REQUEST_TIMEOUT_MS
    this.#uploadTimeoutMs = Number.isFinite(uploadTimeoutMs) && uploadTimeoutMs > 0 ? uploadTimeoutMs : UPLOAD_TIMEOUT_MS
    this.#tokens = tokens
    this.#fetch = fetchImpl ?? globalThis.fetch
    this.#base = baseUrl ?? API_BASE
    this.#log = log ?? (() => {})
  }

  /**
   * Resolve the WebSocket gateway URL ("获取通用 WSS 接入点").
   *
   * @returns The `wss://` URL events are delivered on.
   * @throws {QqApiError} when the platform refuses or returns no URL.
   */
  async getGateway() {
    const body = await this.#request('GET', '/gateway')
    const url = body?.url
    if (typeof url !== 'string' || url === '') {
      throw new QqApiError('QQ gateway response carried no url', { code: body?.code })
    }
    return url
  }

  /**
   * Send one message to a user's private (C2C) conversation.
   *
   * @param userOpenId - the user's OpenID from `author.user_openid`.
   * @param payload - message body; see {@link buildMessageBody}.
   * @returns The platform's acknowledgement body.
   */
  async sendC2C(userOpenId, payload) {
    return assertAccepted(await this.#request('POST', `/v2/users/${encodeURIComponent(userOpenId)}/messages`, payload), 'C2C')
  }

  /**
   * Send one message into a group.
   *
   * @param groupOpenId - the group's OpenID from `group_openid`.
   * @param payload - message body; see {@link buildMessageBody}.
   * @returns The platform's acknowledgement body.
   */
  async sendGroup(groupOpenId, payload) {
    return assertAccepted(await this.#request('POST', `/v2/groups/${encodeURIComponent(groupOpenId)}/messages`, payload), 'group')
  }

  /**
   * Acknowledge one button click.
   *
   * The QQ client holds the tapped button in a loading state until the bot
   * answers the `INTERACTION_CREATE` event here; only type 11 (message button)
   * and type 12 (quick menu) need it, and the same id may be answered once.
   * This is separate from sending a reply message: the acknowledgement stops
   * the spinner, the message is what the operator reads.
   *
   * The response carries no `id`, so this deliberately bypasses
   * {@link assertAccepted} — that check exists to prove a *message* landed, and
   * applying it here would turn every successful acknowledgement into a
   * failure.
   *
   * @param interactionId - the event's `id`, with no `INTERACTION_CREATE:` prefix.
   * @param code - the callback outcome: 0 success, 1 failure, 4 no permission.
   * @returns The platform's (empty) acknowledgement body.
   */
  async ackInteraction(interactionId, code = 0) {
    const id = String(interactionId ?? '').replace(/^INTERACTION_CREATE:/i, '')
    if (id === '') {
      throw new QqApiError('QQ PUT /interactions/{id} needs an interaction id')
    }
    return this.#request('PUT', `/interactions/${encodeURIComponent(id)}`, { code })
  }

  /**
   * Stream one message into a user's private conversation (single-chat only).
   *
   * @param userOpenId - the user's OpenID.
   * @param payload - streaming body; carries `stream_msg_id`/`index`/`reset`.
   * @returns The platform's acknowledgement body.
   */
  async sendC2CStream(userOpenId, payload) {
    return this.#request('POST', `/v2/users/${encodeURIComponent(userOpenId)}/stream_messages`, payload)
  }

  /**
   * Upload one image to a conversation and return its `file_info`.
   *
   * A local file has exactly one route to the platform: the chunked upload.
   * The direct form takes a public `url` the platform downloads for itself, and
   * there is no base64 field — so a screenshot on this machine is hashed,
   * prepared, PUT part by part to presigned URLs, and merged.
   *
   * @param kind - `'private'` or `'group'`.
   * @param peerId - the conversation's OpenID.
   * @param options - the image.
   * @param options.data - the encoded bytes.
   * @param options.fileName - name to report to the platform.
   * @param options.concurrency - parallel part uploads; the platform's own default is 1.
   * @returns The opaque `file_info` string the send endpoint wants.
   */
  async uploadImage(kind, peerId, options) {
    return this.uploadMedia(kind, peerId, { ...options, fileType: FILE_TYPE.image })
  }

  /**
   * Upload one file and return its `file_info`.
   *
   * `file_type: 4` is the document kind: the platform renders it as a file card
   * the operator can open, which is the only way to hand a phone something
   * longer than a chat message. The transfer itself is the same chunked upload
   * as an image — same prepare, same presigned PUTs, same merge — because the
   * direct form needs a public URL and there is no base64 field.
   *
   * @param kind - `'private'` or `'group'`.
   * @param peerId - the conversation's OpenID.
   * @param options - the file.
   * @param options.data - the bytes.
   * @param options.fileName - name the recipient sees.
   * @param options.fileType - a {@link FILE_TYPE} value; defaults to `file`.
   * @returns The opaque `file_info` string the send endpoint wants.
   */
  async uploadFile(kind, peerId, options) {
    return this.uploadMedia(kind, peerId, { ...options, fileType: FILE_TYPE.file })
  }

  /**
   * Upload one media object through the chunked-upload path.
   *
   * @param kind - `'private'` or `'group'`.
   * @param peerId - the conversation's OpenID.
   * @param options - the payload.
   * @param options.data - the bytes.
   * @param options.fileName - name to report to the platform.
   * @param options.fileType - a {@link FILE_TYPE} value.
   * @param options.concurrency - unused today; the platform's own default is 1.
   * @returns The opaque `file_info` string.
   */
  async uploadMedia(kind, peerId, { data, fileName, fileType = FILE_TYPE.image }) {
    const base = mediaBase(kind, peerId)
    const name = typeof fileName === 'string' && fileName.trim() !== '' ? fileName.trim() : 'file.bin'
    const prepared = await this.#request('POST', `${base}/upload_prepare`, {
      file_type: fileType,
      // The platform takes these as strings, not numbers.
      file_size: String(data.byteLength),
      file_name: name,
      md5: hashOf('md5', data),
      sha1: hashOf('sha1', data),
      md5_10m: hashOf('md5', data.subarray(0, TEN_MEGABYTES)),
    })

    const uploadId = prepared?.upload_id
    const parts = Array.isArray(prepared?.parts) ? prepared.parts : []
    if (typeof uploadId !== 'string' || uploadId === '' || parts.length === 0) {
      throw new QqApiError('QQ upload_prepare answered without an upload id or parts')
    }

    // Byte ranges come from the ORDER of the list, never from `index * block_size`.
    // The docs say the first part's index is 0; the live platform returns 1, and
    // a positional computation against a 1-based index slices at `size + 1`
    // blocks — past the end of the file — so every part goes up EMPTY and the
    // platform then answers `850019 富媒体文件格式不支持` for the merged result.
    // Walking the parts in order with a running offset is correct for either
    // convention, which is the only property worth depending on.
    const blockSize = blockSizeOf(prepared, parts)
    let offset = 0
    for (const part of orderedParts(parts)) {
      const parsedIndex = Number.parseInt(String(part?.index ?? ''), 10)
      const index = Number.isSafeInteger(parsedIndex) && parsedIndex >= 0 ? parsedIndex : 0
      // Each part declares its own size, and the last one is the remainder:
      // slicing every part at the block size would drop the tail of the file.
      const declared = Number.parseInt(String(part?.block_size ?? ''), 10)
      const length = Number.isSafeInteger(declared) && declared > 0 ? declared : blockSize
      const slice = data.subarray(offset, Math.min(offset + length, data.byteLength))
      offset += slice.byteLength
      await this.#putBinary(String(part?.presigned_url ?? ''), slice)
      await this.#request('POST', `${base}/upload_part_finish`, {
        upload_id: uploadId,
        part_index: index,
        block_size: String(slice.byteLength),
        md5: hashOf('md5', slice),
      })
    }

    // Merging is the same endpoint as a direct upload, addressed by upload_id
    // instead of url; `srv_send_msg: false` keeps it an upload, because the
    // message is sent separately with its own text.
    const merged = await this.#request('POST', `${base}/files`, {
      file_type: fileType,
      file_name: name,
      upload_id: uploadId,
      srv_send_msg: false,
    })
    const fileInfo = merged?.file_info
    if (typeof fileInfo !== 'string' || fileInfo === '') {
      throw new QqApiError('QQ rich-media merge answered without a file_info')
    }
    return fileInfo
  }

  /**
   * Send an already-uploaded image.
   *
   * @param kind - `'private'` or `'group'`.
   * @param peerId - the conversation's OpenID.
   * @param fileInfo - the value {@link QqApi.uploadImage} returned.
   * @returns The platform's acknowledgement body.
   */
  async sendImage(kind, peerId, fileInfo) {
    return this.sendMedia(kind, peerId, fileInfo)
  }

  /**
   * Send an already-uploaded file.
   *
   * The document kind travels in the upload, not in the message: a file card and
   * an image card are the same `msg_type` with the same `media.file_info`, and
   * the platform decides how to present it from what was uploaded.
   *
   * @param kind - `'private'` or `'group'`.
   * @param peerId - the conversation's OpenID.
   * @param fileInfo - the value an upload returned.
   * @returns The platform's acknowledgement body.
   */
  async sendFile(kind, peerId, fileInfo) {
    return this.sendMedia(kind, peerId, fileInfo)
  }

  /**
   * Send one uploaded media object.
   *
   * @param kind - `'private'` or `'group'`.
   * @param peerId - the conversation's OpenID.
   * @param fileInfo - the value an upload returned.
   * @returns The platform's acknowledgement body.
   */
  async sendMedia(kind, peerId, fileInfo) {
    const payload = { msg_type: MSG_TYPE.media, media: { file_info: fileInfo } }
    return kind === 'group' ? this.sendGroup(peerId, payload) : this.sendC2C(peerId, payload)
  }

  /**
   * Upload one binary part to a presigned URL.
   *
   * Deliberately outside {@link QqApi#request}: a presigned URL carries its own
   * authorization, and adding the bot's `Authorization` header — or a JSON
   * content type — makes the storage backend reject the PUT.
   *
   * @param url - the presigned URL.
   * @param body - the bytes for this part.
   * @returns A promise settling when the part is stored.
   */
  async #putBinary(url, body) {
    if (url === '') throw new QqApiError('QQ part upload was given no presigned url')
    let response
    try {
      response = await this.#fetch(url, { method: 'PUT', body, signal: AbortSignal.timeout(this.#uploadTimeoutMs) })
    } catch (error) {
      throw new QqApiError(`QQ PUT of an upload part failed: ${String(error?.message ?? error)}`, { cause: error })
    }
    if (!(response.status >= 200 && response.status < 300)) {
      throw new QqApiError(`QQ PUT of an upload part failed: HTTP ${String(response.status)}`)
    }
  }

  /**
   * Issue one authenticated OpenAPI request, retrying once when the platform
   * reports the token as unusable.
   *
   * @param method - HTTP method.
   * @param path - path below the unified host.
   * @param body - optional JSON body.
   * @returns The parsed response body.
   * @throws {QqApiError} on transport failure or a non-zero platform code.
   */
  async #request(method, path, body) {
    let lastError = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let token
      try {
        token = await this.#tokens.get()
      } catch (error) {
        throw new QqApiError(`QQ ${method} ${path} could not obtain a token: ${String(error?.message ?? error)}`, { cause: error })
      }

      let response
      try {
        response = await this.#fetch(`${this.#base}${path}`, {
          method,
          headers: {
            Authorization: `QQBot ${token}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.#timeoutMs),
        })
      } catch (error) {
        throw new QqApiError(`QQ ${method} ${path} transport failed: ${String(error?.message ?? error)}`, { cause: error })
      }

      const parsed = await readJson(response)
      const code = parsed?.code
      const ok = response.status >= 200 && response.status < 300 && (code === undefined || code === 0)
      if (ok) return parsed

      const message = parsed?.message ?? parsed?.msg ?? response.statusText ?? 'unknown error'
      const error = new QqApiError(`QQ ${method} ${path} failed: ${String(message)}`, {
        code,
        status: response.status,
      })

      // A stale token is the one failure worth retrying: drop it and loop.
      if (error.authFailed && attempt === 0) {
        this.#log(`QQ ${method} ${path} rejected the token (code ${String(code)}); refreshing and retrying once`)
        this.#tokens.invalidate()
        lastError = error
        continue
      }
      throw error
    }
    throw lastError ?? new QqApiError(`QQ ${method} ${path} failed`)
  }
}

/**
 * Confirm a send response actually accepted a message.
 *
 * A successful send answers `{ id, timestamp }`, where `id` is the new
 * message's identity. The platform has been observed answering HTTP 200 with a
 * body that carries no `id` while the message was never delivered — most often
 * after a gateway disconnect — so the presence of `id` is the only reliable
 * evidence of acceptance. Treating a body without it as a failure is what keeps
 * an answer from being silently lost.
 *
 * @param body - the parsed response body.
 * @param scope - `'C2C'` or `'group'`, for the error message.
 * @returns The same body when it carries a message id.
 * @throws {QqApiError} when it does not.
 */
function assertAccepted(body, scope) {
  const id = body?.id
  if (typeof id === 'string' && id !== '') return body
  throw new QqApiError(
    `QQ ${scope} send was acknowledged without a message id, so it was not delivered (response: ${JSON.stringify(body)})`,
    { code: body?.code },
  )
}

/**
 * Read a response body as JSON without throwing on an empty or malformed body,
 * because the platform signals failure through the body rather than the status.
 *
 * @param response - the fetch response.
 * @returns The parsed body, or null when there is nothing to parse.
 */
async function readJson(response) {
  try {
    const text = await response.text()
    if (text === '') return null
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Build a send-endpoint body.
 *
 * `msg_id` turns the message into a PASSIVE reply, which is the only way to
 * answer inside the documented windows (private 60 minutes / 4 replies, group
 * 5 minutes / 5 replies). `msg_seq` distinguishes several replies to the SAME
 * `msg_id`: repeating a `msg_id`+`msg_seq` pair is rejected, so a caller
 * sending multiple parts must increment it.
 *
 * @param options - message shape.
 * @param options.text - plain-text content, used when `markdown` is absent.
 * @param options.markdown - markdown content; takes precedence over `text`.
 * @param options.replyToMessageId - the inbound `id` to answer passively.
 * @param options.msgSeq - reply ordinal for that `id`; defaults to 1.
 * @param options.eventId - the event `id` to answer passively, used for
 *   `INTERACTION_CREATE` and the group receive/add events. Mutually exclusive
 *   with `replyToMessageId`: a click's event id sent as a `msg_id` is refused
 *   with `40034024 请求参数msg_id无效或越权`.
 * @param options.isWakeup - request the interaction-recall allowance.
 * @returns A body for {@link QqApi.sendC2C} or {@link QqApi.sendGroup}.
 */
export function buildMessageBody({ text, markdown, replyToMessageId, msgSeq, eventId, isWakeup, keyboard }) {
  const body = {}
  if (typeof markdown === 'string' && markdown !== '') {
    body.msg_type = MSG_TYPE.markdown
    body.markdown = { content: markdown }
  } else {
    body.msg_type = MSG_TYPE.text
    body.content = typeof text === 'string' ? text : ''
  }
  if (typeof replyToMessageId === 'string' && replyToMessageId !== '') {
    body.msg_id = replyToMessageId
    body.msg_seq = Number.isSafeInteger(msgSeq) && msgSeq > 0 ? msgSeq : 1
  } else if (typeof eventId === 'string' && eventId !== '') {
    // `msg_seq` is documented as scoped to `msg_id`, so it is deliberately not
    // sent beside an event target.
    body.event_id = eventId
  }
  if (isWakeup === true) body.is_wakeup = true
  // An inline keyboard rides along with whichever content type was chosen; it
  // is a sibling field, not a message type of its own.
  if (keyboard !== undefined && keyboard !== null) body.keyboard = keyboard
  return body
}
