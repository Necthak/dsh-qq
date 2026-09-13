/**
 * Durable mapping between a QQ conversation and a DSH session.
 *
 * One QQ conversation (a private chat with one person, or one group) owns
 * exactly one DSH session for its whole life, so the agent keeps context across
 * separate QQ messages. The mapping is the only thing that must survive a DSH
 * restart, so it is the only thing persisted.
 *
 * The same record also carries the *reply cursor*: the inbound message id the
 * next answer should attach to, and how many replies that id has already
 * carried. Both are required by the platform — `msg_id` makes a reply passive
 * (and therefore exempt from the active-message quota), and `msg_seq` must
 * increase per reply because a repeated pair is rejected outright.
 *
 * @module dsh-qq/bridge/sessions
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

/** Build the storage key for one QQ conversation. */
export function conversationKey(kind, peerId) {
  return `${kind}:${peerId}`
}

/**
 * Take a conversation key apart.
 *
 * @param key - a {@link conversationKey}.
 * @returns The kind and peer id, or null when the key is malformed.
 */
export function splitConversationKey(key) {
  if (typeof key !== 'string') return null
  const at = key.indexOf(':')
  if (at <= 0) return null
  const kind = key.slice(0, at)
  const peerId = key.slice(at + 1)
  if (kind !== 'private' && kind !== 'group') return null
  if (peerId === '') return null
  return { kind, peerId }
}

/**
 * The persisted conversation table.
 */
export class SessionMap {
  #path
  #log
  #records = new Map()
  #dirty = false

  /**
   * @param options - storage location and diagnostics.
   * @param options.path - JSON file holding the table.
   * @param options.log - sink for persistence diagnostics.
   */
  constructor({ path, log }) {
    this.#path = path
    this.#log = log ?? (() => {})
    this.#load()
  }

  /** Number of tracked conversations. */
  get size() {
    return this.#records.size
  }

  /**
   * Read the DSH session bound to a conversation.
   *
   * @param key - a {@link conversationKey}.
   * @returns The record, or undefined when the conversation is new.
   */
  get(key) {
    return this.#records.get(key)
  }

