/**
 * Outbound path: agent output becomes QQ messages.
 *
 * Three platform rules shape this module, and each has a failure mode that only
 * shows up in production:
 *
 * 1. **Length.** QQ rejects over-long bodies, so a long answer is split. Chunks
 *    of one answer must keep their order, so sends are serialized per
 *    conversation rather than fired concurrently.
 * 2. **Passive windows.** A reply carrying `msg_id` is passive and exempt from
 *    the active-message quota, but the window is short — 60 minutes and 4
 *    replies in private, 5 minutes and 5 replies in a group. An agent turn can
 *    easily outlive the group window, so each chunk tries passive first and
 *    falls back to an active send when the window is spent.
 * 3. **Pacing.** The platform throttles both per second and per minute. A fixed
 *    inter-message delay keeps a multi-chunk answer under those ceilings.
 *
 * @module dsh-qq/bridge/outbound
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildMessageBody } from '../qq/api.js'
import { markdownToPlain, splitByBytes } from '../md-to-plain.js'

/** Documented passive-reply allowance per inbound message. */
export const REPLY_LIMIT = {
  private: 4,
  group: 5,
}

/**
 * How long the platform keeps a passive reply target valid, per conversation.
 *
 * The reply *count* is not the whole rule: a group target dies five minutes
 * after the message arrived whether or not any of its five replies were used,
 * and a turn that reasons for longer than that finds the target already gone.
 * The local counter cannot see a clock, which is why the armed-at time is
 * recorded and checked here.
 */
export const REPLY_WINDOW_MS = {
  private: 60 * 60_000,
  group: 5 * 60_000,
}

/**
 * Whether a send failure means the passive reply target is unusable.
 *
 * Three failures qualify. An EXPIRED target answers in prose ("msgid已经过期,
 * 不能回复") rather than a documented business code, so that match is on the
 * wording. An INVALID OR UNAUTHORIZED target (`40034024`) is the platform
 * refusing the request outright — what a click's interaction id looks like when
 * it is sent as a `msg_id`. An INVALID EVENT target (`40034025`) is the same
 * refusal for the other passive field.
 *
 * All three prove the message was NOT delivered, which is what makes the active
 * retry safe. The match stays narrow for exactly that reason: retrying a send
 * that may actually have landed would duplicate the message.
 *
 * @param error - the send failure.
 * @returns Whether the target is dead and an active retry is safe.
 */
function isDeadReplyTarget(error) {
  return /过期|expired|无效/i.test(String(error?.message ?? error ?? ''))
}

/** Turn text longer than this is summarized rather than sent whole. */
const DEFAULT_MAX_BYTES = 3_500

/** Delay between consecutive sends to one conversation. */
const DEFAULT_INTERVAL_MS = 1_200

/**
 * How many chunks an answer may occupy before it is sent as a file instead.
 *
 * The limit exists because of what a long answer costs, measured on a live
 * deployment: the passive reply window is spent partway through it ("passive
 * reply window spent" recurs in the log), the remaining chunks then consume the
 * active-message quota, and when the operator has switched active messages off
 * the tail of the answer is lost with no way to retrieve it. One file card is a
 * single send and carries the whole text.
 */
const DEFAULT_LONG_ANSWER_CHUNKS = 4

/**
 * Sends agent output to QQ, one conversation at a time.
 */
export class Outbound {
  #api
  #sessions
  #log
  #config
  #chains = new Map()
  #lastFailure = null

  /**
   * @param options - transport, reply cursor, and pacing.
   * @param options.api - the OpenAPI client.
   * @param options.sessions - the conversation table holding reply cursors.
   * @param options.log - sink for send diagnostics.
   * @param options.config - live settings accessor; see {@link Outbound#readConfig}.
   */
  constructor({ api, sessions, log, config }) {
    this.#api = api
    this.#sessions = sessions
    this.#log = log ?? (() => {})
    this.#config = config ?? (() => ({}))
  }

  /**
   * The most recent send failure, or null when the last send succeeded.
   *
   * Send failures used to be visible only in the process log, which is exactly
   * what a bridge operator reading QQ cannot see. `/status` reports this so a
   * silent channel is diagnosable from the surface that is still reachable.
   *
   * @returns `{ key, message, at }`, or null.
   */
  get lastFailure() {
    return this.#lastFailure
  }

