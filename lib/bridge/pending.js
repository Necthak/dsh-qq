/**
 * Pending-interaction registry: the mechanism that lets a QQ reply answer a
 * question the agent asked.
 *
 * When the agent requests approval or asks a question, the bridge forwards the
 * prompt to QQ and then must interpret the *next* message from that
 * conversation as the answer rather than as a fresh instruction. That requires
 * a per-conversation slot holding the open interaction, which is what this
 * registry is.
 *
 * Two behaviours are deliberate:
 *
 * - A message that does not parse as an answer does NOT resolve the
 *   interaction. It re-prompts instead, so a user who types something unrelated
 *   cannot accidentally drop an approval on the floor.
 * - The interaction expires. An unanswered approval must not block a turn
 *   forever, and on expiry the caller delegates downstream so the desktop UI can
 *   still decide.
 *
 * @module dsh-qq/bridge/pending
 */

/** Interaction kinds, used for logging and prompt wording. */
export const PENDING_KIND = {
  approval: 'approval',
  question: 'question',
}

/**
 * One open interaction per conversation.
 */
export class PendingInteractions {
  #log
  #byKey = new Map()

  /**
   * @param options - diagnostics.
   * @param options.log - sink for interaction diagnostics.
   */
  constructor({ log }) {
    this.#log = log ?? (() => {})
  }

  /** Number of open interactions. */
  get size() {
    return this.#byKey.size
  }

  /**
   * Open an interaction for one conversation.
   *
   * @param key - the conversation key.
   * @param options - interaction shape.
   * @param options.kind - a {@link PENDING_KIND} value.
   * @param options.timeoutMs - how long to wait before giving up.
   * @param options.parse - maps user text to a decision; returns undefined when
   *   the text is not a usable answer.
   * @param options.onReprompt - called when a message did not parse, so the
   *   caller can restate the expected replies.
   * @returns A promise resolving to the parsed decision, or undefined on expiry.
   */
  open(key, { kind, timeoutMs, parse, onReprompt }) {
    this.close(key)
    return new Promise((resolve) => {
      const entry = {
        kind,
        parse,
        onReprompt,
        startedAt: Date.now(),
        timer: null,
        resolve,
      }
      entry.timer = setTimeout(() => {
        this.#byKey.delete(key)
        this.#log(`${key}: ${kind} interaction expired after ${timeoutMs}ms without an answer`)
        resolve(undefined)
      }, timeoutMs)
      this.#byKey.set(key, entry)
    })
  }

  /**
   * Offer an inbound message to the open interaction, if any.
   *
   * @param key - the conversation key.
   * @param text - the user's message text.
   * @returns True when the message was consumed by an interaction — either as
   *   an answer or as a re-prompt — so the caller must not forward it onward.
   */
  offer(key, text) {
    const entry = this.#byKey.get(key)
    if (entry === undefined) return false

    const decision = entry.parse(text)
    if (decision === undefined) {
      try {
        entry.onReprompt?.()
      } catch (error) {
        this.#log(`${key}: re-prompt failed: ${String(error?.message ?? error)}`)
      }
      return true
    }

    this.#byKey.delete(key)
    clearTimeout(entry.timer)
    entry.resolve(decision)
    return true
  }

  /**
   * Close an interaction without answering it, e.g. when the plugin unloads.
   *
   * @param key - the conversation key.
   */
  close(key) {
    const entry = this.#byKey.get(key)
    if (entry === undefined) return
    this.#byKey.delete(key)
    clearTimeout(entry.timer)
    entry.resolve(undefined)
  }

  /** Close every interaction. */
  closeAll() {
    for (const key of [...this.#byKey.keys()]) this.close(key)
  }

  /** Open interactions, for the console. */
  entries() {
    return [...this.#byKey].map(([key, entry]) => ({
      key,
      kind: entry.kind,
      waitingMs: Date.now() - entry.startedAt,
    }))
  }
}