  /**
   * Bind a conversation to a DSH session, creating the record when absent.
   *
   * @param key - a {@link conversationKey}.
   * @param sessionId - the DSH session id.
   * @returns The stored record.
   */
  bind(key, sessionId) {
    const existing = this.#records.get(key)
    if (existing !== undefined) {
      existing.sessionId = sessionId
      existing.updatedAt = Date.now()
      this.#dirty = true
      return existing
    }
    const record = {
      sessionId,
      replyToMessageId: '',
      replyTargetKind: 'message',
      replySeq: 0,
      replyTargetAt: 0,
      lastUserId: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.#records.set(key, record)
    this.#dirty = true
    this.#save()
    return record
  }

  /**
   * Reverse lookup used to decide whether an agent event belongs to QQ.
   *
   * @param sessionId - a DSH session id.
   * @returns The conversation key, or undefined.
   */
  keyForSession(sessionId) {
    for (const [key, record] of this.#records) {
      if (record.sessionId === sessionId) return key
    }
    return undefined
  }

  /**
   * Record the inbound message an answer should attach to, resetting the reply
   * ordinal because `msg_seq` is scoped to one `msg_id`.
   *
   * The target is typed because the platform has two passive targets and they
   * are not interchangeable: an inbound *message* is answered with `msg_id`,
   * while an event (a button click in particular) is answered with `event_id`.
   * Sending an event id as a `msg_id` is refused with
   * `40034024 请求参数msg_id无效或越权`, and because the cursor is shared with
   * the turn's own output, the refusal used to take the conversation's normal
   * replies down with it.
   *
   * @param key - a {@link conversationKey}.
   * @param messageId - the inbound QQ message id, or an event id.
   * @param kind - `'message'` (default) or `'event'`.
   * @param userId - the admitted sender's OpenID, remembered so the agent's own
   *   sends can be judged by the same rule that let the message in.
   */
  setReplyTarget(key, messageId, kind = 'message', userId = '') {
    const record = this.#records.get(key)
    if (record === undefined) return
    record.replyToMessageId = messageId
    record.replyTargetKind = kind === 'event' ? 'event' : 'message'
    record.replySeq = 0
    // Only ever overwritten by a real identity. A later call carrying none — a
    // button click, say — must not erase the sender that opened the
    // conversation, or the outbound checks would start refusing its own target.
    if (typeof userId === 'string' && userId !== '') record.lastUserId = userId
    // The platform expires a passive target by wall-clock time, not by how
    // many replies it carried, so the moment it was armed has to be recorded:
    // it is the only way to know the window has closed without asking the
    // platform and being told no.
    record.replyTargetAt = Date.now()
    record.updatedAt = Date.now()
    this.#dirty = true
    this.#save()
  }

  /**
   * Forget the passive reply target without dropping the session binding.
   *
   * Used when the platform rejects a reply as expired: the target is dead, but
   * the conversation still belongs to the same session.
   *
   * @param key - a {@link conversationKey}.
   */
  clearReplyTarget(key) {
    const record = this.#records.get(key)
    if (record === undefined) return
    record.replyToMessageId = ''
    record.replyTargetKind = 'message'
    record.replySeq = 0
    record.replyTargetAt = 0
    record.updatedAt = Date.now()
    this.#dirty = true
    this.#save()
  }

  /**
   * Take the next passive-reply slot for a conversation.
   *
   * @param key - a {@link conversationKey}.
   * @param maxReplies - the platform's per-message reply allowance.
   * @param windowMs - how long the platform keeps the target valid; a target
   *   older than this is refused outright, so it must not be attempted.
   * @returns The target to send with — `{ msgId, msgSeq }` for a message,
   *   `{ eventId }` for an event — or null when the window is exhausted and the
   *   caller must fall back to an active message.
   */
  takeReplySlot(key, maxReplies, windowMs) {
    const record = this.#records.get(key)
    if (record === undefined || record.replyToMessageId === '') return null
    if (record.replySeq >= maxReplies) return null
    if (Number.isSafeInteger(windowMs) && windowMs > 0) {
      const armedAt = Number.isSafeInteger(record.replyTargetAt) && record.replyTargetAt > 0 ? record.replyTargetAt : 0
      if (armedAt === 0 || Date.now() - armedAt > windowMs) return null
    }
    record.replySeq += 1
    record.updatedAt = Date.now()
    this.#dirty = true
    this.#save()
    // Records written before the target was typed carry no `replyTargetKind`;
    // they are message targets, which is what the old code always assumed.
    return record.replyTargetKind === 'event'
      ? { eventId: record.replyToMessageId }
      : { msgId: record.replyToMessageId, msgSeq: record.replySeq }
  }

  /**
   * Forget a conversation so the next message starts a fresh DSH session.
   *
   * @param key - a {@link conversationKey}.
   * @returns Whether a record existed.
   */
  reset(key) {
    const existed = this.#records.delete(key)
    if (existed) {
      this.#dirty = true
      this.#save()
    }
    return existed
  }

  /** Every tracked conversation, for the console. */
  entries() {
    return [...this.#records].map(([key, record]) => ({ key, ...record }))
  }

  /** Flush pending writes. */
  flush() {
    this.#save()
  }

  /** Read the table from disk, tolerating absence and corruption. */
  #load() {
    try {
      const raw = readFileSync(this.#path, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object') return
      for (const [key, record] of Object.entries(parsed)) {
        if (record === null || typeof record !== 'object') continue
        if (typeof record.sessionId !== 'string' || record.sessionId === '') continue
        // Known fields are normalized, UNKNOWN FIELDS ARE KEPT. Writing the
        // whole record but restoring only a fixed list is how a new field
        // silently disappears on the next restart — and the write that follows
        // erases it from disk too. `replyTargetKind` and `lastUserId` were both
        // lost that way before this spread existed.
        this.#records.set(key, {
          ...record,
          sessionId: record.sessionId,
          replyToMessageId: typeof record.replyToMessageId === 'string' ? record.replyToMessageId : '',
          replyTargetKind: record.replyTargetKind === 'event' ? 'event' : 'message',
          replySeq: Number.isSafeInteger(record.replySeq) ? record.replySeq : 0,
          replyTargetAt: Number.isSafeInteger(record.replyTargetAt) ? record.replyTargetAt : 0,
          lastUserId: typeof record.lastUserId === 'string' ? record.lastUserId : '',
          createdAt: Number.isSafeInteger(record.createdAt) ? record.createdAt : Date.now(),
          updatedAt: Number.isSafeInteger(record.updatedAt) ? record.updatedAt : Date.now(),
        })
      }
      this.#log(`restored ${this.#records.size} QQ conversation mapping(s)`)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#log(`conversation table could not be read (${String(error?.message ?? error)}); starting empty`)
      }
    }
  }

  /**
   * Write the table atomically, so a crash mid-write cannot leave a truncated
   * file that would silently drop every conversation mapping.
   */
  #save() {
    if (!this.#dirty) return
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      const payload = {}
      for (const [key, record] of this.#records) payload[key] = record
      const temp = `${this.#path}.tmp`
      writeFileSync(temp, JSON.stringify(payload, null, 2), 'utf8')
      renameSync(temp, this.#path)
      this.#dirty = false
    } catch (error) {
      this.#log(`conversation table could not be written: ${String(error?.message ?? error)}`)
    }
  }
}