  /** Current pacing, encoding, and long-answer settings. */
  #read() {
    const raw = this.#config() ?? {}
    return {
      maxBytes: Number.isSafeInteger(raw.maxBytes) && raw.maxBytes > 0 ? raw.maxBytes : DEFAULT_MAX_BYTES,
      intervalMs: Number.isSafeInteger(raw.intervalMs) && raw.intervalMs >= 0 ? raw.intervalMs : DEFAULT_INTERVAL_MS,
      markdownMode: raw.markdownMode === 'always' || raw.markdownMode === 'never' ? raw.markdownMode : 'auto',
      longAnswerChunks: Number.isSafeInteger(raw.longAnswerChunks) && raw.longAnswerChunks >= 0 ? raw.longAnswerChunks : DEFAULT_LONG_ANSWER_CHUNKS,
    }
  }

  /**
   * Queue one answer for a conversation, preserving per-conversation order.
   *
   * @param options - delivery request.
   * @param options.key - the conversation key holding the reply cursor.
   * @param options.kind - `'private'` or `'group'`.
   * @param options.peerId - the OpenID to send to.
   * @param options.text - the answer, in markdown or plain text.
   * @param options.keyboard - optional inline keyboard attached to the last chunk.
   * @returns A promise settling when every chunk has been attempted.
   */
  deliver({ key, kind, peerId, text, keyboard }) {
    const previous = this.#chains.get(key) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(() => this.#deliverNow({ key, kind, peerId, text, keyboard }))
    this.#chains.set(key, next)
    // Drop the chain entry once it is the tail, so the map cannot grow forever.
    // The `catch` is load-bearing: `finally` derives a NEW promise, and a send
    // that rejected would otherwise surface as an unhandled rejection the
    // moment this bookkeeping promise is collected.
    next.finally(() => {
      if (this.#chains.get(key) === next) this.#chains.delete(key)
    }).catch(() => {})
    return next
  }

  /**
   * Send one answer without touching the reply cursor, for messages the agent
   * initiates rather than answers.
   *
   * @param options - delivery request without a reply target.
   * @param options.key - the conversation key, used only for ordering.
   * @param options.kind - `'private'` or `'group'`.
   * @param options.peerId - the OpenID to send to.
   * @param options.text - the message text.
   * @param options.keyboard - optional inline keyboard attached to the last chunk.
   * @returns A promise settling when every chunk has been attempted.
   */
  sendActive({ key, kind, peerId, text, keyboard }) {
    const previous = this.#chains.get(key) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(() => {
        const prepared = this.#prepare(text, keyboard, key)
        return this.#sendChunks({ key, kind, peerId, chunks: prepared.chunks, body: prepared.body, usePassive: false, keyboard, markdown: prepared.markdown })
      })
    this.#chains.set(key, next)
    next.finally(() => {
      if (this.#chains.get(key) === next) this.#chains.delete(key)
    }).catch(() => {})
    return next
  }

  /**
   * Send one message that quotes a specific inbound message.
   *
   * Quoting requires `msg_id`, which makes the send passive — so it consumes a
   * reply slot and is only valid while the window lasts. The caller takes the
   * slot, because only it knows whether the quote is worth spending one on.
   *
   * @param options - quoted delivery request.
   * @param options.key - the conversation key, used for ordering.
   * @param options.kind - `'private'` or `'group'`.
   * @param options.peerId - the OpenID to send to.
   * @param options.text - the message text.
   * @param options.msgId - the inbound message id to quote.
   * @param options.msgSeq - the reply ordinal for that id.
   * @returns A promise settling when the send has been attempted.
   */
  sendQuoted({ key, kind, peerId, text, msgId, msgSeq }) {
    const previous = this.#chains.get(key) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(async () => {
        // No keyboard reaches this path (`sendQuoted` has no such parameter),
        // and naming one used to be a ReferenceError here: every `qq_reply`
        // call threw before it sent anything, which the tool tests could not
        // see because their sender is a double.
        const prepared = this.#prepare(text, undefined, key)
        const chunks = prepared.chunks
        if (chunks.length === 0) return
        const { intervalMs } = this.#read()
        for (let index = 0; index < chunks.length; index += 1) {
          if (index > 0 && intervalMs > 0) await delay(intervalMs)
          // Only the first chunk quotes; the rest continue the same answer.
          const body = index === 0
            ? this.#body(chunks[index], { msgId, msgSeq }, undefined, prepared.markdown)
            : this.#body(chunks[index], undefined, undefined, prepared.markdown)
          try {
            await this.#send(kind, peerId, body)
          } catch (error) {
            this.#log(`${key}: quoted send failed: ${String(error?.message ?? error)}`)
            return
          }
        }
      })
    this.#chains.set(key, next)
    next.finally(() => {
      if (this.#chains.get(key) === next) this.#chains.delete(key)
    }).catch(() => {})
    return next
  }

  /**
   * Convert and split one answer into sendable chunks.
   *
   * @param text - the agent's markdown or plain output.
   * @returns The chunks in order, the whole prepared body, and the encoding.
   */
  #prepare(text, keyboard, key = '') {
    const { maxBytes, markdownMode } = this.#read()
    const markdown = this.#asMarkdown(text, keyboard, markdownMode)
    // Only the fallback is logged. Every send naming its encoding would be
    // noise, but "why did that one arrive flat" is otherwise unanswerable after
    // the fact: the decision leaves no trace anywhere else.
    if (!markdown) this.#log(`${key}: sent as plain text (mode ${markdownMode}, the body looks like a table)`)
    const body = markdown ? text : markdownToPlain(text)
    // The decision travels with the chunks. Deciding again per chunk would let
    // the two disagree - the conversion can remove the very feature the
    // decision was based on, and a message would then be sent as markdown
    // carrying text that had already been converted.
    //
    // The whole body travels too: a long answer is written to a file verbatim,
    // and reassembling it from the chunks would have to guess the newlines the
    // splitter consumed.
    return { chunks: splitByBytes(body, maxBytes), body, markdown }
  }

  /**
   * Decide whether one message goes out as markdown or as converted plain text.
   *
   * One decision, used both to prepare the text and to set the content type:
   * converting to plain text but sending `msg_type: 2`, or the reverse, would
   * deliver the wrong body.
   *
   * `auto` is the default because the platform renders bold, italics, lists,
   * quotes and rules but not tables, so a table is the one case where the
   * plain-text conversion reads better — and a keyboard forces markdown
   * regardless, because buttons only render on a markdown body.
   *
   * @param text - the agent's output.
   * @param keyboard - the inline keyboard, when one is attached.
   * @param mode - `auto`, `always` or `never`.
   * @returns Whether this message should be markdown.
   */
  #asMarkdown(text, keyboard, mode) {
    if (keyboard !== undefined) return true
    if (mode === 'always') return true
    if (mode === 'never') return false
    return canRenderAsMarkdown(text)
  }

  /**
   * Build a send body for one chunk, honouring the markdown preference.
   *
   * `buildMessageBody` picks `msg_type` from which field it is given, so the
   * choice has to be made here rather than at conversion time — otherwise
   * markdown would be converted correctly and then sent as plain text.
   *
   * @param chunk - the prepared chunk.
   * @param reply - optional passive-reply target.
   * @returns The send body.
   */
  #body(chunk, reply, keyboard, decided) {
    const { markdownMode } = this.#read()
    // A keyboard only renders on a MARKDOWN message. The platform documents
    // buttons as hanging off a markdown body, and a measured A/B against the
    // live API agrees: the identical keyboard on `msg_type: 0` was delivered
    // with the buttons silently dropped, while `msg_type: 2` rendered them.
    // So a keyboard decides the content type here, and the setting only decides
    // it for the messages that carry no buttons.
    //
    // Otherwise markdown is used whenever the platform can render the text
    // faithfully: it supports bold, italics, lists, quotes and rules, but not
    // tables, and a table sent as markdown arrives as a row of pipe characters.
    const markdown = decided === undefined ? this.#asMarkdown(chunk, keyboard, markdownMode) : decided
    const content = markdown ? { markdown: chunk } : { text: chunk }
    return buildMessageBody({
      ...content,
      ...(reply === undefined
        ? {}
        : { replyToMessageId: reply.msgId, msgSeq: reply.msgSeq, eventId: reply.eventId }),
      ...(keyboard === undefined ? {} : { keyboard }),
    })
  }

  /**
   * Send one image, uploading it first.
   *
   * Exposed here for the same reason the acknowledgement is: this class is the
   * bridge's single handle on the OpenAPI client, and the tools only ever see
   * this object.
   *
   * @param options - target and image.
   * @param options.key - the conversation key, for diagnostics only.
   * @param options.kind - `'private'` or `'group'`.
   * @param options.peerId - the target's OpenID.
   * @param options.data - the encoded bytes.
   * @param options.fileName - name to report to the platform.
   * @returns A promise settling when the image has been sent.
   */
  async sendImage({ kind, peerId, data, fileName }) {
    const fileInfo = await this.#api.uploadImage(kind, peerId, { data, fileName })
    return this.#api.sendImage(kind, peerId, fileInfo)
  }

  /**
   * Send one file, uploading it first.
   *
   * Same transfer as an image with a different `file_type`, so a report, a log
   * or a diff can reach a phone as one openable card instead of a wall of
   * messages.
   *
   * @param options - target and file.
   * @param options.kind - `'private'` or `'group'`.
   * @param options.peerId - the target's OpenID.
   * @param options.data - the bytes.
   * @param options.fileName - name the recipient sees.
   * @returns A promise settling when the file has been sent.
   */
  async sendFile({ kind, peerId, data, fileName }) {
    const fileInfo = await this.#api.uploadFile(kind, peerId, { data, fileName })
    return this.#api.sendFile(kind, peerId, fileInfo)
  }

  /**
   * Acknowledge one button click so the QQ client stops loading.
   *
   * Exposed here because this class is already the bridge's single handle on
   * the OpenAPI client, and the interaction handler only ever sees this object.
   *
   * @param interactionId - the click's event id.
   * @param code - the callback outcome: 0 success, 1 failure, 4 no permission.
   * @returns A promise settling when the platform has been told.
   */
  async ackInteraction(interactionId, code) {
    return this.#api.ackInteraction(interactionId, code)
  }

  /**
   * Deliver one answer, consuming passive reply slots while they last.
   *
   * @param request - conversation identity and text.
   * @returns A promise settling when every chunk has been attempted.
   */
  async #deliverNow({ key, kind, peerId, text, keyboard }) {
    const prepared = this.#prepare(text, keyboard, key)
    if (prepared.chunks.length === 0) return
    await this.#sendChunks({ key, kind, peerId, chunks: prepared.chunks, body: prepared.body, usePassive: true, keyboard, markdown: prepared.markdown })
  }

  /**
   * Send prepared chunks in order, pacing between them.
   *
   * @param request - chunks, the whole prepared body, and whether passive
   *   replies are allowed.
   */
  async #sendChunks({ key, kind, peerId, chunks, body, usePassive, keyboard, markdown }) {
    const { intervalMs, longAnswerChunks } = this.#read()
    const limit = kind === 'group' ? REPLY_LIMIT.group : REPLY_LIMIT.private
    const window = kind === 'group' ? REPLY_WINDOW_MS.group : REPLY_WINDOW_MS.private

    // An empty body is a failure, not a no-op. Reporting success for a message
    // that was never sent is what let a silent question prompt look delivered.
    if (chunks.length === 0) {
      const error = new Error('消息内容为空，未发送')
      this.#fail(key, error.message)
      this.#log(`${key}: nothing to send, the prepared body was empty`)
      throw error
    }

    // A long answer goes out as its opening plus one file. The alternative -
    // one message per chunk - is what exhausted the passive window on a real
    // deployment and then spent the active quota, which the operator may have
    // switched off, losing the end of the answer outright.
    if (longAnswerChunks > 0 && chunks.length > longAnswerChunks && typeof body === 'string' && body !== '') {
      const sent = await this.#sendAsFile({ key, kind, peerId, body, chunks, usePassive, keyboard, markdown, longAnswerChunks })
      // The upload failed and nothing was sent yet, so the answer still goes
      // out the ordinary way. Losing it would be the worse failure.
      if (sent) return
    }

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]
      if (index > 0 && intervalMs > 0) await delay(intervalMs)

      // Each chunk takes its own passive slot. That is deliberate: a passive
      // reply is exempt from the active-message quota, which is the scarce
      // resource (20 per minute per relationship, and the user can switch
      // active messages off entirely), while the passive window is refreshed by
      // every new inbound message.
      let reply
      if (usePassive) {
        const slot = this.#sessions.takeReplySlot(key, limit, window)
        if (slot === null) {
          this.#log(`${key}: passive reply window spent; sending chunk ${index + 1} as an active message`)
        } else {
          reply = slot
        }
      }
      // The keyboard rides on the LAST chunk so it renders under the whole
      // message rather than under a fragment of it.
      const body = this.#body(chunk, reply, index === chunks.length - 1 ? keyboard : undefined, markdown)
      if (index === 0) this.#log(`${key}: sending ${chunks.length} chunk(s) as ${markdown === false ? 'plain text' : 'markdown'}`)

      try {
        await this.#send(kind, peerId, body)
      } catch (error) {
        const detail = String(error?.message ?? error)
        this.#log(`${key}: send failed on chunk ${index + 1}/${chunks.length}: ${detail}`)
        if (error?.rateLimited === true) {
          // Backing off once is enough to clear a per-second ceiling, and
          // retrying is preferable to dropping the answer.
          await delay(2_000)
          try {
            await this.#send(kind, peerId, body)
            continue
          } catch (retryError) {
            const retryDetail = String(retryError?.message ?? retryError)
            this.#log(`${key}: retry after throttling also failed: ${retryDetail}`)
            this.#fail(key, retryDetail)
            throw retryError
          }
        }
        // A dead passive target — expired, or refused as invalid/unauthorized —
        // proves the message was NOT delivered, so spend an active message
        // rather than lose the answer, and forget the dead target so the
        // remaining chunks do not repeat the doomed attempt.
        if (reply !== undefined && isDeadReplyTarget(error)) {
          this.#sessions.clearReplyTarget(key)
          try {
            await this.#send(kind, peerId, this.#body(chunk, undefined, index === chunks.length - 1 ? keyboard : undefined))
            this.#lastFailure = null
            continue
          } catch (retryError) {
            const retryDetail = String(retryError?.message ?? retryError)
            this.#log(`${key}: active retry after a dead reply target also failed: ${retryDetail}`)
            this.#fail(key, retryDetail)
            throw retryError
          }
        }
        // Remaining chunks share the failure, so stop rather than pile up
        // errors — but surface it, so the caller does not treat a partial or
        // absent delivery as success.
        this.#fail(key, detail)
        throw error
      }
    }

    this.#lastFailure = null
  }

  /**
   * Send a long answer as its opening chunk plus one `.md` file.
   *
   * The file goes first, so the notice the opening chunk carries is true when
   * it arrives: the operator reads "the rest is in the file" only after the
   * file card is already there.
   *
   * The file is written under the OS temp directory because that is the one
   * location a bridge can assume is writable wherever it runs, and it is
   * removed on every path — a bridge that leaked one file per long answer would
   * fill the temp directory of a deployment that runs for months.
   *
   * @param request - the answer, its chunks, and the send options.
   * @param request.longAnswerChunks - the configured limit, for the log line.
   * @returns Whether the answer went out this way; false means the file could
   *   not be written or uploaded before anything was sent, and the caller
   *   should send the chunks.
   */
  async #sendAsFile({ key, kind, peerId, body, chunks, usePassive, keyboard, markdown, longAnswerChunks }) {
    const { maxBytes, intervalMs } = this.#read()
    const fileName = `dsh-qq-answer-${String(Date.now())}.md`
    const path = join(tmpdir(), fileName)
    const notice = `\n\n（回答共 ${String(chunks.length)} 段，过长；完整内容已作为文件发送：${fileName}）`
    // The notice rides on the opening chunk, so that chunk has to give up room
    // for it. Splitting first and appending afterwards would produce exactly the
    // over-long message the split exists to avoid.
    const head = splitByBytes(body, Math.max(1, maxBytes - Buffer.byteLength(notice, 'utf8')))[0] ?? chunks[0]
    this.#log(`${key}: answer is ${String(chunks.length)} chunk(s) long (limit ${String(longAnswerChunks)}); sending the opening as a message and the whole text as ${fileName}`)

    try {
      // The write is inside the fallback on purpose: an unwritable temp
      // directory must cost the file, not the answer.
      writeFileSync(path, body, 'utf8')
      try {
        const data = readFileSync(path)
        await this.sendFile({ kind, peerId, data, fileName })
      } catch (error) {
        this.#log(`${key}: long answer could not be delivered as a file (${String(error?.message ?? error)}); sending every chunk instead`)
        return false
      }
      if (intervalMs > 0) await delay(intervalMs)
      // The single message is the last - and only - one, so the keyboard that
      // would have ridden on the final chunk rides here.
      await this.#sendChunks({ key, kind, peerId, chunks: [`${head}${notice}`], usePassive, keyboard, markdown })
      return true
    } finally {
      rmSync(path, { force: true })
    }
  }

  /**
   * Remember one send failure for `/status`.
   *
   * @param key - the conversation the send was for.
   * @param message - the failure detail.
   */
  #fail(key, message) {
    this.#lastFailure = { key: String(key ?? 'unknown'), message, at: Date.now() }
  }

  /**
   * Dispatch one body to the endpoint matching the conversation kind.
   *
   * @param kind - `'private'` or `'group'`.
   * @param peerId - the OpenID to send to.
   * @param body - the send body.
   */
  async #send(kind, peerId, body) {
    if (kind === 'group') return this.#api.sendGroup(peerId, body)
    return this.#api.sendC2C(peerId, body)
  }
}