/**
 * Interpret a user's reply as an approval decision.
 *
 * Chinese-first because the bridge's audience is a QQ user, with the English
 * forms accepted so an agent persona that answers in English still works.
 *
 * @param text - the user's message.
 * @returns `'allowed-once'`, `'rejected'`, or undefined when not an answer.
 */
export function parseApprovalReply(text) {
  const normalized = String(text ?? '').trim().toLowerCase()
  if (normalized === '') return undefined
  if (/^(通过|允许|同意|可以|批准|好|行|yes|y|ok|allow|approve|approved)$/.test(normalized)) return 'allowed-once'
  if (/^(拒绝|不允许|不同意|不行|否|no|n|deny|reject|rejected)$/.test(normalized)) return 'rejected'
  return undefined
}

/**
 * Interpret a user's reply as an answer to one or more questions.
 *
 * Accepts the option label verbatim, a 1-based option number, or free text. A
 * single-question request is the common case and answers directly; a
 * multi-question request needs one line per question, prefixed by the question
 * number, because QQ has no form UI to key them by.
 *
 * @param questions - the requested questions.
 * @param text - the user's message.
 * @returns An `AskUserQuestionAnswer`-shaped value, or undefined when unusable.
 */
export function parseQuestionReply(questions, text) {
  const raw = String(text ?? '').trim()
  if (raw === '' || !Array.isArray(questions) || questions.length === 0) return undefined
  const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line !== '')

  // A single question consumes the whole reply, so free text is always usable.
  if (questions.length === 1) {
    return { answers: [answerFor(questions[0], raw)] }
  }

  const answers = []
  for (const line of lines) {
    const match = /^(\d+)\s*[.、:：)）]?\s*(.+)$/.exec(line)
    if (match === null) continue
    const index = Number(match[1]) - 1
    if (!Number.isSafeInteger(index) || index < 0 || index >= questions.length) continue
    if (answers.some((answer) => answer.id === questions[index].id)) continue
    answers.push(answerFor(questions[index], match[2]))
  }
  if (answers.length === 0) return undefined
  return { answers }
}

/**
 * Build one structured answer from a user's text.
 *
 * @param question - the question being answered.
 * @param text - the user's text for it.
 * @returns An `AskUserQuestionAnswerItem`.
 */
function answerFor(question, text) {
  const trimmed = text.trim()
  const options = Array.isArray(question?.options) ? question.options : []

  const byNumber = /^(\d+)$/.exec(trimmed)
  if (byNumber !== null) {
    const index = Number(byNumber[1]) - 1
    if (index >= 0 && index < options.length) return { id: question.id, selected: [options[index].label] }
  }

  const byLabel = options.find((option) => option?.label === trimmed)
  if (byLabel !== undefined) return { id: question.id, selected: [byLabel.label] }

  // Unmatched text is the free-form "Other" answer, which the protocol carries
  // in `custom` so the agent can tell it apart from a chosen option.
  return { id: question.id, selected: [], custom: trimmed }
}

/**
 * Render the question set as a QQ-readable prompt.
 *
 * @param questions - the requested questions.
 * @returns The prompt text.
 */
export function formatQuestions(questions) {
  const lines = ['❓ 需要你回答：']
  questions.forEach((question, index) => {
    const prefix = questions.length > 1 ? `${index + 1}. ` : ''
    lines.push(`${prefix}${question.question}`)
    const options = Array.isArray(question.options) ? question.options : []
    options.forEach((option, optionIndex) => {
      const description = option.description === undefined ? '' : ` — ${option.description}`
      lines.push(`   ${optionIndex + 1}) ${option.label}${description}`)
    })
    if (options.length === 0) lines.push('   （直接回复文字即可）')
  })
  if (questions.length > 1) lines.push('请按「序号. 答案」每行一条回复，例如：1. 选项一')
  return lines.join('\n')
}