/**
 * Accumulate assistant text per session and hand back one answer per turn.
 *
 * The platform delivers an assistant message per step, so a turn that used
 * tools produces several messages. Only the last one is the answer the human
 * should read; earlier ones are narration around tool calls. This collector
 * therefore keeps the most recent non-empty assistant text for the turn and
 * emits it at `turn/end`.
 */
export class TurnCollector {
  #onTurnEnd
  #log
  #buffers = new Map()

  /**
   * @param options - completion callback and diagnostics.
   * @param options.onTurnEnd - called with `(sessionId, text)` when a turn ends.
   * @param options.log - sink for collector diagnostics.
   */
  constructor({ onTurnEnd, log }) {
    this.#onTurnEnd = onTurnEnd
    this.#log = log ?? (() => {})
  }

  /**
   * Feed one session event.
   *
   * @param sessionId - the session the event belongs to.
   * @param event - the raw `session/event` payload.
   */
  observe(sessionId, event) {
    const type = event?.type
    if (type === 'assistant/message') {
      const text = extractText(event.data?.message)
      if (text !== '') this.#buffers.set(sessionId, text)
      return
    }
    if (type === 'turn/end') {
      const text = this.#buffers.get(sessionId) ?? ''
      this.#buffers.delete(sessionId)
      if (text === '') return
      try {
        this.#onTurnEnd(sessionId, text, event.data)
      } catch (error) {
        this.#log(`turn completion handler failed: ${String(error?.message ?? error)}`)
      }
    }
  }

  /**
   * Drop buffered text for a session, used when a turn is abandoned.
   *
   * @param sessionId - the session id.
   */
  forget(sessionId) {
    this.#buffers.delete(sessionId)
  }

  /** Buffered sessions, for the console. */
  pending() {
    return [...this.#buffers.keys()]
  }
}

/**
 * Pull the visible text out of an assistant message, ignoring reasoning and
 * tool-call blocks.
 *
 * @param message - a DSH `AssistantMessage`.
 * @returns The concatenated text blocks.
 */
export function extractText(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Wait for a delay.
 *
 * @param ms - milliseconds to wait.
 * @returns A promise resolving after the delay.
 */
/**
 * Whether the platform can render this text as markdown.
 *
 * QQ's markdown covers bold, italics, ordered and unordered lists, quotes,
 * rules and images, but not tables. A table sent as markdown arrives as a row of
 * pipe characters while the plain-text conversion renders it readably, so the
 * presence of a table is what decides between the two encodings.
 *
 * @param text - the prepared chunk.
 * @returns Whether markdown is the better encoding for this text.
 */
export function canRenderAsMarkdown(text) {
  // Split without a regex escape: this line has been mangled twice by a shell or
  // Python layer eating the backslash, and char codes cannot be eaten.
  const lines = String(text ?? '').split(String.fromCharCode(10)).map((line) => line.replace(String.fromCharCode(13), ''))
  for (let index = 0; index + 1 < lines.length; index += 1) {
    const row = lines[index].trim()
    const next = lines[index + 1].trim()
    // A delimiter row is only a delimiter row UNDER a row of cells, and it must
    // itself carry a pipe. Matching it on its own made `---` - an ordinary
    // horizontal rule - look like a table, so every report containing a rule was
    // classified as a table and converted to plain text: the markdown path this
    // rule exists to select was never taken.
    if (!row.includes('|') || !next.includes('|')) continue
    if (/^\|?[\s:|-]*-[\s:|-]*-[\s:|-]*\|?$/.test(next)) return false
  }
  return true
}

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}
